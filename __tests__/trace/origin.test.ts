/**
 * Register origin walks over made-up native events.
 *
 * Ported from esp-riscv-trace tests/test_origin.py (Apache-2.0). The walks cover calls, loops, traps, untraced code
 * and memory, and what the native event types change: boundaries, warnings, lost and untraced gaps, unreadable
 * code, image errors, the scheduler name and bus access indexes.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
    BranchOutcome,
    BusAccess,
    Crossing,
    FaultWindow,
    FaultWindowBuilder,
    MAX_STEPS,
    MAX_VALUE_DEPTH,
    Relation,
    StackCall,
    StepKind,
    StopReason,
    walkSteps,
} from '../../src/trace/analysis/origin';
import { HistoryBuilder } from '../../src/trace/analysis/history';
import { GapReason } from '../../src/trace/decoder/reconstruct';
import { CodeImage, CodeReadError } from '../../src/trace/elf/image';
import {
    InsnClass,
    LinkKind,
    TraceBoundary,
    TraceEvent,
    TraceGap,
    TraceInstruction,
    TraceSync,
    TraceTrap,
    TraceWarning,
} from '../../src/trace/ir/events';
import { iterCores, openSession } from '../../src/trace/session';

const [RA, SP, T0, S0, A0, A1, A3, A4, A5, A6] = [1, 2, 5, 8, 10, 11, 13, 14, 15, 16];
const [MAIN, FOO, OTHER, HANDLER, SCHEDULER] = [0x1000, 0x2000, 0x3000, 0x4000, 0x6000];
const NAMES: Record<number, string> = {
    [MAIN]: 'main',
    [FOO]: 'foo',
    [OTHER]: 'task_b',
    [HANDLER]: 'isr',
    [SCHEDULER]: 'vTaskSwitchContext',
};
const [LOAD_FAULT, STORE_FAULT, FETCH_FAULT, TIMER, M_ECALL] = [5, 7, 1, 7, 11];
const STACK = 0x2f019bc0;
const MRET = 0x30200073;
// Bits 6..0 of 0b0111111 mark an encoding wider than 32 bits, which does not decode
const WIDE = 0x0000003f;

function i(opcode: number, rd: number, funct3: number, rs1: number, imm: number): number {
    return (((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0;
}

function addi(rd: number, rs1: number, imm: number): number {
    return i(0x13, rd, 0, rs1, imm);
}

function li(rd: number, imm: number): number {
    return addi(rd, 0, imm);
}

function mv(rd: number, rs: number): number {
    return addi(rd, rs, 0);
}

function add(rd: number, rs1: number, rs2: number): number {
    return ((rs2 << 20) | (rs1 << 15) | (rd << 7) | 0x33) >>> 0;
}

function lw(rd: number, rs1: number, imm: number): number {
    return i(0x03, rd, 2, rs1, imm);
}

function jalr(rd: number, rs1: number, imm = 0): number {
    return i(0x67, rd, 0, rs1, imm);
}

function sw(rs2: number, rs1: number, imm: number): number {
    return (((imm >> 5) & 0x7f) << 25 | (rs2 << 20) | (rs1 << 15) | (2 << 12) | ((imm & 0x1f) << 7) | 0x23) >>> 0;
}

function jal(rd: number, offset: number): number {
    const imm = offset & 0x1fffff;
    return (
        (((imm >> 20) & 1) << 31) |
        (((imm >> 1) & 0x3ff) << 21) |
        (((imm >> 11) & 1) << 20) |
        (((imm >> 12) & 0xff) << 12) |
        (rd << 7) |
        0x6f
    ) >>> 0;
}

function branch(funct3: number, rs1: number, rs2: number, offset: number): number {
    const imm = offset & 0x1fff;
    return (
        (((imm >> 12) & 1) << 31) |
        (((imm >> 5) & 0x3f) << 25) |
        (rs2 << 20) |
        (rs1 << 15) |
        (funct3 << 12) |
        (((imm >> 1) & 0xf) << 8) |
        (((imm >> 11) & 1) << 7) |
        0x63
    ) >>> 0;
}

function cmStack(stackOp: number): number {
    /** A Zcmp stack instruction of {ra} with no extra stack adjustment. */
    return ((0b101 << 13) | (stackOp << 8) | (4 << 4) | 0b10) >>> 0;
}

const CM_PUSH = cmStack(0b11000);
const CM_POPRET = cmStack(0b11110);

/** The code the made-up events ran, by pc, with the function of each 4 KiB range named. */
class Code implements CodeImage {
    words = new Map<number, number>();
    names = new Map<number, string>(Object.entries(NAMES).map(([k, v]) => [Number(k), v]));

    read(vaddr: number, size: number): Buffer {
        const word = this.words.get(vaddr);
        if (word === undefined) {
            throw new CodeReadError(`0x${vaddr.toString(16).padStart(8, '0')} has no code`);
        }
        const out = Buffer.alloc(size);
        for (let b = 0; b < size; b++) {
            out[b] = (word >>> (8 * b)) & 0xff;
        }
        return out;
    }

    symbolAt(vaddr: number): string | undefined {
        return this.names.get(Math.floor(vaddr / 4096) * 4096);
    }
}

function windowOf(events: TraceEvent[], image: CodeImage | undefined, endInterrupts: number[] = []): FaultWindow {
    const builder = new FaultWindowBuilder(image, endInterrupts);
    for (const event of events) {
        builder.push(event);
    }
    return builder.close();
}

/** A made-up trace of the crashed core, with the code it ran. */
class Run {
    code = new Code();
    events: TraceEvent[] = [sync(MAIN)];

    constructor(start = MAIN) {
        this.events = [sync(start)];
    }

    /** Instructions that retire one after the other from pc on. */
    block(pc: number, ...words: number[]): this {
        for (const word of words) {
            const size = (word & 3) === 3 ? 4 : 2;
            this.jump(pc, word, LinkKind.NONE, pc + size);
            pc += size;
        }
        return this;
    }

    /** An instruction that goes to `to`. `undefined` as word leaves its code out of the image. */
    jump(pc: number, word: number | undefined, link: LinkKind, to: number | undefined): this {
        if (word !== undefined) {
            this.code.words.set(pc, word);
        }
        const size = word !== undefined && (word & 3) !== 3 ? 2 : 4;
        this.events.push({
            event: 'instruction',
            pc,
            length: size,
            cls: InsnClass.NONE,
            branch_taken: undefined,
            next_pc: to,
            provenance: undefined,
            inferred: false,
            link,
        });
        return this;
    }

    trap(cause: number, epc: number, interrupt = false): this {
        this.events.push(trapEvent(cause, interrupt, epc));
        return this;
    }

    fault(cause: number, pc: number, word?: number): this {
        if (word !== undefined) {
            this.code.words.set(pc, word);
        }
        return this.trap(cause, pc);
    }

    add(event: TraceEvent): this {
        this.events.push(event);
        return this;
    }

    origin(registers: Record<number, number>): NonNullable<ReturnType<FaultWindow['origin']>> {
        const root = windowOf(this.events, this.code).origin(registers);
        expect(root).toBeDefined();
        return root as NonNullable<typeof root>;
    }
}

function trapEvent(cause: number, interrupt: boolean, epc: number): TraceTrap {
    return {
        event: 'trap',
        cause,
        interrupt,
        handler_pc: undefined,
        interrupted_pc: undefined,
        tval: undefined,
        provenance: undefined,
        epc,
    };
}

function gap(reason: GapReason | string): TraceGap {
    return { event: 'gap', reason, detail: '', provenance: undefined };
}

function sync(pc: number): TraceSync {
    return { event: 'sync', pc, privilege: 3, provenance: undefined };
}

function chain(root: { sources: any[]; reg: number; kind: StepKind; pc?: number; value?: number } & object): Array<[number, StepKind, number | undefined, number | undefined]> {
    return [...walkSteps(root as any)].map((s) => [s.reg, s.kind, s.pc, s.value]);
}

// Made-up runs, each with the registers the trap handler saved

function calleeReturn(): [Run, Record<number, number>] {
    /** The value came back from a function that has returned. */
    const run = new Run()
        .jump(MAIN, jal(RA, FOO - MAIN), LinkKind.CALL, FOO)
        .block(FOO, li(A0, 0))
        .jump(FOO + 4, jalr(0, RA), LinkKind.RETURN, MAIN + 4)
        .block(MAIN + 4, mv(A5, A0))
        .fault(LOAD_FAULT, MAIN + 8, lw(A4, A5, 0));
    return [run, { [A0]: 0, [A5]: 0 }];
}

function interrupted(resume = MAIN + 4, nested = false): [Run, Record<number, number>] {
    /** a5 is set, then a timer interrupt saves, changes and restores a5, and returns to resume. */
    const run = new Run().block(MAIN, li(A5, 0)).trap(TIMER, MAIN + 4, true).block(HANDLER, sw(A5, SP, 0), li(A5, 1));
    if (nested) {
        run.trap(TIMER, HANDLER + 8, true).block(HANDLER + 0x100, li(A5, 2));
        run.jump(HANDLER + 0x104, MRET, LinkKind.TRAP_RETURN, HANDLER + 8);
    }
    run.block(HANDLER + 8, lw(A5, SP, 0)).jump(HANDLER + 12, MRET, LinkKind.TRAP_RETURN, resume);
    run.fault(LOAD_FAULT, resume, lw(A4, A5, 0));
    return [run, { [A5]: 0, [SP]: STACK }];
}

function scheduled(): [Run, Record<number, number>] {
    /** A timer interrupt calls the scheduler and returns to where it was taken. */
    const run = new Run().block(MAIN, li(A5, 0)).trap(TIMER, MAIN + 4, true);
    run.jump(HANDLER, jal(RA, SCHEDULER - HANDLER), LinkKind.CALL, SCHEDULER);
    run.jump(SCHEDULER, jalr(0, RA), LinkKind.RETURN, HANDLER + 4);
    run.jump(HANDLER + 4, MRET, LinkKind.TRAP_RETURN, MAIN + 4);
    run.fault(LOAD_FAULT, MAIN + 4, lw(A4, A5, 0));
    return [run, { [A5]: 0 }];
}

function untracedCall(base = S0): [Run, Record<number, number>] {
    /** Code calls through t0 into untraced code, like a ROM function, which returns. */
    const run = new Run()
        .block(MAIN, li(S0, 8), li(A5, 9))
        .jump(MAIN + 8, jalr(RA, T0), LinkKind.CALL, undefined)
        .add(gap(GapReason.UNTRACED))
        .add(sync(MAIN + 12))
        .block(MAIN + 12, li(A6, 0));
    run.fault(LOAD_FAULT, MAIN + 16, lw(A4, base, 0));
    return [run, { [S0]: 8, [A5]: 9 }];
}

function popret(): [Run, Record<number, number>] {
    /** A store to 12(sp) after cm.push {ra},-16 overwrites the saved ra, and cm.popret returns to it. */
    const run = new Run()
        .jump(MAIN, jal(RA, FOO - MAIN), LinkKind.CALL, FOO)
        .block(FOO, CM_PUSH, li(A5, 4), sw(A5, SP, 12));
    run.jump(FOO + 10, CM_POPRET, LinkKind.RETURN, 0x4);
    run.fault(FETCH_FAULT, 0x4);
    return [run, { [RA]: 0x4, [A5]: 4, [SP]: STACK }];
}

function stack(): [Run, Record<number, number>] {
    /** main lowers sp by 32 and calls foo, which lowers it by 16. A callee and an interrupt in between leave sp. */
    const run = new Run()
        .block(MAIN, addi(SP, SP, -32))
        .jump(MAIN + 4, jal(RA, FOO - MAIN - 4), LinkKind.CALL, FOO)
        .block(FOO, addi(SP, SP, -16))
        .jump(FOO + 4, jal(RA, OTHER - FOO - 4), LinkKind.CALL, OTHER)
        .block(OTHER, addi(SP, SP, -8), addi(SP, SP, 8))
        .jump(OTHER + 8, jalr(0, RA), LinkKind.RETURN, FOO + 8)
        .trap(TIMER, FOO + 8, true)
        .block(HANDLER, addi(SP, SP, -64))
        .jump(HANDLER + 4, MRET, LinkKind.TRAP_RETURN, FOO + 8)
        .fault(STORE_FAULT, FOO + 8, sw(A5, A4, 0));
    return [run, { [SP]: STACK }];
}

function branches(): [Run, Record<number, number>] {
    /** foo takes the branch at its start and not the next one, then faults. */
    const run = new Run().jump(MAIN, jal(RA, FOO - MAIN), LinkKind.CALL, FOO);
    run.jump(FOO, branch(0, A0, A1, 8), LinkKind.NONE, FOO + 8);
    run.jump(FOO + 8, branch(0, A0, A1, 8), LinkKind.NONE, FOO + 12).block(FOO + 12, addi(A5, A5, 1));
    run.fault(STORE_FAULT, FOO + 16, sw(A5, A4, 0));
    return [run, { [A5]: 1 }];
}

function busError(): [Run, Record<number, number>] {
    /** A load from a5 retires, and the bus error it caused is taken two instructions later. */
    const run = new Run().block(MAIN, li(A5, 0x40), lw(A4, A5, 0), li(A6, 0), li(A1, 0));
    run.trap(LOAD_FAULT, MAIN + 16);
    return [run, { [A5]: 0x40 }];
}

function loop(passes: number): Run {
    /** a5 grows by 4 on each pass of a loop and is used after it. */
    const run = new Run().block(MAIN, li(A5, 0), li(A6, 4 * passes));
    for (let n = 0; n < passes; n++) {
        run.block(MAIN + 8, addi(A5, A5, 4));
        run.jump(MAIN + 12, branch(1, A5, A6, -4), LinkKind.NONE, n < passes - 1 ? MAIN + 8 : MAIN + 16);
    }
    run.fault(LOAD_FAULT, MAIN + 16, lw(A4, A5, 0));
    return run;
}

function slot(...args: Array<number | { value?: number }>): Run {
    /** p is a volatile local, so 4 goes through 12(sp) before the store through it faults. */
    let value = 4;
    const between: number[] = [];
    for (const arg of args) {
        if (typeof arg === 'number') {
            between.push(arg);
        } else if (arg.value !== undefined) {
            value = arg.value;
        }
    }
    const run = new Run(FOO).block(FOO, addi(SP, SP, -16), li(A5, value), sw(A5, SP, 12));
    let pc = FOO + 12;
    for (const word of between) {
        run.block(pc, word);
        pc += 4;
    }
    run.block(pc, lw(A5, SP, 12)).fault(STORE_FAULT, pc + 4, sw(0, A5, 0));
    return run;
}

function inFoo(pc: number): boolean {
    return (pc & ~0xfff) === FOO;
}

// Walks across calls, traps and memory

class Failing extends Code {
    failing: boolean;

    constructor(code: Code, failing = true) {
        super();
        this.words = code.words;
        this.names = code.names;
        this.failing = failing;
    }

    override read(vaddr: number, size: number): Buffer {
        if (this.failing) {
        throw new Error('image read failed');
    }
        return super.read(vaddr, size);
    }
    }


describe('origin walks', () => {
    test('callee return value', () => {
        const [run, registers] = calleeReturn();
        const root = run.origin(registers);
        expect(chain(root)).toEqual([
            [A5, 'copied', MAIN + 4, 0],
            [A0, 'set', FOO, 0],
        ]);
        expect([root.relation, root.sources[0].relation, root.sources[0].instruction]).toEqual([
            undefined,
            'callee',
            'li a0,0',
        ]);
        expect(root.use_pc).toBe(MAIN + 8);
    });

    test('caller argument', () => {
        const run = new Run()
            .block(MAIN, li(A0, 4))
            .jump(MAIN + 4, jal(RA, FOO - MAIN - 4), LinkKind.CALL, FOO);
        run.block(FOO, li(A1, 1)).fault(LOAD_FAULT, FOO + 4, lw(A4, A0, 0));
        const root = run.origin({ [A0]: 4 });
        expect(chain(root)).toEqual([[A0, 'set', MAIN, 4]]);
        expect(root.relation).toBe('caller');
    });

    test('walk lists each step once before its sources', () => {
        const run = new Run()
            .block(MAIN, li(A3, 1), li(A4, 2), add(A5, A3, A4))
            .fault(LOAD_FAULT, MAIN + 12, lw(A6, A5, 0));
        const root = run.origin({ [A5]: 3 });
        expect(chain(root)).toEqual([
            [A5, 'computed', MAIN + 8, 3],
            [A3, 'set', MAIN, 1],
            [A4, 'set', MAIN + 4, 2],
        ]);
        expect(new Set([...walkSteps(root)]).size).toBe(3);
    });

    test('a long chain ends at the step limit', () => {
        const run = new Run().block(MAIN, li(A5, 0));
        for (let n = 0; n < MAX_STEPS + 2; n++) {
            run.block(MAIN + 4 + 4 * n, addi(A5, A5, 4));
        }
        run.fault(LOAD_FAULT, MAIN + 4 * (MAX_STEPS + 3), lw(A4, A5, 0));
        const root = run.origin({});
        const steps = [...walkSteps(root)];
        expect(steps.length).toBe(MAX_STEPS + 1);
        expect([steps[steps.length - 1].kind, steps[steps.length - 1].stop]).toEqual(['unknown', 'steps']);
    });

    test('last loop pass and the passes before it', () => {
        const root = loop(3).origin({ [A5]: 12, [A6]: 12 });
        expect(chain(root)).toEqual([
            [A5, 'computed', MAIN + 8, 12],
            [A5, 'computed', MAIN + 8, 8],
            [A5, 'computed', MAIN + 8, 4],
            [A5, 'set', MAIN, 0],
        ]);
    });

    test('popret loads the bad return address cm.push saved', () => {
        /** A store to 12(sp) after cm.push {ra},-16 overwrites the saved ra, and cm.popret returns to it. */
        const [run, registers] = popret();
        const root = run.origin(registers);
        expect(chain(root)).toEqual([
            [RA, 'loaded', FOO + 10, 0x4],
            [A5, 'set', FOO + 2, 4],
        ]);
        expect([root.address, root.store_pc, root.store_instruction]).toEqual([STACK - 4, FOO + 6, 'sw a5,12(sp)']);
    });

    test('load from a stack slot goes on to its store', () => {
        const root = slot().origin({ [A5]: 4, [SP]: STACK });
        expect(chain(root)).toEqual([
            [A5, 'loaded', FOO + 12, 4],
            [A5, 'set', FOO + 4, 4],
        ]);
        expect([root.address, root.store_pc, root.store_instruction, root.crossed]).toEqual([
            STACK + 12,
            FOO + 8,
            'sw a5,12(sp)',
            [],
        ]);
        expect(root.sources[0].use_pc).toBe(FOO + 8);
    });

    test.each([
        [slot(sw(A6, SP, 8)), FOO + 8, 'other_slot'],
        [slot(li(A6, 4), sw(A6, SP, 12)), FOO + 16, 'same_slot_later'],
        [slot(sw(A6, A4, 0)), undefined, 'unknown_address'],
        [slot({ value: 5 }), undefined, 'other_value'],
    ])('stores between a load and its slot (%s)', (run, storePc) => {
        /** A store to an address the trace does not show could have written the slot, and so could one of another value. */
        const root = run.origin({ [A5]: 4, [SP]: STACK });
        expect([root.kind, root.address, root.store_pc]).toEqual(['loaded', STACK + 12, storePc]);
        expect(root.sources.length).toBe(storePc !== undefined ? 1 : 0);
    });

    test('constants are found without registers', () => {
        /** Values the code computes from constants are known, and a load through an unknown sp is not followed. */
        const [run] = calleeReturn();
        expect(chain(run.origin({}))).toEqual([
            [A5, 'copied', MAIN + 4, 0],
            [A0, 'set', FOO, 0],
        ]);
        const root = slot().origin({});
        expect(chain(root)).toEqual([[A5, 'loaded', FOO + 12, undefined]]);
        expect([root.address, root.store_pc]).toEqual([undefined, undefined]);
    });

    test.each([false, true])('stack adjustments are worked back to a constant (written_later=%s)', (writtenLater) => {
        /** sp is set, moved down twice and back up, then copied. The frame does not give sp at the copy. */
        const run = new Run()
            .block(MAIN, li(SP, 0x100), addi(SP, SP, -16), addi(SP, SP, -16), addi(SP, SP, 32), mv(A5, SP));
        if (writtenLater) {
            run.block(MAIN + 20, mv(SP, A0));
        }
        const pc = writtenLater ? MAIN + 24 : MAIN + 20;
        const root = run.fault(LOAD_FAULT, pc, lw(A4, A5, 0)).origin({});
        expect(chain(root)[0]).toEqual([A5, 'copied', MAIN + 16, 0x100]);
    });

    test.each(
        Array.from({ length: 10 }, (_, i) => MAX_VALUE_DEPTH - 8 + i)
    )('value beyond the depth of one source is found for another (length=%i)', (length) => {
        /** a1 adds a long chain to a0 and a2 copies a0. The walk of a1 reaches a0 too deep, a2 reaches it near the top. */
        const a2 = 12;
        const run = new Run().block(MAIN, li(A0, 0), addi(A0, A0, 1), addi(A0, A0, 1), addi(A0, A0, 1), mv(A1, A0));
        let pc = MAIN + 20;
        for (let n = 0; n < length; n++) {
            run.block(pc, addi(A1, A1, 1));
            pc += 4;
        }
        run.block(pc, mv(a2, A0), add(A5, A1, a2));
        run.fault(LOAD_FAULT, pc + 8, lw(A4, A5, 0));
        const root = run.origin({});
        const step = [...walkSteps(root)].find((s) => s.reg === a2);
        expect(step?.value).toBe(3);
    });

    test.each([false, true])('interrupt that returns to where it was taken is crossed (nested=%s)', (nested) => {
        const [run, registers] = interrupted(MAIN + 4, nested);
        const root = run.origin(registers);
        expect(chain(root)).toEqual([[A5, 'set', MAIN, 0]]);
        expect(root.crossed).toEqual(['interrupt']);
    });

    test('trap return to another task stops', () => {
        const [run, registers] = interrupted(OTHER);
        const root = run.origin(registers);
        expect(chain(root)).toEqual([[A5, 'unknown', undefined, 0]]);
        expect([root.stop, root.stop_pc]).toEqual(['context_switch', OTHER]);
    });

    test.each([true, false])('scheduler the image names stops the walk (named=%s)', (named) => {
        /** Tasks that yield through the same code are preempted at the same instruction, so another can resume there. */
        const [run, registers] = scheduled();
        if (!named) {
            run.code.names.delete(SCHEDULER);
        }
        const root = run.origin(registers);
        if (named) {
            expect([chain(root), root.stop, root.stop_pc]).toEqual([
                [[A5, 'unknown', undefined, 0]],
                'scheduler',
                MAIN + 4,
            ]);
        } else {
            expect([chain(root), root.crossed]).toEqual([[[A5, 'set', MAIN, 0]], ['interrupt']]);
        }
    });

    test('syscall result is not carried back past the ecall', () => {
        /** a5 copies a0 before an ecall whose handler returns 99 in a0, which the code then adds 1 to. */
        const run = new Run().block(MAIN, mv(A5, A0)).trap(M_ECALL, MAIN + 4).block(HANDLER, li(A0, 99));
        run.jump(HANDLER + 4, MRET, LinkKind.TRAP_RETURN, MAIN + 8).block(MAIN + 8, addi(A0, A0, 1));
        run.fault(LOAD_FAULT, MAIN + 12, lw(A4, A5, 0));
        const root = run.origin({ [A0]: 100 });
        expect(chain(root)).toEqual([
            [A5, 'copied', MAIN, undefined],
            [A0, 'unknown', undefined, undefined],
        ]);
    });
});

describe('native events', () => {
    test('callee saved register survives an untraced call', () => {
        let [run, registers] = untracedCall();
        let root = run.origin(registers);
        expect([chain(root), root.crossed]).toEqual([[[S0, 'set', MAIN, 8]], ['untraced_call']]);
        [run, registers] = untracedCall(A5);
        root = run.origin(registers);
        expect([root.kind, root.stop]).toEqual(['unknown', 'untraced']);
    });

    test.each([GapReason.TRACE_LOST, GapReason.PACKET_ERROR])('lost trace stops with the gap reason (%s)', (reason) => {
        const run = new Run()
            .block(MAIN, li(S0, 8))
            .add(gap(reason))
            .add(sync(MAIN + 4))
            .fault(LOAD_FAULT, MAIN + 4, lw(A4, S0, 0));
        const root = run.origin({ [S0]: 8 });
        expect([root.kind, root.stop, root.detail]).toEqual(['unknown', 'trace_lost', String(reason)]);
    });

    test('trace warning is crossed', () => {
        const run = new Run()
            .block(MAIN, li(A5, 0))
            .add({ event: 'warning', kind: 'note', detail: 'made up', provenance: undefined })
            .block(MAIN + 4, li(A6, 0));
        run.fault(LOAD_FAULT, MAIN + 8, lw(A4, A5, 0));
        const root = run.origin({ [A5]: 0 });
        expect([chain(root), root.crossed]).toEqual([[[A5, 'set', MAIN, 0]], ['trace_warning']]);
    });

    test.each([
        [undefined, 'missing'],
        [WIDE, 'wider_than_32_bits'],
    ])('code that cannot be read or decoded is unreadable (%s)', (word) => {
        const run = new Run().block(MAIN, li(A5, 0)).jump(MAIN + 4, word, LinkKind.NONE, MAIN + 8);
        run.fault(LOAD_FAULT, MAIN + 8, lw(A4, A5, 0));
        const root = run.origin({ [A5]: 0 });
        expect([root.kind, root.stop, root.stop_pc]).toEqual(['unknown', 'unreadable', MAIN + 4]);
        expect(windowOf(run.events, run.code).unsureWrites(MAIN + 4, MAIN + 8)).toBeUndefined();
    });

    test('image errors other than code read error end the query', () => {
        const [run, registers] = calleeReturn();
        const window = windowOf(run.events, new Failing(run.code));
        expect(() => window.origin(registers)).toThrow('image read failed');
        expect(() => window.unsureWrites(MAIN + 8, MAIN + 12)).toThrow('image read failed');
    });
});

describe('boundaries', () => {
    const builders: Array<[string, () => [Run, Record<number, number>]]> = [
        ['callee_return', calleeReturn],
        ['interrupt', () => interrupted()],
        ['nested', () => interrupted(MAIN + 4, true)],
        ['scheduler', scheduled],
        ['untraced_call', untracedCall],
        ['popret', popret],
        ['stack', stack],
        ['branches', branches],
    ];

    const queries: Record<string, (events: TraceEvent[], code: Code, registers: Record<number, number>) => unknown> = {
        origin: (events, code, registers) => windowOf(events, code).origin(registers),
        stackCalls: (events, code, registers) => windowOf(events, code).stackCalls(registers),
        branches: (events, code, registers) => windowOf(events, code).branches(inFoo),
    };

    test.each(builders)('boundaries do not change a walk (%s)', (_name, build) => {
        const [run, registers] = build();
        const expected = Object.fromEntries(
            Object.entries(queries).map(([name, query]) => [name, query(run.events, run.code, registers)])
        );
        expect(Object.values(expected).some((v) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true))).toBe(true);
        for (let at = 0; at <= run.events.length; at++) {
            const events = [
                ...run.events.slice(0, at),
                { event: 'boundary', kind: 'wrap', detail: '', provenance: undefined } as TraceBoundary,
                ...run.events.slice(at),
            ];
            const got = Object.fromEntries(
                Object.entries(queries).map(([name, query]) => [name, query(events, run.code, registers)])
            );
            expect(got).toEqual(expected);
        }
    });
});

describe('queries', () => {
    test('stack calls work the sp of each call back from the registers', () => {
        const [run, registers] = stack();
        const window = windowOf(run.events, run.code);
        expect(window.stackCalls(registers)).toEqual([{ pc: MAIN + 4, sp: STACK + 16 }]);
        expect(window.stackCalls({})).toEqual([]);
    });

    test('branches of the function the fault is in', () => {
        const [run] = branches();
        expect(windowOf(run.events, run.code).branches(inFoo)).toEqual([
            { pc: FOO, taken: true },
            { pc: FOO + 8, taken: false },
        ]);
    });

    test('branch to its fall through has the outcome the trace reports', () => {
        /** beq a5,a5,+4 goes on to the next instruction whether it jumps or not. */
        const run = new Run().jump(MAIN, jal(RA, FOO - MAIN), LinkKind.CALL, FOO);
        run.code.words.set(FOO, branch(0, A5, A5, 4));
        run.events.push({
            event: 'instruction',
            pc: FOO,
            length: 4,
            cls: InsnClass.BRANCH,
            branch_taken: true,
            next_pc: FOO + 4,
            provenance: undefined,
            inferred: false,
            link: LinkKind.NONE,
        });
        run.block(FOO + 4, addi(A5, A5, 1)).fault(STORE_FAULT, FOO + 8, sw(A5, A4, 0));
        expect(windowOf(run.events, run.code).branches(inFoo)).toEqual([{ pc: FOO, taken: true }]);
    });

    test('bus access index is its position in the events pushed', () => {
        const [run, registers] = busError();
        const boundary: TraceBoundary = { event: 'boundary', kind: 'wrap', detail: '', provenance: undefined };
        const events = [run.events[0], boundary, run.events[1], boundary, ...run.events.slice(2)];
        const window = windowOf(events, run.code);
        const access = window.busAccess(registers, 0x40, false);
        expect(access).toEqual({ pc: MAIN + 4, instruction: 'lw a4,0(a5)', index: 4 });
        expect(events[access!.index]).toBe(run.events[2]);
        const root = window.origin(registers, access);
        expect(root).toBeDefined();
        expect(chain(root!)).toEqual([[A5, 'set', MAIN, 0x40]]);
        expect(window.busAccess(registers, 0x40, true)).toBeUndefined();
    });

    test.each([
        [{ pc: MAIN + 4, instruction: 'lw a4,0(a5)', index: 3 }, 'boundary'],
        [{ pc: MAIN + 8, instruction: 'lw a4,0(a5)', index: 4 }, 'other_pc'],
        [{ pc: MAIN + 4, instruction: '', index: 99 }, 'out_of_range'],
    ])('access that is not in the events is rejected (%s)', (access) => {
        const [run, registers] = busError();
        const boundary: TraceBoundary = { event: 'boundary', kind: 'wrap', detail: '', provenance: undefined };
        const events = [run.events[0], boundary, run.events[1], boundary, ...run.events.slice(2)];
        expect(() => windowOf(events, run.code).origin(registers, access as BusAccess)).toThrow('is not the access');
    });

    test('unsure writes are those of the instructions up to saved mepc', () => {
        const run = new Run().block(MAIN, lw(A4, A5, 0), li(A6, 0)).fault(LOAD_FAULT, MAIN + 8);
        const window = windowOf(run.events, run.code);
        expect(window.unsureWrites(MAIN, MAIN + 4)).toEqual(new Set([A4]));
        expect(window.unsureWrites(MAIN, MAIN + 8)).toEqual(new Set([A4, A6]));
        expect(window.unsureWrites(MAIN, MAIN + 2)).toBeUndefined();
        expect(window.unsureWrites(MAIN, MAIN + 12)).toBeUndefined();
    });
});

describe('the window', () => {
    function endsLate(): Run {
        /** An ecall and an interrupt that both return, a load fault, then events after it. */
        const run = new Run().block(MAIN, li(A5, 0)).trap(8, MAIN + 4).block(HANDLER, li(A6, 0));
        run.jump(HANDLER + 4, MRET, LinkKind.TRAP_RETURN, MAIN + 8).trap(TIMER, MAIN + 8, true);
        run.jump(HANDLER + 8, MRET, LinkKind.TRAP_RETURN, MAIN + 8).fault(LOAD_FAULT, MAIN + 8, lw(A4, A5, 0));
        return run.block(HANDLER + 12, li(A5, 1)).fault(STORE_FAULT, HANDLER + 16, sw(A5, A5, 0));
    }

    test.each([
        [[], 7, 'fault'],
        [[TIMER], 5, 'panic_interrupt'],
    ])('window stops where history stops (end_interrupts=%j)', (endInterrupts, end) => {
        const run = endsLate();
        const history = new HistoryBuilder(run.code, new Set(endInterrupts as number[]));
        const builder = new FaultWindowBuilder(run.code, endInterrupts as number[]);
        for (const event of run.events) {
            history.push(event);
            builder.push(event);
            expect(builder.done).toBe(history.done);
        }
        const window = builder.close();
        expect(window.fault).toBe(run.events[end]);
        expect(window.complete).toBe(true);
        expect(window.origin({ [A5]: 0 }) === undefined).toBe(end === 5);
    });

    function filled(fill: number, boundaries = false, delayed = false): Run {
        /** a5 is set, then `fill` events of a loop, then a load through a5 faults. */
        const run = new Run().block(MAIN, li(A5, 0x40));
        run.code.words.set(MAIN + 0x100, addi(A6, A6, 1));
        run.code.words.set(MAIN + 0x104, branch(1, A6, A1, -4));
        const loopBody = [
            { event: 'instruction', pc: MAIN + 0x100, length: 4, cls: InsnClass.NONE, branch_taken: undefined, next_pc: MAIN + 0x104, provenance: undefined, inferred: false, link: LinkKind.NONE },
            { event: 'instruction', pc: MAIN + 0x104, length: 4, cls: InsnClass.NONE, branch_taken: undefined, next_pc: MAIN + 0x100, provenance: undefined, inferred: false, link: LinkKind.NONE },
        ] as TraceInstruction[];
        for (let n = 0; n < fill; n++) {
            run.add(
                boundaries && n % 10 === 9
                    ? ({ event: 'boundary', kind: 'wrap', detail: '', provenance: undefined } as TraceBoundary)
                    : loopBody[n % 2]
            );
        }
        if (delayed) {
            return run.block(MAIN + 4, lw(A4, A5, 0), li(A6, 0), li(A1, 0)).trap(LOAD_FAULT, MAIN + 16);
        }
        return run.fault(LOAD_FAULT, MAIN + 4, lw(A4, A5, 0));
    }

    test.each([
        [0, true, 'all'],
        [0, false, 'all'],
        [1, true, 'sync_dropped'],
        [1, false, 'sync_dropped'],
        [2, true, 'writer_dropped'],
        [2, false, 'writer_dropped'],
    ])('window keeps the last window events (extra=%i, found=%s, %s)', (extra, _foundFlag, foundName) => {
        const found = foundName === 'all' || foundName === 'sync_dropped';
        for (const boundaries of [false, true]) {
            const run = filled((1 << 15) - 3 + extra, boundaries);
            expect(run.events.length).toBe((1 << 15) + extra);
            const window = windowOf(run.events, run.code);
            const root = window.origin({});
            expect(root).toBeDefined();
            if (found) {
                expect(chain(root!)).toEqual([[A5, 'set', MAIN, 0x40]]);
            } else {
                expect([root!.kind, root!.stop]).toEqual(['unknown', 'window']);
            }
        }
    });

    test('bus access index is its position in the events kept', () => {
        const run = filled((1 << 15) + 100, true, true);
        const window = windowOf(run.events, run.code);
        const kept = run.events.slice(-(1 << 15));
        const registers = { [A5]: 0x40, [SP]: STACK };
        const access = window.busAccess(registers, 0x40, false);
        expect(access).toBeDefined();
        expect(kept[access!.index]).toBe(run.events[run.events.length - 4]);
        const root = window.origin(registers, access);
        expect(root).toBeDefined();
        expect([root!.reg, root!.kind, root!.stop]).toEqual([A5, 'unknown', 'window']);
        const boundary = kept.findIndex((e) => e.event === 'boundary');
        expect(() =>
            window.origin(registers, { pc: MAIN + 4, instruction: '', index: boundary } as BusAccess)
        ).toThrow('is not the access');
    });

    test('window without an end finds nothing', () => {
        const empty = new FaultWindowBuilder(new Code()).close();
        expect([empty.fault, empty.complete]).toEqual([undefined, true]);
        const [run, registers] = calleeReturn();
        const builder = new FaultWindowBuilder(run.code);
        for (const event of run.events.slice(0, -1)) {
            builder.push(event);
        }
        expect(builder.done).toBe(false);
        expect(windowOf(run.events, run.code).unsureWrites(MAIN + 4, MAIN + 8)).toEqual(new Set([A5]));
        for (const window of [empty, builder.close()]) {
            expect(window.origin(registers)).toBeUndefined();
            expect(window.busAccess(registers, 0, false)).toBeUndefined();
            expect(window.stackCalls({ [SP]: STACK })).toEqual([]);
            expect(window.branches(inFoo)).toEqual([]);
            expect(window.unsureWrites(MAIN + 4, MAIN + 8)).toBeUndefined();
        }
        const unended = filled(1 << 15);
        expect(windowOf(unended.events.slice(0, -1), unended.code).complete).toBe(false);
        // the trace stops at an interrupt that does not end the window, after calls that have not returned
        const [srun, sregisters] = stack();
        const trapIndex = srun.events.findIndex((e) => e.event === 'trap');
        const events = srun.events.slice(0, trapIndex + 1);
        expect(windowOf(events, srun.code, [TIMER]).stackCalls(sregisters).length).toBeGreaterThan(0);
        const window = windowOf(events, srun.code);
        expect(window.fault).toBeUndefined();
        expect(window.stackCalls(sregisters)).toEqual([]);
    });

    test('without an image no code is read', () => {
        const [run, registers] = stack();
        const window = windowOf(run.events, undefined);
        expect(window.fault).toBe(run.events[run.events.length - 1]);
        expect(window.origin(registers)).toBeUndefined();
        expect(window.stackCalls(registers)).toEqual([]);
        expect(window.branches(inFoo)).toEqual([]);
        expect(window.unsureWrites(FOO + 8, FOO + 12)).toBeUndefined();
    });

    test('query that raises leaves the window usable', () => {
        const [run, registers] = stack();
        const image = new Failing(run.code, false);
        const window = windowOf(run.events, image);
        const expected = [window.origin(registers), window.stackCalls(registers)];
        image.failing = true;
        expect(() => window.origin(registers)).toThrow();
        image.failing = false;

        const inside = (pc: number): boolean => {
            throw new Error('inside failed');
        };
        expect(() => window.branches(inside)).toThrow('inside failed');
        expect([window.origin(registers), window.stackCalls(registers)]).toEqual(expected);
    });

    test.each(['esp32c5', 'esp32c6', 'esp32s31'])('window of a capture ends with its history (%s)', (target) => {
        /** Core 0 of each capture takes an illegal instruction exception.

        The exception is in panic_abort, which has no conditional branch, and it depends on no register.
        */
        const fixtures = join(__dirname, '..', 'fixtures', 'trace');
        const session = openSession(join(fixtures, `${target}_coredump.elf`), {
            elfPath: join(fixtures, `${target}.elf`),
            warn: () => undefined,
        });
        const image = session.image;
        let faults = 0;
        for (const view of iterCores(session)) {
            const history = new HistoryBuilder(image);
            const builder = new FaultWindowBuilder(image);
            const pushed: TraceEvent[] = [];
            for (const event of view.events()) {
                history.push(event);
                builder.push(event);
                pushed.push(event);
                expect(builder.done).toBe(history.done);
                if (history.done) {
                    break;
                }
            }
            const window = builder.close();
            const closed = history.close();
            const fault = closed.fault;
            expect(window.fault === undefined).toBe(fault === undefined);
            if (window.fault === undefined || fault === undefined) {
                continue;
            }
            faults++;
            expect([window.fault.epc, window.fault.cause]).toEqual([fault.pc, fault.cause]);
            expect(window.complete).toBe(pushed.length <= (1 << 15));
            expect(window.origin({})).toBeUndefined();
            const calls = window.stackCalls({ [SP]: STACK });
            expect(calls.map((c) => c.pc)).toEqual(closed.stack.map((f) => f.pc));

            const faultName = image.symbolAt(window.fault.epc ?? 0);
            const inside = (pc: number): boolean => image.symbolAt(pc) === faultName;
            expect(window.branches(inside)).toEqual([]);
        }
        expect(faults).toBe(1);
    });
});
