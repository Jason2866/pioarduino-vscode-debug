// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/analysis/history.py (Apache-2.0).

import { ECALL_LENGTH, MASK32 } from '../decoder/encoding';
import { GapReason } from '../decoder/reconstruct';
import { decodeAt } from '../decoder/semantics';
import { CodeImage } from '../elf/image';
import {
    InsnClass,
    LinkKind,
    TraceEvent,
    TraceGap,
    TraceInstruction,
    TraceSync,
    TraceTrap,
} from '../ir/events';

// mcause exception codes of the RISC-V privileged ISA
export const EXCEPTION_NAMES: Record<number, string> = {
    0: 'instruction address misaligned',
    1: 'instruction access fault',
    2: 'illegal instruction',
    3: 'breakpoint',
    4: 'load address misaligned',
    5: 'load access fault',
    6: 'store/AMO address misaligned',
    7: 'store/AMO access fault',
    8: 'environment call from U-mode',
    9: 'environment call from S-mode',
    11: 'environment call from M-mode',
    12: 'instruction page fault',
    13: 'load page fault',
    15: 'store/AMO page fault',
};

// Environment calls are requests the handler serves and returns from, not faults
export const ECALL_CAUSES = new Set([8, 9, 11]);

// Longest run of items that folds into a loop
export const MAX_LOOP_PERIOD = 16;

// Oldest frames are dropped beyond this, so runaway recursion cannot grow the shadow stack without bound
const MAX_FRAMES = 1024;

// Instructions a new loop looks back over for where its first pass began
const LOOP_LOOKBACK = 4096;

// The FreeRTOS function that picks the next task. A trap handler that calls it can resume another task, which
// tasks that yield through the same code do at the very instruction the trap interrupted.
export const SCHEDULER_FUNCTIONS = new Set(['vTaskSwitchContext']);

const SCHEDULER_SWITCH = 'the trap handler ran the scheduler and resumed another task at the interrupted instruction';

export function isFault(trap: TraceTrap): boolean {
    /** Tell whether `trap` is an exception other than an environment call, where a crash analysis ends. */
    return !trap.interrupt && !ECALL_CAUSES.has(trap.cause);
}

export function endsHistory(trap: TraceTrap, endInterrupts: ReadonlySet<number>): boolean {
    /** Tell whether `trap` is a fault or an interrupt whose mcause exception code is in `endInterrupts`. */
    return isFault(trap) || (trap.interrupt && endInterrupts.has(trap.cause));
}

export function causeName(cause: number, interrupt: boolean): string {
    /** Return a readable name for an mcause value. */
    if (interrupt) {
        return `interrupt ${cause}`;
    }
    return EXCEPTION_NAMES[cause] ?? `exception ${cause}`;
}

export enum HistoryKind {
    START = 'start', // the trace starts, or restarts after a gap
    CALL = 'call',
    RETURN = 'return',
    TAIL_CALL = 'tail_call', // a jump into another function, which keeps the call depth
    INTERRUPT = 'interrupt',
    ECALL = 'ecall', // an environment call, which the handler returns from
    TRAP_RETURN = 'trap_return', // mret back to the instruction the trap was taken at
    // mret to other code than the trapped one, usually another task, or to the trapped instruction where a later
    // return shows another task
    CONTEXT_SWITCH = 'context_switch',
    // Where the history ends: the first exception other than an environment call, or an interrupt that ends it
    FAULT = 'fault',
    GAP = 'gap',
}

// Entries that move control by a jump. When it leaves the traced range, the target is undefined, or inferred for a call.
const JUMP_KINDS = new Set<HistoryKind>([
    HistoryKind.CALL,
    HistoryKind.RETURN,
    HistoryKind.TAIL_CALL,
    HistoryKind.TRAP_RETURN,
]);

// Instructions that set the base register of a jalr, with whether the value is relative to their own address
const UPPER_IMMEDIATES: Record<string, boolean> = { auipc: true, lui: false };

// The auipc or lui and the jalr of a call the history names are 32-bit instructions
const PAIR_INSN_LENGTH = 4;

export interface HistoryEntry {
    /**
     * One control transfer the call outline shows.
     * `depth` is the outline depth. A call and its return both sit at the depth of the caller, every
     * other entry at the depth of the code it happens in. Depths compare only within one `segment`.
     */
    kind: HistoryKind;
    pc: number | undefined; // instruction that moved control: the jump, or the epc of a trap; undefined when not known
    target: number | undefined; // where execution went on: callee, return address, handler or start address
    depth: number;
    // Increments at every START, at a CONTEXT_SWITCH to other code than the trapped one, and when a trap return loses
    // the stack
    segment: number;
    instructions: number; // retired after this entry, up to the next one
    cause?: number; // mcause of INTERRUPT, ECALL and FAULT
    tval?: number; // mtval of ECALL and FAULT
    detail: string; // gap reason, or why a return does not match the shadow stack
    interrupt: boolean; // FAULT: the trap is an interrupt that ends the history
    // CALL into code outside the traced range. The code of the call gives the target the trace does not report.
    target_inferred: boolean;
}

export interface HistoryLoop {
    /** A run of items that repeated `count` times in a row. */
    count: number;
    body: HistoryItem[]; // the last pass
    instructions: number; // retired over every pass
}

export type HistoryItem = HistoryEntry | HistoryLoop;

export interface StackFrame {
    /** A call, or a trap, that had not returned where the history ends: one frame of the call stack. */
    kind: HistoryKind; // CALL, INTERRUPT or ECALL
    pc: number | undefined; // the call instruction or the epc of the trap; undefined for a call from code outside the traced range
    returns_to: number | undefined; // where the frame returns to; undefined when not known
    cause?: number; // mcause of a trap frame
    // A trap handler that ran the scheduler resumed this frame, so it can belong to another task
    unsure: boolean;
}

export interface CodeLoop {
    /** The loop the code ran in, without leaving it, where the history ends. */
    start: number;
    end: number;
    instructions: number; // retired in the loop, counting at most LOOP_LOOKBACK of its first pass
    passes: number; // jumps back to start
    // The loop goes back to the first instruction of the trace, or the first after it lost trace, so it may have run
    // longer
    whole: boolean;
}

export interface History {
    /** The call outline of one core, oldest item first. */
    items: HistoryItem[];
    omitted: number; // older items left out of `items`
    instructions: number; // retired up to the fault, or to the end of the trace
    fault: HistoryEntry | undefined; // the exception, or the interrupt that ends it, the history ends at
    // Where the history ends, the frames whose call or trap the trace shows, newest first. Older frames are not in
    // the trace: it starts, loses trace or switches tasks below them.
    stack: StackFrame[];
    loop: CodeLoop | undefined;
    // Of `instructions`, those since the trace started or last lost trace. Code outside the traced range loses none.
    since_loss: number;
}

interface Frame {
    depth: number; // outline depth of the code that entered the frame
    resume: number[]; // addresses that return into that code; empty when not known, which accepts any
    trap: boolean;
    // Under a trap that returned to its epc. Another task preempted at the same instruction resumes there too.
    resumed: boolean;
    // Trap frame: the handler ran the scheduler. Resumed frame: a trap that resumed it did, so returns that match
    // it do not show which task runs, as tasks that yield through the same functions return the same way.
    scheduled: boolean;
    // Entered from code outside the traced range, so it returns into untraced code
    untraced_caller: boolean;
    pc: number | undefined; // the call instruction or the epc of the trap
    kind: HistoryKind;
    cause?: number; // mcause of a trap frame

    accepts(target: number | undefined): boolean;
}

interface Loop {
    start: number;
    end: number;
    depth: number;
    segment: number;
    instructions: number;
    passes: number;
    whole: boolean;

    holds(pc: number, depth: number, segment: number): boolean;
}

export class HistoryBuilder {
    /**
     * Streams trace events of one core into a `History`.
     * `image` names the function of a jump and its target, which tells a tail call from a jump inside a
     * function. Without it, jumps that do not call or return are not recorded. Its code also gives the callee of a call
     * into code outside the traced range, when an auipc or lui and the jalr of the call make the address. An interrupt
     * whose mcause exception code is in `endInterrupts` ends the history like a fault.
     */
    private image: CodeImage | undefined;
    private endInterrupts: ReadonlySet<number>;
    private symbols = new Map<number, string | undefined>();
    private items: HistoryItem[] = [];
    private keys: unknown[][] = [];
    private pending: HistoryEntry | undefined;
    private pendingInstructions = 0;
    private stack: Frame[] = [];
    private depth = 0;
    private segment = -1;
    private running = false;
    // Code outside the traced range runs, the stack stays valid until the trace enters the range again
    private untraced = false;
    private fault: HistoryEntry | undefined;
    private instructions = 0;
    // The trap return of a handler that ran the scheduler, where a later return can show that another task resumed.
    // undefined when not known: another such trap return resumed the same frames before it.
    private switchEntry: HistoryEntry | undefined;
    private switchPending = false;
    private loop: Loop | undefined;
    // pc, depth and segment of the newest instructions; undefined where a trap or a loss of trace came between them
    private recent: Array<[number, number, number] | undefined> = [];
    private sinceLoss = 0; // instructions since the trace started or last lost trace
    // The newest instruction, undefined after a sync, a trap or a gap
    private previous: TraceInstruction | undefined;

    constructor(image?: CodeImage, endInterrupts: ReadonlySet<number> = new Set()) {
        this.image = image;
        this.endInterrupts = endInterrupts;
    }

    get done(): boolean {
        /** True once the fault is recorded. Later events are ignored. */
        return this.fault !== undefined;
    }

    push(event: TraceEvent): void {
        if (this.done) {
            return;
        }
        if (event.event === 'instruction') {
            const insn = event as TraceInstruction;
            if (this.untraced) {
                this.reenter(insn.pc);
            } else if (!this.running) {
                this.start(insn.pc);
            }
            this.instructions++;
            this.pendingInstructions++;
            this.followLoop(insn);
            this.onInstruction(insn);
            this.previous = insn;
        } else if (event.event === 'sync') {
            this.previous = undefined;
            const sync = event as TraceSync;
            if (this.untraced) {
                this.reenter(sync.pc);
            } else if (!this.running) {
                this.start(sync.pc);
            }
        } else if (event.event === 'trap') {
            this.previous = undefined;
            this.untraced = false;
            this.onTrap(event as TraceTrap);
        } else if (event.event === 'gap') {
            this.previous = undefined;
            const gap = event as TraceGap;
            if (gap.reason === GapReason.UNTRACED && this.running) {
                this.onUntraced();
            } else {
                this.onGap(gap);
            }
        }
    }

    close(last = 0): History {
        /** Return the history, with only the `last` newest items when it is not zero. */
        this.finishPending();
        const sliced = last ? this.items.slice(-last) : this.items;
        const items = rebase(sliced);
        const fault = items.length ? items[items.length - 1] : undefined;
        const faultEntry = fault !== undefined && !isHistoryLoop(fault) ? fault : undefined;
        const loop = this.loop;
        return {
            items,
            omitted: this.items.length - items.length,
            instructions: this.instructions,
            fault: this.fault !== undefined ? faultEntry : undefined,
            stack: [...this.stack].reverse().map((f) => ({
                kind: f.kind,
                pc: f.pc,
                returns_to: f.resume.length ? f.resume[0] : undefined,
                cause: f.cause,
                unsure: f.resumed && f.scheduled,
            })),
            loop:
                loop === undefined
                    ? undefined
                    : { start: loop.start, end: loop.end, instructions: loop.instructions, passes: loop.passes, whole: loop.whole },
            since_loss: this.sinceLoss,
        };
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    private onInstruction(insn: TraceInstruction): void {
        const link = insn.link;
        if (link === LinkKind.CALL) {
            if (this.runsScheduler(insn.next_pc)) {
                const handler = [...this.stack].reverse().find((f) => f.trap);
                if (handler !== undefined) {
                    handler.scheduled = true;
                }
            }
            let target = insn.next_pc;
            let inferred = false;
            if (target === undefined) {
                const inferredTarget = this.untracedCallTarget(insn);
                if (inferredTarget !== undefined) {
                    target = inferredTarget;
                    inferred = true;
                }
            }
            this.open(HistoryKind.CALL, insn.pc, target, this.depth, { target_inferred: inferred });
            this.pushFrame(makeFrame(this.depth, [insn.pc + insn.length], false, insn.pc));
            this.depth++;
        } else if (link === LinkKind.RETURN) {
            this.onReturn(insn);
        } else if (link === LinkKind.TRAP_RETURN) {
            this.onTrapReturn(insn);
        } else if ((link === LinkKind.JUMP || link === LinkKind.COROUTINE) && this.leavesFunction(insn)) {
            this.open(HistoryKind.TAIL_CALL, insn.pc, insn.next_pc, this.depth);
        }
    }

    private onReturn(insn: TraceInstruction): void {
        const target = insn.next_pc;
        let detail = '';
        let frame: Frame | undefined;
        if (this.stack.length && !this.stack[this.stack.length - 1].trap) {
            // A return into untraced code cannot be checked against the call
            frame = target === undefined ? this.stack.pop() : this.popToCall(target);
            const top = this.stack.length ? this.stack[this.stack.length - 1] : undefined;
            if (frame === undefined && top !== undefined && top.resumed) {
                const scheduled = top.scheduled;
                if (!this.loseResumedStack(scheduled)) {
                    detail = scheduled
                        ? `task switch: ${SCHEDULER_SWITCH}`
                        : 'returns into other code than the interrupted one, likely another task';
                }
            } else if (frame === undefined) {
                frame = this.stack.pop();
                const expected = frame.resume.length ? `0x${frame.resume[0].toString(16).padStart(8, '0')}` : 'untraced code';
                detail = `return address does not match the call, which returns to ${expected}`;
            }
        }
        if (frame !== undefined) {
            this.depth = frame.depth;
            if (frame.resumed && !frame.scheduled && !detail && target !== undefined) {
                // The return proves that the trap resumed the code it interrupted
                for (const below of this.stack) {
                    below.resumed = false;
                }
            }
        } else {
            // The caller is older than the trace, or the trace entered this code without a call
            this.depth--;
        }
        this.open(HistoryKind.RETURN, insn.pc, target, this.depth, { detail });
    }

    private loseResumedStack(scheduled: boolean): boolean {
        /**
         * Drop a stack that a trap return resumed but a return shows to belong to other code.
         * The other code entered its frames through the same instruction, so the depths go on. Return whether the trap
         * return that resumed it is known, which then becomes the context switch: the last entry, or the trap return of
         * the handler that ran the scheduler.
         */
        const sw = this.switchEntry;
        this.stack = [];
        this.switchEntry = undefined;
        this.switchPending = false;
        const detail = scheduled ? SCHEDULER_SWITCH : '';
        const pending = this.pending;
        if (pending !== undefined && pending.kind === HistoryKind.TRAP_RETURN && !pending.detail) {
            this.pending = { ...pending, kind: HistoryKind.CONTEXT_SWITCH, detail };
            return true;
        }
        if (!scheduled || sw === undefined) {
            return false;
        }
        // A loop that took the trap return in leaves only its last pass, so the switch is not an entry then
        const at = this.items.lastIndexOf(sw);
        if (at === -1) {
            return false;
        }
        const entry: HistoryEntry = { ...sw, kind: HistoryKind.CONTEXT_SWITCH, detail };
        this.items[at] = entry;
        this.keys[at] = entryKey(entry);
        return true;
    }

    private popToCall(target: number): Frame | undefined {
        /** Pop the newest call frame that `target` returns into, and the frames above it. */
        for (let i = this.stack.length - 1; i >= 0; i--) {
            const frame = this.stack[i];
            if (frame.trap) {
                return undefined;
            }
            if (frame.accepts(target)) {
                this.stack = this.stack.slice(0, i);
                return frame;
            }
        }
        return undefined;
    }

    private onTrapReturn(insn: TraceInstruction): void {
        const target = insn.next_pc;
        let trapAt = -1;
        for (let i = this.stack.length - 1; i >= 0; i--) {
            if (this.stack[i].trap) {
                trapAt = i;
                break;
            }
        }
        if (trapAt === -1) {
            // The trap entry is older than the trace, so the call stack of the code it returns to is not known
            this.newSegment();
            this.open(HistoryKind.TRAP_RETURN, insn.pc, target, 0, { detail: 'trap entry not in the trace' });
            return;
        }
        const frame = this.stack[trapAt];
        if (frame.accepts(target)) {
            this.stack = this.stack.slice(0, trapAt);
            // When an earlier trap return after a scheduler run resumed these frames too, either one can be the switch
            const switchKnown = !this.stack.some((f) => f.resumed && f.scheduled);
            for (const resumed of this.stack) {
                resumed.resumed = true;
                resumed.scheduled = resumed.scheduled || frame.scheduled;
            }
            this.depth = frame.depth;
            this.open(HistoryKind.TRAP_RETURN, insn.pc, target, this.depth);
            if (frame.scheduled) {
                this.switchEntry = undefined;
                this.switchPending = switchKnown;
            }
            return;
        }
        this.newSegment();
        this.open(HistoryKind.CONTEXT_SWITCH, insn.pc, target, 0);
    }

    private onTrap(trap: TraceTrap): void {
        if (!this.running) {
            this.newSegment();
            this.running = true;
        }
        const epc = trap.epc;
        if (endsHistory(trap, this.endInterrupts)) {
            const tval = trap.interrupt ? undefined : trap.tval;
            this.open(HistoryKind.FAULT, epc, trap.handler_pc, this.depth, {
                cause: trap.cause,
                tval,
                interrupt: trap.interrupt,
            });
            this.fault = this.pending;
            this.finishPending();
            return;
        }
        this.breakLoop();
        let kind: HistoryKind;
        let tval: number | undefined;
        let resume: number[];
        if (trap.interrupt) {
            kind = HistoryKind.INTERRUPT;
            tval = undefined;
            resume = epc === undefined ? [] : [epc];
        } else {
            // The handler returns past the ecall, or retries it
            kind = HistoryKind.ECALL;
            tval = trap.tval;
            resume = epc === undefined ? [] : [epc + ECALL_LENGTH, epc];
        }
        this.open(kind, epc, trap.handler_pc, this.depth, { cause: trap.cause, tval });
        this.pushFrame(makeFrame(this.depth, resume, true, epc, kind, trap.cause));
        this.depth++;
    }

    private onGap(gap: TraceGap): void {
        const pending = this.pending;
        if (
            pending !== undefined &&
            pending.kind === HistoryKind.GAP &&
            pending.detail === gap.reason &&
            this.pendingInstructions === 0
        ) {
            return;
        }
        this.open(HistoryKind.GAP, undefined, undefined, this.depth, { detail: gap.reason });
        this.running = false;
        this.untraced = false;
        this.stack = [];
        this.breakLoop();
        this.sinceLoss = 0;
    }

    private onUntraced(): void {
        /** Keep the stack while code outside the traced range runs, which returns or calls back into it. */
        const pending = this.pending;
        const leftByJump =
            pending !== undefined &&
            (pending.target === undefined || pending.target_inferred) &&
            JUMP_KINDS.has(pending.kind) &&
            this.pendingInstructions === 0;
        if (!leftByJump) {
            this.open(HistoryKind.GAP, undefined, undefined, this.depth, { detail: GapReason.UNTRACED });
        }
        this.untraced = true;
    }

    private reenter(pc: number): void {
        /** Continue at `pc`, where the trace enters the traced range again. */
        this.untraced = false;
        const frame = this.popToCall(pc);
        if (frame !== undefined) {
            this.depth = frame.depth;
            this.open(HistoryKind.RETURN, undefined, pc, this.depth);
            return;
        }
        // Untraced code calls into the traced range, as ROM code calls back into the application
        this.open(HistoryKind.CALL, undefined, pc, this.depth);
        this.pushFrame(makeFrame(this.depth, [], false, undefined, HistoryKind.CALL, undefined, true));
        this.depth++;
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    private start(pc: number): void {
        this.newSegment();
        this.running = true;
        this.open(HistoryKind.START, undefined, pc, 0);
    }

    private newSegment(): void {
        this.segment++;
        this.stack = [];
        this.depth = 0;
        this.untraced = false;
        this.switchEntry = undefined;
        this.switchPending = false;
    }

    private pushFrame(frame: Frame): void {
        this.stack.push(frame);
        if (this.stack.length > MAX_FRAMES) {
            this.stack.shift();
        }
    }

    private followLoop(insn: TraceInstruction): void {
        /** Count `insn` into the loop the code runs in, or start a loop at a jump back. */
        const depth = this.depth;
        const segment = this.segment;
        let loop = this.loop;
        if (loop !== undefined && !loop.holds(insn.pc, depth, segment)) {
            this.loop = loop = undefined;
        }
        if (loop !== undefined) {
            loop.instructions++;
        }
        this.recent.push([insn.pc, depth, segment]);
        if (this.recent.length > LOOP_LOOKBACK) {
            this.recent.shift();
        }
        this.sinceLoss++;
        const target = insn.next_pc;
        if (target === undefined || !this.jumpsBack(insn)) {
            return;
        }
        if (loop === undefined || (depth === loop.depth && target < loop.start)) {
            this.loop = this.newLoop(makeLoop(target, insn.pc, depth, segment));
        } else if (target === loop.start && insn.pc === loop.end && depth === loop.depth) {
            loop.passes++;
        }
    }

    private newLoop(loop: Loop): Loop {
        /** Count the first pass of `loop` back from its jump back, the newest instruction. */
        let inCall = 0; // instructions in a call, part of the loop only when the loop made the call
        for (let i = this.recent.length - 1; i >= 0; i--) {
            const item = this.recent[i];
            if (item === undefined || !loop.holds(item[0], item[1], item[2])) {
                break;
            }
            if (item[1] > loop.depth) {
                inCall++;
            } else {
                loop.instructions += 1 + inCall;
                inCall = 0;
            }
        }
        loop.whole = loop.instructions === this.sinceLoss;
        return loop;
    }

    private jumpsBack(insn: TraceInstruction): boolean {
        /** Tell whether `insn` jumps or branches back inside its function, as the end of a loop does. */
        if (insn.next_pc === undefined || insn.next_pc > insn.pc) {
            return false;
        }
        if (insn.cls === InsnClass.BRANCH) {
            return insn.branch_taken === true;
        }
        return insn.cls === InsnClass.JUMP && insn.link === LinkKind.JUMP && !this.leavesFunction(insn);
    }

    private breakLoop(): void {
        this.loop = undefined;
        this.recent.push(undefined);
        if (this.recent.length > LOOP_LOOKBACK) {
            this.recent.shift();
        }
    }

    private untracedCallTarget(call: TraceInstruction): number | undefined {
        /** Where a call into untraced code goes, from the auipc or lui that retired right before its jalr. */
        const image = this.image;
        const previous = this.previous;
        if (image === undefined || previous === undefined || call.length !== PAIR_INSN_LENGTH) {
            return undefined;
        }
        const start = call.pc - PAIR_INSN_LENGTH;
        if (previous.pc !== start || previous.length !== PAIR_INSN_LENGTH || previous.next_pc !== call.pc) {
            return undefined;
        }
        const high = decodeAt(image, start);
        const jalr = decodeAt(image, call.pc);
        if (high === undefined || jalr === undefined) {
            return undefined;
        }
        const relative = UPPER_IMMEDIATES[high.mnemonic];
        if (relative === undefined || jalr.mnemonic !== 'jalr' || !high.rd || high.rd !== jalr.rs1) {
            return undefined;
        }
        const highImm = high.imm;
        const jalrImm = jalr.imm;
        if (highImm === undefined || jalrImm === undefined) {
            return undefined;
        }
        const base = relative ? start : 0;
        // jalr clears bit 0 of the target
        return (((base + highImm + jalrImm) & MASK32) & ~1) >>> 0;
    }

    private runsScheduler(target: number | undefined): boolean {
        if (this.image === undefined || target === undefined) {
            return false;
        }
        const name = this.symbol(target);
        return name !== undefined && SCHEDULER_FUNCTIONS.has(name);
    }

    private leavesFunction(insn: TraceInstruction): boolean {
        if (insn.next_pc === undefined) {
            return true;
        }
        if (this.image === undefined) {
            return false;
        }
        return this.symbol(insn.next_pc) !== this.symbol(insn.pc);
    }

    private symbol(pc: number): string | undefined {
        if (!this.symbols.has(pc)) {
            this.symbols.set(pc, this.image!.symbolAt(pc));
        }
        return this.symbols.get(pc);
    }

    private open(
        kind: HistoryKind,
        pc: number | undefined,
        target: number | undefined,
        depth: number,
        opts: {
            cause?: number;
            tval?: number;
            detail?: string;
            interrupt?: boolean;
            target_inferred?: boolean;
        } = {}
    ): void {
        /** Finish the pending entry and start counting instructions for a new one. */
        this.finishPending();
        this.pending = {
            kind,
            pc,
            target,
            depth,
            segment: this.segment,
            instructions: 0,
            cause: opts.cause,
            tval: opts.tval,
            detail: opts.detail ?? '',
            interrupt: opts.interrupt ?? false,
            target_inferred: opts.target_inferred ?? false,
        };
        this.pendingInstructions = 0;
    }

    private finishPending(): void {
        if (this.pending === undefined) {
            return;
        }
        const entry: HistoryEntry = { ...this.pending, instructions: this.pendingInstructions };
        this.pending = undefined;
        if (this.switchPending) {
            this.switchEntry = entry;
            this.switchPending = false;
        }
        this.items.push(entry);
        this.keys.push(entryKey(entry));
        while (this.fold()) {
            // keep folding while it applies
        }
    }

    private fold(): boolean {
        /** Fold the newest items into a loop when they repeat the items before them. */
        const items = this.items;
        const keys = this.keys;
        const n = items.length;
        // Another pass of the loop just before
        for (let period = 1; period <= Math.min(MAX_LOOP_PERIOD, n - 1); period++) {
            const start = n - period - 1;
            const prev = items[start];
            if (prev !== undefined && isHistoryLoop(prev) && prev.body.length === period && keysEqual(keys[start][1], keys.slice(start + 1))) {
                const body = items.slice(start + 1) as HistoryEntry[];
                this.replaceTail(start, {
                    count: prev.count + 1,
                    body,
                    instructions: prev.instructions + itemsInstructions(body),
                });
                return true;
            }
        }
        // Two passes in a row
        for (let period = 1; period <= Math.min(MAX_LOOP_PERIOD, Math.floor(n / 2)); period++) {
            const start = n - 2 * period;
            if (keysEqualSlice(keys, start, n - period, n)) {
                const body = items.slice(n - period) as HistoryEntry[];
                this.replaceTail(start, { count: 2, body, instructions: itemsInstructions(items.slice(start)) });
                return true;
            }
        }
        return false;
    }

    private replaceTail(start: number, loop: HistoryLoop): void {
        const bodyKeys = this.keys.slice(this.keys.length - loop.body.length);
        this.items = this.items.slice(0, start);
        this.keys = this.keys.slice(0, start);
        this.items.push(loop);
        this.keys.push(['loop', bodyKeys]);
    }
}

function isHistoryLoop(item: HistoryItem): item is HistoryLoop {
    return 'body' in item;
}

function makeLoop(start: number, end: number, depth: number, segment: number): Loop {
    return {
        start,
        end,
        depth,
        segment,
        instructions: 0,
        passes: 1,
        whole: false,
        holds(pc: number, d: number, seg: number): boolean {
            /** Tell whether the instruction at `pc` and `depth` can be part of the loop: in it, or in a call. */
            if (seg !== this.segment || d < this.depth) {
                return false;
            }
            return d > this.depth || (this.start <= pc && pc <= this.end);
        },
    };
}

function makeFrame(
    depth: number,
    resume: number[],
    trap: boolean,
    pc: number | undefined,
    kind: HistoryKind = HistoryKind.CALL,
    cause?: number,
    untracedCaller = false
): Frame {
    return {
        depth,
        resume,
        trap,
        resumed: false,
        scheduled: false,
        untraced_caller: untracedCaller,
        pc,
        kind,
        cause,
        accepts(target: number | undefined): boolean {
            if (target === undefined) {
                return true;
            }
            if (this.untraced_caller) {
                return false;
            }
            return this.resume.length === 0 || this.resume.includes(target);
        },
    };
}

function entryKey(entry: HistoryEntry): unknown[] {
    /** What makes two entries the same step of a loop. Instruction counts and segments may differ. */
    return [entry.kind, entry.pc, entry.target, entry.target_inferred, entry.depth, entry.cause, entry.detail];
}

function keysEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function keysEqualSlice(keys: unknown[][], a: number, b: number, end: number): boolean {
    if (b - a !== end - b) {
        return false;
    }
    for (let i = 0; i < b - a; i++) {
        if (!keysEqual(keys[a + i], keys[b + i])) {
            return false;
        }
    }
    return true;
}

function itemsInstructions(items: Iterable<HistoryItem>): number {
    let total = 0;
    for (const item of items) {
        total += item.instructions;
    }
    return total;
}

export function* iterEntries(items: Iterable<HistoryItem>): Generator<HistoryEntry> {
    /** Yield the entries of `items` in order, with the last pass of each loop. */
    for (const item of items) {
        if (isHistoryLoop(item)) {
            yield* iterEntries(item.body);
        } else {
            yield item;
        }
    }
}

function rebase(items: HistoryItem[]): HistoryItem[] {
    /** Shift depths so the shallowest entry of each segment in `items` is at depth 0. */
    const lowest = new Map<number, number>();
    for (const entry of iterEntries(items)) {
        const prev = lowest.get(entry.segment);
        lowest.set(entry.segment, prev === undefined ? entry.depth : Math.min(prev, entry.depth));
    }

    const shift = (item: HistoryItem): HistoryItem => {
        if (isHistoryLoop(item)) {
            return { ...item, body: item.body.map(shift) as HistoryEntry[] };
        }
        return { ...item, depth: item.depth - (lowest.get(item.segment) ?? 0) };
    };

    return items.map(shift);
}

export function buildHistory(
    events: Iterable<TraceEvent>,
    image?: CodeImage,
    opts: { last?: number; endInterrupts?: ReadonlySet<number> } = {}
): History {
    /** Build the history of one core's events, reading them only up to the fault. */
    const builder = new HistoryBuilder(image, opts.endInterrupts ?? new Set());
    for (const event of events) {
        builder.push(event);
        if (builder.done) {
            break;
        }
    }
    return builder.close(opts.last ?? 0);
}
