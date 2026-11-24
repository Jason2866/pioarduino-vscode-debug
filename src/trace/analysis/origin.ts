// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/analysis/origin.py (Apache-2.0).
//
// Follow a register back through the trace from the trap a fault ends at.
// Walking the events of one core backward from the fault meets the writer of a register whatever function it ran in. A
// load is followed on to the store that wrote its bytes, and the stored value is checked against the loaded one. Untraced
// code, lost trace, a task switch and a trap handler that ran the scheduler end a walk. A trap handler that returned to
// where it was taken and a call to untraced code that returned are crossed by the calling convention.

import { A0, A1, ECALL_LENGTH, GP, MASK32, RA, S_REGS, SP, TP, XLEN_BYTES } from '../decoder/encoding';
import { GapReason } from '../decoder/reconstruct';
import { decodeAt, evaluate, insnText, InsnInfo, LINKS, sources } from '../decoder/semantics';
import { CodeImage } from '../elf/image';
import {
    LinkKind,
    TraceEvent,
    TraceGap,
    TraceInstruction,
    TraceSync,
    TraceTrap,
    TraceWarning,
} from '../ir/events';
import { ECALL_CAUSES, endsHistory, SCHEDULER_FUNCTIONS } from './history';

// Events a window keeps, the fault trap included, which bounds the time and memory of a walk
export const WINDOW_EVENTS = 1 << 15;
// Steps one origin tree records, so that a long chain still reads as a finding
export const MAX_STEPS = 8;
// Writers a value is computed back through
export const MAX_VALUE_DEPTH = 32;
// Events a load is followed back through to the store that wrote its bytes
export const MAX_STORE_EVENTS = 4096;
// Instructions between a bus error and the trap that reports it, as far as the walk looks
export const BUS_ERROR_INSTRUCTIONS = 8;
// Branches of the function the fault is in that the walk returns
export const MAX_BRANCHES = 4;

// Registers a call keeps by the calling convention, gp and tp because nothing allocates them
const CALLEE_SAVED = new Set<number>([SP, GP, TP, ...S_REGS]);
// Pointers the walk does not follow when a value is computed from them
const POINTERS = new Set<number>([SP, GP, TP]);
// Instruction address misaligned, instruction access fault, instruction page fault
const FETCH_CAUSES = new Set([0, 1, 12]);
// Load and store/AMO address misaligned, access fault and page fault
const ACCESS_CAUSES = new Set([4, 5, 6, 7, 13, 15]);
const COPIES = new Set(['c.mv', 'cm.mva01s', 'cm.mvsa01']);
const INDIRECT_JUMPS = new Set(['jalr', 'c.jr', 'c.jalr']);
const POP_RETURNS = new Set(['cm.popret', 'cm.popretz']);
const POPS = new Set(['cm.pop', ...POP_RETURNS]);
const BRANCHES = new Set([
    'beq',
    'bne',
    'blt',
    'bge',
    'bltu',
    'bgeu',
    'c.beqz',
    'c.bnez',
]);
// Instructions that set a register to itself plus a constant
const ADDS = new Set(['addi', 'c.addi', 'c.addi16sp', 'cm.push', 'cm.pop', 'cm.popret', 'cm.popretz']);
// Stores of an integer register, and loads into one, that a value can be followed through
const STORES = new Set(['sw', 'sh', 'sb', 'c.sw', 'c.swsp', 'c.sh', 'c.sb']);
const LOADS = new Set([
    'lw',
    'lh',
    'lhu',
    'lb',
    'lbu',
    'c.lw',
    'c.lwsp',
    'c.lh',
    'c.lhu',
    'c.lbu',
]);
const SIGNED_LOADS = new Set(['lh', 'lb', 'c.lh']);

export type StepKind =
    | 'set' // a constant, from li, lui or auipc
    | 'copied' // by mv or a Zcmp move
    | 'computed' // from other registers
    | 'loaded' // from memory, by a load or a cm.pop form
    | 'linked' // the return address a call wrote
    | 'read' // from a CSR
    | 'written' // by another instruction with no register sources, such as fmv.x.w or sc.w
    | 'pointer' // sp, gp or tp, which a value was computed from and which is not followed
    | 'unknown'; // no writer found, the stop says why

export type StopReason =
    | 'trace_start' // the trace starts before the writer
    | 'window' // the events the walk has start before the writer
    | 'trace_lost'
    | 'untraced' // untraced code ran, and the register is not one a call keeps
    | 'context_switch' // a trap handler returned to another place than where the trap was taken
    // A trap handler ran the scheduler, which can resume another task where the trap was taken
    | 'scheduler'
    | 'syscall' // the handler of an ecall returns its result in a0 and a1
    | 'unsupported' // an instruction whose written registers are not known
    | 'unreadable' // an instruction whose code cannot be read or decoded
    | 'steps'; // the tree has MAX_STEPS steps

export type Crossing =
    | 'interrupt' // an interrupt handler that returned to where it was taken
    | 'exception' // an exception handler that returned to where it was taken
    | 'syscall' // an ecall handler that returned after the ecall
    | 'untraced_call' // a call to untraced code that returned to its call site
    | 'trap_entry' // the value was used in a trap handler and comes from the code it interrupted
    | 'trace_warning' // a TraceWarning
    // The value went through memory, and the stored value is not known to compare with the loaded one
    | 'unchecked_value';

export type Relation =
    | 'callee' // in a function that returned before the value was used
    | 'caller'; // before a call to the function that used the value

/** Where one register got the value an instruction used. Each node of a tree is a distinct object. */
export interface RegisterStep {
    reg: number;
    kind: StepKind;
    value?: number; // the value the using instruction read
    pc?: number; // the instruction that wrote the value
    instruction?: string; // the writer as objdump prints it, or its mnemonic
    use_pc?: number; // the instruction that used the value, the faulting one for the root
    address?: number; // where a load read the value
    store_pc?: number; // the store that wrote the bytes a load read. The stored register is the source
    store_instruction?: string;
    relation?: Relation;
    sources: RegisterStep[]; // steps of the registers the value came from
    crossed: Crossing[]; // in the order the walk met them, from the use back to the writer
    stop?: StopReason; // why an UNKNOWN step has no writer
    stop_pc?: number; // the event the walk stopped at
    detail?: string; // the mnemonic of an unsupported instruction, or the reason of a gap
}

/** Yield this step and every step under it, each before its sources. */
export function* walkSteps(step: RegisterStep): Generator<RegisterStep> {
    yield step;
    for (const source of step.sources) {
        yield* walkSteps(source);
    }
}

export interface BusAccess {
    /** A load or store the trace shows retiring before a bus error, and its position in the events of the window. */
    pc: number;
    instruction: string;
    index: number;
}

export interface StackCall {
    /** A call not returned from at the fault, and sp at the call. */
    pc: number;
    sp: number;
}

export interface BranchOutcome {
    /** The last time a conditional branch ran before the fault, and whether it jumped. */
    pc: number;
    taken: boolean;
}

/** Keeps the last WINDOW_EVENTS events of one core for the walks, up to where HistoryBuilder stops. */
export class FaultWindowBuilder {
    private readonly endInterrupts: ReadonlySet<number>;
    private events: TraceEvent[] = [];
    private head = 0;
    private pushed = 0;
    private fault: TraceTrap | undefined;

    constructor(
        private readonly image: CodeImage | undefined,
        endInterrupts: Iterable<number> = []
    ) {
        this.endInterrupts = new Set(endInterrupts);
    }

    get done(): boolean {
        /** True once the end is pushed. Later events are ignored. */
        return this.fault !== undefined;
    }

    push(event: TraceEvent): void {
        /** Keep `event`. Every event counts against WINDOW_EVENTS, a TraceBoundary too. */
        if (this.fault !== undefined) {
            return;
        }
        this.events.push(event);
        this.pushed++;
        while (this.events.length - this.head > WINDOW_EVENTS) {
            this.head++;
        }
        if (event.event === 'trap' && endsHistory(event, this.endInterrupts)) {
            this.fault = event;
        }
    }

    close(): FaultWindow {
        /** The window over the events kept. Without the end, it keeps none and its queries find nothing. */
        let events: TraceEvent[];
        if (this.fault !== undefined) {
            events = this.events.slice(this.head);
            this.events = this.events.slice(this.head);
            this.head = 0;
        } else {
            events = [];
        }
        return new FaultWindow(this.image, events, this.fault, this.pushed <= WINDOW_EVENTS);
    }
}

/**
 * The events of one core up to and including the fault trap, and the walks over them.
 *
 * `fault` is that trap, or undefined when the trace ended first. `complete` is true when the window starts at the
 * first event of the trace. Each query keeps its caches to itself, so a query that raises leaves the window usable.
 * A BusAccess from busAccess() is valid only with the window that returned it.
 */
export class FaultWindow {
    readonly fault: TraceTrap | undefined;
    readonly complete: boolean;
    private readonly kept: Kept;

    constructor(
        private readonly image: CodeImage | undefined,
        events: TraceEvent[],
        fault: TraceTrap | undefined,
        complete: boolean
    ) {
        this.fault = fault;
        this.complete = complete;
        this.kept = keptOf(events);
    }

    origin(registers: RegisterValues, access?: BusAccess): RegisterStep | undefined {
        /** Where the register the fault depends on got its value, undefined when there is no register to follow. */
        const walk = this.walkFor(registers);
        if (walk === undefined) {
            return undefined;
        }
        const root = walk.run(access === undefined ? undefined : walk.indexOf(access));
        return root === undefined ? undefined : root.freeze();
    }

    busAccess(registers: RegisterValues, address: number, store: boolean): BusAccess | undefined {
        /** The last load, or store when `store`, to `address` in the instructions that ran straight to the trap. */
        const walk = this.walkFor(registers);
        return walk === undefined ? undefined : walk.busAccess(address, store);
    }

    stackCalls(registers: RegisterValues): StackCall[] {
        /** The calls not returned from at the fault, newest first, with sp worked back from `registers`. */
        const walk = this.walkFor(registers);
        return walk === undefined ? [] : walk.stackCalls().map(([pc, sp]) => ({ pc, sp }));
    }

    branches(inside: (pc: number) => boolean): BranchOutcome[] {
        /** The latest outcome of each of the most recent branches of the function the fault is in, oldest first.

        The walk stops at the call that entered the function, so the branches of its callers are not included.
        */
        const walk = this.walkFor(new Map());
        return walk === undefined ? [] : walk.branches(inside).map(([pc, taken]) => ({ pc, taken }));
    }

    unsureWrites(trapped: number, saved: number): ReadonlySet<number> | undefined {
        /** The registers written from `trapped` up to `saved`, the mepc a bus error trap at `trapped` saved.

        Undefined when `saved` is not on an instruction boundary within BUS_ERROR_INSTRUCTIONS instructions of
        `trapped`, or when that code is unreadable or unsupported.
        */
        if (this.fault === undefined) {
            return undefined;
        }
        const written = new Set<number>();
        let pc = trapped;
        for (let i = 0; i < BUS_ERROR_INSTRUCTIONS; i++) {
            const info = decodeAt(this.image, pc);
            if (info === undefined || !info.supported) {
                return undefined;
            }
            for (const reg of info.writes) {
                written.add(reg);
            }
            pc += info.size;
            if (saved < pc) {
                return saved <= trapped ? written : undefined;
            }
            if (saved === pc) {
                return written;
            }
        }
        return undefined;
    }

    private walkFor(registers: RegisterValues): Walk | undefined {
        return Walk.over(this.kept, this.image, registers, this.complete);
    }
}

type RegisterValues = ReadonlyMap<number, number> | Record<number, number>;

function toRegisterMap(registers: RegisterValues): Map<number, number> {
    return registers instanceof Map ? new Map(registers) : new Map(Object.entries(registers).map(([k, v]) => [Number(k), v]));
}

/** A RegisterStep while the walk builds it. */
class Step {
    readonly sources: Step[] = [];
    readonly crossed: Crossing[] = [];

    constructor(
        public readonly reg: number,
        public kind: StepKind,
        public value?: number,
        public pc?: number,
        public use_pc?: number,
        public text?: string,
        public address?: number,
        public store_pc?: number,
        public store_text?: string,
        public relation?: Relation,
        public stop?: StopReason,
        public stop_pc?: number,
        public detail?: string
    ) {}

    freeze(): RegisterStep {
        return {
            reg: this.reg,
            kind: this.kind,
            value: this.value,
            pc: this.pc,
            instruction: this.text,
            use_pc: this.use_pc,
            address: this.address,
            store_pc: this.store_pc,
            store_instruction: this.store_text,
            relation: this.relation,
            sources: this.sources.map((source) => source.freeze()),
            crossed: [...this.crossed],
            stop: this.stop,
            stop_pc: this.stop_pc,
            detail: this.detail,
        };
    }
}

interface Scan {
    /** What a scan back from one event found for one register. */
    writer: number | undefined; // index of the instruction that wrote the register
    end: number; // index the scan ended at, which is the writer, the event it stopped at, or -1
    depth: number; // call depth of the writer relative to the use
    crossed: Crossing[];
    stop?: StopReason;
    stop_pc?: number;
    detail?: string;
}

function makeScan(
    writer: number | undefined,
    end: number,
    depth: number,
    crossed: Crossing[],
    stop?: StopReason,
    stopPc?: number,
    detail?: string
): Scan {
    return { writer, end, depth, crossed, stop, stop_pc: stopPc, detail };
}

/** The events a walk reads, which are those given without boundaries. */
interface Kept {
    events: TraceEvent[];
    positions: number[]; // positions[i] is where events[i] is in the events given
}

function keptOf(events: TraceEvent[]): Kept {
    const positions: number[] = [];
    const kept: TraceEvent[] = [];
    events.forEach((event, i) => {
        if (event.event !== 'boundary') {
            positions.push(i);
            kept.push(event);
        }
    });
    return { events: kept, positions };
}

type TrapSpan = [number, Crossing] | StopReason;

/** The events up to the fault trap without boundaries, with caches for one query. */
class Walk {
    readonly positions: number[];
    readonly events: TraceEvent[];
    readonly image: CodeImage | undefined;
    readonly frame: Map<number, number>;
    readonly complete: boolean;
    private readonly symbols = new Map<number, string | undefined>();
    private readonly trapSpans = new Map<number, TrapSpan>();
    private readonly fault: number;
    private steps = 0;
    private readonly infos = new Map<number, InsnInfo | undefined>();
    private readonly scans = new Map<string, Scan>();
    // The value of each (register, index), and the depth it was looked up at
    private readonly values = new Map<string, { value: number | undefined; depth: number }>();
    private spans: Array<[number, number]> | undefined;
    private ends: Map<number, number> | undefined;

    private constructor(kept: Kept, image: CodeImage | undefined, registers: RegisterValues, complete: boolean) {
        this.positions = kept.positions;
        this.events = kept.events;
        this.image = image;
        this.frame = toRegisterMap(registers);
        this.complete = complete;
        this.fault = this.events.length - 1;
    }

    static over(
        kept: Kept,
        image: CodeImage | undefined,
        registers: RegisterValues,
        complete: boolean
    ): Walk | undefined {
        /** A walk of the events kept, or undefined when they do not end with a trap. */
        if (kept.events.length === 0 || kept.events[kept.events.length - 1].event !== 'trap') {
            return undefined;
        }
        return new Walk(kept, image, registers, complete);
    }

    indexOf(access: BusAccess): number {
        const i = bisectLeft(this.positions, access.index);
        const event = i < this.positions.length && this.positions[i] === access.index ? this.events[i] : undefined;
        if (event === undefined || event.event !== 'instruction' || event.pc !== access.pc) {
            throw new Error(`event ${access.index} of these events is not the access at 0x${access.pc.toString(16).padStart(8, '0')}`);
        }
        return i;
    }

    run(access: number | undefined): Step | undefined {
        const target = access === undefined ? this.target() : this.accessTarget(access);
        if (target === undefined) {
            return undefined;
        }
        const [reg, use, usePc] = target;
        return this.step(reg, use, usePc);
    }

    private accessTarget(access: number): [number, number, number] | undefined {
        /** The base register of the load or store at index access. */
        const insn = this.events[access] as TraceInstruction;
        const info = this.info(insn);
        if (info === undefined || info.mem === undefined || !info.mem.base) {
            return undefined;
        }
        return [info.mem.base, access, insn.pc];
    }

    busAccess(address: number, store: boolean): BusAccess | undefined {
        let seen = 0;
        for (let i = this.fault - 1; i >= 0; i--) {
            const event = this.events[i];
            if (event.event === 'sync') {
                continue;
            }
            if (event.event !== 'instruction' || seen === BUS_ERROR_INSTRUCTIONS) {
                return undefined;
            }
            seen++;
            const info = this.info(event);
            if (info === undefined || !info.supported) {
                return undefined;
            }
            const mem = info.mem;
            if (mem === undefined || mem.is_store !== store) {
                continue;
            }
            const base = this.value(mem.base, i);
            if (base !== undefined && u32(base + mem.offset) === u32(address)) {
                return { pc: event.pc, instruction: insnText(info, event.pc) || info.mnemonic, index: this.positions[i] };
            }
        }
        return undefined;
    }

    private target(): [number, number, number] | undefined {
        /** The register the fault depends on, the event that used it, and its pc. */
        const fault = this.events[this.fault] as TraceTrap;
        if (fault.interrupt || fault.epc === undefined) {
            return undefined;
        }
        if (ACCESS_CAUSES.has(fault.cause)) {
            const info = decodeAt(this.image, fault.epc);
            // x0 needs no walk because it reads as zero
            if (info === undefined || info.mem === undefined || !info.mem.base) {
                return undefined;
            }
            return [info.mem.base, this.fault, fault.epc];
        }
        if (FETCH_CAUSES.has(fault.cause) && this.fault > 0) {
            const jump = this.events[this.fault - 1];
            if (jump.event !== 'instruction' || jump.next_pc !== fault.epc) {
                return undefined;
            }
            const info = this.info(jump);
            if (info === undefined || !info.supported) {
                return undefined;
            }
            if (INDIRECT_JUMPS.has(info.mnemonic) && info.rs1) {
                return [info.rs1, this.fault - 1, jump.pc];
            }
            // cm.popret loads ra and jumps through it, so it is the writer
            if (POP_RETURNS.has(info.mnemonic)) {
                return [RA, this.fault, jump.pc];
            }
        }
        return undefined;
    }

    *back(): Generator<[number, TraceInstruction]> {
        /** The instructions of the code the fault is in, newest first, over handlers and calls that returned. */
        let i = this.fault - 1;
        while (i >= 0) {
            const event = this.events[i];
            if (event.event === 'instruction') {
                if (event.link === LinkKind.TRAP_RETURN) {
                    const span = this.trapSpan(i);
                    if (typeof span === 'string') {
                        return;
                    }
                    i = span[0] - 1;
                    continue;
                }
                yield [i, event];
            } else if (event.event === 'trap') {
                // The fault is in a trap handler, which can run on another stack
                return;
            } else if (event.event === 'gap') {
                if (lost(event) || this.untracedCall(i) === undefined) {
                    return;
                }
                // Skip the untraced code and the call into it
                i -= 2;
                continue;
            }
            i--;
        }
    }

    stackCalls(): Array<[number, number]> {
        let sp = this.frame.get(SP);
        const calls: Array<[number, number]> = [];
        if (sp === undefined) {
            return calls;
        }
        // Returns seen walking back whose call is not reached yet
        let returned = 0;
        for (const [, insn] of this.back()) {
            const info = this.info(insn);
            if (info === undefined || !info.supported) {
                break;
            }
            if (info.writes.has(SP)) {
                const needed = sources(info, SP);
                const adds =
                    ADDS.has(info.mnemonic) && needed !== undefined && needed.size === 1 && needed.has(SP);
                const delta = adds ? evaluate(info, SP, insn.pc, { [SP]: 0 }) : undefined;
                if (delta === undefined) {
                    break;
                }
                sp = u32(sp - delta);
            }
            if (insn.link === LinkKind.RETURN) {
                returned++;
            } else if (insn.link === LinkKind.CALL) {
                if (returned) {
                    returned--;
                } else {
                    calls.push([insn.pc, sp]);
                }
            }
        }
        return calls;
    }

    branches(inside: (pc: number) => boolean): Array<[number, boolean]> {
        // The last outcome by pc, newest first
        const found = new Map<number, boolean>();
        let returned = 0;
        for (const [i, insn] of this.back()) {
            if (found.size === MAX_BRANCHES) {
                break;
            }
            if (insn.link === LinkKind.RETURN) {
                returned++;
            } else if (returned) {
                if (insn.link === LinkKind.CALL) {
                    returned--;
                }
            } else if (!inside(insn.pc) || insn.link === LinkKind.CALL) {
                break;
            } else if (!found.has(insn.pc)) {
                const taken = this.taken(i);
                if (taken !== undefined) {
                    found.set(insn.pc, taken);
                }
            }
        }
        return [...found.entries()].reverse();
    }

    private taken(index: number): boolean | undefined {
        /** Whether the conditional branch at index jumped. Undefined for another instruction. */
        const insn = this.events[index] as TraceInstruction;
        const info = this.info(insn);
        if (info === undefined || !BRANCHES.has(info.mnemonic)) {
            return undefined;
        }
        // A branch to its own fall-through moves on to the same pc either way
        if (insn.branch_taken !== undefined) {
            return insn.branch_taken;
        }
        let nextPc = insn.next_pc;
        const after = this.events[index + 1];
        if (nextPc === undefined && after !== undefined && after.event === 'instruction') {
            nextPc = after.pc;
        }
        if (nextPc === undefined) {
            return undefined;
        }
        return nextPc !== u32(insn.pc + insn.length);
    }

    private info(insn: TraceInstruction): InsnInfo | undefined {
        if (!this.infos.has(insn.pc)) {
            this.infos.set(insn.pc, decodeAt(this.image, insn.pc));
        }
        return this.infos.get(insn.pc);
    }

    private runsScheduler(pc: number | undefined): boolean {
        /** Whether a call to pc switches tasks. */
        if (pc === undefined) {
            return false;
        }
        if (!this.symbols.has(pc)) {
            this.symbols.set(pc, this.image === undefined ? undefined : this.image.symbolAt(pc));
        }
        const name = this.symbols.get(pc);
        return name !== undefined && SCHEDULER_FUNCTIONS.has(name);
    }

    step(reg: number, use: number, usePc: number | undefined): Step {
        /** Where reg, as the event at index use read it, got its value. */
        const value = this.value(reg, use);
        if (this.steps >= MAX_STEPS) {
            return new Step(
                reg,
                'unknown',
                value,
                undefined,
                usePc,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'steps'
            );
        }
        this.steps++;
        const scan = this.scan(reg, use);
        if (scan.writer === undefined) {
            return new Step(
                reg,
                'unknown',
                value,
                undefined,
                usePc,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                scan.stop,
                scan.stop_pc,
                scan.detail
            );
        }
        const writer = this.events[scan.writer] as TraceInstruction;
        const info = this.info(writer);
        if (info === undefined) {
            throw new Error('unreachable: scan writer without info');
        }
        const step = new Step(
            reg,
            'unknown',
            value,
            writer.pc,
            usePc,
            insnText(info, writer.pc) || info.mnemonic,
            undefined,
            undefined,
            undefined,
            scan.depth > 0 ? 'callee' : scan.depth < 0 ? 'caller' : undefined
        );
        step.crossed.push(...scan.crossed);
        const needed = sources(info, reg);
        if (LINKS.has(info.mnemonic)) {
            step.kind = 'linked';
        } else if (needed === undefined) {
            if (info.loaded.has(reg)) {
                step.kind = 'loaded';
            } else {
                step.kind = info.csr !== undefined ? 'read' : 'written';
            }
            if (step.kind === 'loaded') {
                const slot = this.loadedFrom(info, reg, scan.writer);
                if (slot !== undefined) {
                    const [address, width] = slot;
                    step.address = address;
                    if (LOADS.has(info.mnemonic) || POPS.has(info.mnemonic)) {
                        this.followStore(step, width, SIGNED_LOADS.has(info.mnemonic), scan.writer);
                    }
                }
            }
        } else if (needed.size === 0) {
            step.kind = 'set';
        } else {
            step.kind = isCopy(info) ? 'copied' : 'computed';
            for (const source of [...needed].sort((a, b) => a - b)) {
                if (POINTERS.has(source)) {
                    step.sources.push(
                        new Step(source, 'pointer', this.value(source, scan.writer), undefined, writer.pc)
                    );
                } else {
                    step.sources.push(this.step(source, scan.writer, writer.pc));
                }
            }
        }
        return step;
    }

    private loadedFrom(info: InsnInfo, reg: number, index: number): [number, number] | undefined {
        /** The address and width the instruction at index loaded reg from, when the trace shows them. */
        if (POPS.has(info.mnemonic)) {
            const sp = this.value(SP, index);
            if (sp === undefined || info.imm === undefined) {
                return undefined;
            }
            // cm.push left the highest register at the new sp - 4 and ra lowest
            const saved = [...info.loaded].sort((a, b) => a - b);
            const slot = saved.indexOf(reg);
            return [u32(sp + info.imm - XLEN_BYTES * (saved.length - slot)), XLEN_BYTES];
        }
        if (info.mem === undefined) {
            return undefined;
        }
        const base = this.value(info.mem.base, index);
        if (base === undefined) {
            return undefined;
        }
        return [u32(base + info.mem.offset), info.mem.width];
    }

    private followStore(step: Step, width: number, signed: boolean, index: number): void {
        /** Go on from the load at index to the store that wrote its bytes, when it stored the value loaded. */
        if (step.address === undefined) {
            return;
        }
        const found = this.findStore(step.address, width, index);
        if (found === undefined) {
            return;
        }
        const [storeIndex, reg, crossed] = found;
        const stored = this.value(reg, storeIndex);
        if (stored === undefined || step.value === undefined) {
            crossed.push('unchecked_value');
        } else if (asLoaded(stored, width, signed) !== step.value) {
            return;
        }
        const store = this.events[storeIndex] as TraceInstruction;
        const info = this.info(store);
        if (info === undefined) {
            return;
        }
        step.store_pc = store.pc;
        step.store_text = insnText(info, store.pc) || info.mnemonic;
        for (const item of crossed) {
            addCrossing(step.crossed, item);
        }
        // sw zero stores a constant, which the store's text already says
        if (POINTERS.has(reg)) {
            step.sources.push(new Step(reg, 'pointer', stored, undefined, store.pc));
        } else if (reg !== 0) {
            step.sources.push(this.step(reg, storeIndex, store.pc));
        }
    }

    private findStore(address: number, width: number, load: number): [number, number, Crossing[]] | undefined {
        /** The last store before the load at index load to these bytes, its register and the crossings in between. */
        const crossed: Crossing[] = [];
        const end = address + width;
        let i = load - 1;
        while (i >= 0 && load - i <= MAX_STORE_EVENTS) {
            const event = this.events[i];
            if (event.event === 'instruction') {
                const info = this.info(event);
                if (info === undefined || !info.supported) {
                    return undefined;
                }
                for (const [start, size, reg] of this.stores(info, i)) {
                    if (start === undefined) {
                        return undefined;
                    }
                    if (start < end && address < start + size) {
                        if (start === address && size === width && reg !== undefined) {
                            return [i, reg, crossed];
                        }
                        return undefined;
                    }
                }
            } else if (event.event === 'trap') {
                if (event.interrupt) {
                    addCrossing(crossed, 'interrupt');
                } else if (ECALL_CAUSES.has(event.cause)) {
                    addCrossing(crossed, 'syscall');
                } else {
                    addCrossing(crossed, 'exception');
                }
            } else if (event.event === 'gap') {
                return undefined;
            } else if (event.event === 'warning') {
                addCrossing(crossed, 'trace_warning');
            }
            i--;
        }
        return undefined;
    }

    private stores(info: InsnInfo, index: number): Array<[number | undefined, number, number | undefined]> {
        /** The memory the instruction at index writes as (address, width, register stored), with undefined where unknown. */
        if (info.mnemonic === 'cm.push') {
            const sp = this.value(SP, index);
            if (sp === undefined) {
                return [[undefined, 0, undefined]];
            }
            // The highest register goes to sp - 4 and ra lowest, as the Zcmp spec lists it
            const saved = [...info.reads].filter((r) => r !== SP).sort((a, b) => a - b);
            return saved.map((reg, n) => [
                u32(sp - XLEN_BYTES * (saved.length - n)),
                XLEN_BYTES,
                reg,
            ]);
        }
        const mem = info.mem;
        if (mem === undefined || !mem.is_store) {
            return [];
        }
        const base = this.value(mem.base, index);
        if (base === undefined) {
            return [[undefined, 0, undefined]];
        }
        return [[u32(base + mem.offset), mem.width, STORES.has(info.mnemonic) ? info.rs2 : undefined]];
    }

    private scan(reg: number, use: number): Scan {
        const key = `${reg}:${use}`;
        let result = this.scans.get(key);
        if (result === undefined) {
            result = this.scanBack(reg, use);
            this.scans.set(key, result);
        }
        return result;
    }

    private scanBack(reg: number, use: number): Scan {
        /** The last instruction before the event at index use that wrote reg. */
        let depth = 0;
        const crossed: Crossing[] = [];

        const stop = (
            i: number,
            why: StopReason,
            pc?: number,
            detail?: string
        ): Scan => makeScan(undefined, i, depth, [...crossed], why, pc, detail);

        let i = use - 1;
        while (i >= 0) {
            const event = this.events[i];
            if (event.event === 'instruction') {
                if (event.link === LinkKind.TRAP_RETURN) {
                    const span = this.trapSpan(i);
                    if (typeof span === 'string') {
                        const switched = span === 'context_switch' || span === 'scheduler';
                        return stop(i, span, switched ? event.next_pc : undefined);
                    }
                    const [entry, kind] = span;
                    if (kind === 'syscall' && (reg === A0 || reg === A1)) {
                        const trap = this.events[entry] as TraceTrap;
                        return stop(i, 'syscall', trap.epc);
                    }
                    addCrossing(crossed, kind);
                    i = entry - 1;
                    continue;
                }
                const info = this.info(event);
                if (info === undefined) {
                    return stop(i, 'unreadable', event.pc);
                }
                if (!info.supported) {
                    const name =
                        info.mnemonic !== 'unknown'
                            ? info.mnemonic
                            : `0x${info.insn.toString(16).padStart(2 * info.size, '0')}`;
                    return stop(i, 'unsupported', event.pc, name);
                }
                // a return that writes the register, like cm.popretz, wrote it in the callee
                if (event.link === LinkKind.RETURN) {
                    depth++;
                } else if (event.link === LinkKind.CALL) {
                    depth--;
                }
                if (info.writes.has(reg)) {
                    return makeScan(i, i, depth, [...crossed]);
                }
            } else if (event.event === 'trap') {
                // the use is in a trap handler, which found the register as the interrupted code left it
                addCrossing(crossed, 'trap_entry');
            } else if (event.event === 'gap') {
                if (lost(event)) {
                    return stop(i, 'trace_lost', undefined, event.reason);
                }
                const call = this.untracedCall(i);
                if (call === undefined || !CALLEE_SAVED.has(reg)) {
                    const left = i > 0 ? this.events[i - 1] : undefined;
                    return stop(
                        i,
                        'untraced',
                        left !== undefined && left.event === 'instruction' ? left.pc : undefined
                    );
                }
                addCrossing(crossed, 'untraced_call');
                // the call wrote only ra, which is not callee-saved
                i -= 2;
                continue;
            } else if (event.event === 'warning') {
                addCrossing(crossed, 'trace_warning');
            }
            i--;
        }
        return stop(-1, this.complete ? 'trace_start' : 'window');
    }

    private trapSpan(trapReturn: number): TrapSpan {
        /** The trap the trap return at index trap_return ends and its crossing, or why the handler did not resume. */
        let span = this.trapSpans.get(trapReturn);
        if (span === undefined) {
            span = this.trapSpanBack(trapReturn);
            this.trapSpans.set(trapReturn, span);
        }
        return span;
    }

    private trapSpanBack(trapReturn: number): TrapSpan {
        const entry = this.trapEntry(trapReturn);
        if (typeof entry === 'string') {
            return entry;
        }
        const trap = this.events[entry] as TraceTrap;
        const mret = this.events[trapReturn] as TraceInstruction;
        let kind: Crossing;
        if (mret.next_pc === trap.epc) {
            kind = trap.interrupt ? 'interrupt' : 'exception';
        } else if (
            !trap.interrupt &&
            ECALL_CAUSES.has(trap.cause) &&
            trap.epc !== undefined &&
            mret.next_pc === trap.epc + ECALL_LENGTH
        ) {
            kind = 'syscall';
        } else {
            return 'context_switch';
        }
        // Tasks that yield through the same code are preempted at the same instruction, so returning there shows nothing
        for (let i = entry + 1; i < trapReturn; i++) {
            const e = this.events[i];
            if (e.event === 'instruction' && e.link === LinkKind.CALL && this.runsScheduler(e.next_pc)) {
                return 'scheduler';
            }
        }
        return [entry, kind];
    }

    private skipped(): Array<[number, number]> {
        /** The (trap, trap return) indexes of the handlers a walk back from the fault steps over. */
        if (this.spans === undefined) {
            this.spans = [];
            let i = this.fault - 1;
            while (i >= 0) {
                const event = this.events[i];
                if (event.event === 'instruction' && event.link === LinkKind.TRAP_RETURN) {
                    const span = this.trapSpan(i);
                    if (typeof span === 'string') {
                        break;
                    }
                    this.spans.push([span[0], i]);
                    i = span[0] - 1;
                    continue;
                }
                if (event.event === 'gap' && lost(event)) {
                    break;
                }
                i--;
            }
        }
        return this.spans;
    }

    private onPath(index: number): boolean {
        /** Whether the event at index ran outside the handlers a walk back from the fault steps over. */
        return !this.skipped().some(([start, end]) => start < index && index < end);
    }

    private trapEntry(trapReturn: number): number | StopReason {
        /** The index of the trap the trap return at index trap_return returns from, or why it is not known. */
        let level = 1;
        let i = trapReturn - 1;
        while (i >= 0) {
            const event = this.events[i];
            if (event.event === 'trap') {
                level--;
                if (level === 0) {
                    return i;
                }
            } else if (event.event === 'instruction' && event.link === LinkKind.TRAP_RETURN) {
                level++;
            } else if (event.event === 'gap' && lost(event)) {
                return 'trace_lost';
            }
            i--;
        }
        return this.complete ? 'trace_start' : 'window';
    }

    private untracedCall(gap: number): TraceInstruction | undefined {
        /** The call before the untraced gap at index gap, when the trace goes on at its return address. */
        if (gap === 0 || gap + 1 >= this.events.length) {
            return undefined;
        }
        const call = this.events[gap - 1];
        const resume = this.events[gap + 1];
        if (
            call.event !== 'instruction' ||
            call.link !== LinkKind.CALL ||
            call.next_pc !== undefined
        ) {
            return undefined;
        }
        if (resume.event !== 'sync' || resume.pc !== call.pc + call.length) {
            return undefined;
        }
        return call;
    }

    value(reg: number, use: number, depth = 0): number | undefined {
        /** The value of reg as the event at index use read it, when the frame or the trace shows it. */
        if (reg === 0) {
            return 0;
        }
        const key = `${reg}:${use}`;
        const cached = this.values.get(key);
        // A value not found deeper down can still be found with more of the depth left
        if (cached !== undefined && (cached.value !== undefined || cached.depth <= depth)) {
            return cached.value;
        }
        if (depth >= MAX_VALUE_DEPTH) {
            return undefined;
        }
        let result = this.forward(reg, use, depth);
        if (result === undefined) {
            result = this.computed(reg, use, depth);
        }
        this.values.set(key, { value: result, depth });
        return result;
    }

    private forward(reg: number, use: number, depth: number): number | undefined {
        /** The value of reg at use from the frame, back through the constants the writers up to the fault add. */
        if (depth >= MAX_VALUE_DEPTH || !this.onPath(use)) {
            return undefined;
        }
        if (this.scan(reg, this.fault).end < use) {
            // Nothing between use and the fault wrote reg, as far as the trace shows
            return this.frame.get(reg);
        }
        const writer = this.nextWriter(reg, use);
        if (writer === undefined) {
            return undefined;
        }
        const insn = this.events[writer] as TraceInstruction;
        const info = this.info(insn);
        if (
            info === undefined ||
            !ADDS.has(info.mnemonic) ||
            !setEquals(sources(info, reg), new Set([reg]))
        ) {
            return undefined;
        }
        const delta = evaluate(info, reg, insn.pc, { [reg]: 0 });
        // Only forward, since the writers before use would ask for the value at use again
        const after = this.forward(reg, writer + 1, depth + 1);
        if (delta === undefined || after === undefined) {
            return undefined;
        }
        return u32(after - delta);
    }

    private nextWriter(reg: number, use: number): number | undefined {
        /** The first instruction from index use on to the fault that writes reg, undefined when the way is not clear. */
        if (this.ends === undefined) {
            this.ends = new Map(this.skipped());
        }
        const ends = this.ends;
        let i = use;
        while (i < this.fault) {
            const event = this.events[i];
            const mret = ends.get(i);
            if (mret !== undefined) {
                // The handler of an ecall returns its result in a0 and a1
                if ((reg === A0 || reg === A1) && this.trapSpanIsSyscall(i, mret)) {
                    return undefined;
                }
                i = mret + 1;
                continue;
            }
            if (event.event === 'instruction') {
                const info = this.info(event);
                if (info === undefined || !info.supported) {
                    return undefined;
                }
                if (info.writes.has(reg)) {
                    return i;
                }
            } else if (event.event === 'gap') {
                if (lost(event) || !CALLEE_SAVED.has(reg) || this.untracedCall(i) === undefined) {
                    return undefined;
                }
            }
            i++;
        }
        return undefined;
    }

    private trapSpanIsSyscall(trapIndex: number, mretIndex: number): boolean {
        const span = this.trapSpan(mretIndex);
        return Array.isArray(span) && span[0] === trapIndex && span[1] === 'syscall';
    }

    private computed(reg: number, use: number, depth: number): number | undefined {
        const scan = this.scan(reg, use);
        if (scan.writer === undefined) {
            return undefined;
        }
        if (scan.writer === this.scan(reg, this.fault).writer && this.frame.has(reg)) {
            // the last write before the fault, which the frame saved
            return this.frame.get(reg);
        }
        const writer = this.events[scan.writer] as TraceInstruction;
        const info = this.info(writer);
        const needed = info === undefined ? undefined : sources(info, reg);
        if (info === undefined || needed === undefined) {
            return undefined;
        }
        const regs: Record<number, number> = {};
        for (const source of needed) {
            const value = this.value(source, scan.writer, depth + 1);
            if (value === undefined) {
                return undefined;
            }
            regs[source] = value;
        }
        return evaluate(info, reg, writer.pc, regs);
    }
}

/** Unsigned 32-bit wrap, correct for negative and >32-bit inputs where `%` is not. */
function u32(value: number): number {
    return value >>> 0;
}

function bisectLeft(sorted: number[], value: number): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < value) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

function lost(gap: TraceGap): boolean {
    /** Whether the gap lost trace. Untraced code loses none. */
    return gap.reason !== GapReason.UNTRACED;
}

function asLoaded(stored: number, width: number, signed: boolean): number {
    /** What a load of width bytes reads back from the bytes a store of the value stored wrote. */
    const bits = 8 * width;
    const mask = bits >= 32 ? MASK32 : (1 << bits) - 1;
    const value = stored & mask;
    if (signed && bits < 32 && value >= 1 << (bits - 1)) {
        return value | (MASK32 & ~mask);
    }
    return value;
}

function isCopy(info: InsnInfo): boolean {
    return COPIES.has(info.mnemonic) || (info.mnemonic === 'addi' && info.imm === 0);
}

function setEquals(a: ReadonlySet<number> | undefined, b: ReadonlySet<number>): boolean {
    if (a === undefined || a.size !== b.size) {
        return false;
    }
    for (const item of a) {
        if (!b.has(item)) {
            return false;
        }
    }
    return true;
}

function addCrossing(items: Crossing[], item: Crossing): void {
    if (!items.includes(item)) {
        items.push(item);
    }
}
