import {
    InsnClass,
    LinkKind,
    TraceEvent,
    TraceGap,
    TraceInstruction,
    TraceSync,
    TraceTrap,
} from '../../src/trace/ir/events';
import { CodeImage } from '../../src/trace/elf/image';
import { SourceLocation, SourceResolver } from '../../src/trace/elf/resolver';
import {
    mergeStatsSnapshots,
    StatsAccumulator,
    StatsSnapshot,
    UNRESOLVED_FILE,
    UNRESOLVED_LINE,
    unresolvedFunctionLabel,
} from '../../src/trace/analysis/stats';

class FakeImage implements CodeImage {
    constructor(private readonly symbols: Map<number, string> = new Map()) {}
    read(): Buffer {
        throw new Error('not implemented');
    }
    symbolAt(vaddr: number): string | undefined {
        return this.symbols.get(vaddr);
    }
}

class FakeResolver implements SourceResolver {
    constructor(private readonly locs: Map<number, SourceLocation> = new Map()) {}
    resolve(pc: number): SourceLocation | undefined {
        return this.locs.get(pc);
    }
}

const key = (fn: string, file: string, line: number) => JSON.stringify([fn, file, line]);
const blockKey = (fn: string, pc: number) => JSON.stringify([fn, pc]);

function acc(symbols?: Map<number, string>, locs?: Map<number, SourceLocation>): StatsAccumulator {
    return new StatsAccumulator(new FakeImage(symbols), new FakeResolver(locs));
}

function inst(pc: number, cls: InsnClass = InsnClass.NONE, nextPc?: number): TraceInstruction {
    return {
        event: 'instruction',
        pc,
        length: 4,
        cls,
        branch_taken: cls === InsnClass.BRANCH ? false : undefined,
        next_pc: nextPc ?? pc + 4,
        provenance: undefined,
        inferred: false,
        link: LinkKind.NONE,
    };
}

const sync = (): TraceSync => ({ event: 'sync', pc: 0x2000, privilege: 1, provenance: undefined });
const trap = (): TraceTrap => ({
    event: 'trap',
    cause: 11,
    interrupt: false,
    handler_pc: undefined,
    interrupted_pc: undefined,
    tval: undefined,
    provenance: undefined,
    epc: undefined,
});
const gap = (): TraceGap => ({ event: 'gap', reason: 'walker_not_anchored', detail: 'd', provenance: undefined });

describe('StatsAccumulator', () => {
    test('close on empty stream returns a zero snapshot', () => {
        const snap = acc().close();
        expect(snap.total_instructions).toBe(0);
        expect(snap.sample_hits.size).toBe(0);
        expect(snap.block_hits.size).toBe(0);
        expect(snap.unresolved_pcs.size).toBe(0);
    });

    test('snapshot counters are copies', () => {
        const a = acc(new Map([[0x1000, 'main']]), new Map([[0x1000, { file: 'main.c', line: 1 }]]));
        a.push(inst(0x1000));
        const snap = a.close();
        snap.sample_hits.set('evil', 999);
        a.push(inst(0x1000));
        expect(a.close().sample_hits.has('evil')).toBe(false);
    });

    test('resolved instruction populates a sample hit', () => {
        const a = acc(new Map([[0x1000, 'main']]), new Map([[0x1000, { file: 'main.c', line: 42 }]]));
        a.push(inst(0x1000));
        const snap = a.close();
        expect(snap.sample_hits.get(key('main', 'main.c', 42))).toBe(1);
        expect(snap.unresolved_pcs.size).toBe(0);
        expect(snap.total_instructions).toBe(1);
    });

    test('unresolved function uses the per-pc label', () => {
        const a = acc(undefined, new Map([[0x1000, { file: 'main.c', line: 42 }]]));
        a.push(inst(0x1000));
        const snap = a.close();
        const label = unresolvedFunctionLabel(0x1000);
        expect(label).toBe('<0x00001000:unresolved>');
        expect(snap.sample_hits.get(key(label, 'main.c', 42))).toBe(1);
        expect(snap.unresolved_pcs.get('function')).toBe(1);
        expect(snap.unresolved_pcs.get('line')).toBeUndefined();
    });

    test('distinct unresolved pcs stay on distinct rows', () => {
        const a = acc(
            undefined,
            new Map([
                [0x1000, { file: 'main.c', line: 42 }],
                [0x2000, { file: 'main.c', line: 43 }],
            ])
        );
        a.push(inst(0x1000));
        a.push(inst(0x2000));
        const snap = a.close();
        expect(snap.sample_hits.get(key(unresolvedFunctionLabel(0x1000), 'main.c', 42))).toBe(1);
        expect(snap.sample_hits.get(key(unresolvedFunctionLabel(0x2000), 'main.c', 43))).toBe(1);
        expect(snap.unresolved_pcs.get('function')).toBe(2);
    });

    test('unresolved line uses the sentinel', () => {
        const a = acc(new Map([[0x1000, 'main']]));
        a.push(inst(0x1000));
        const snap = a.close();
        expect(snap.sample_hits.get(key('main', UNRESOLVED_FILE, UNRESOLVED_LINE))).toBe(1);
        expect(snap.unresolved_pcs.get('line')).toBe(1);
        expect(snap.unresolved_pcs.get('function')).toBeUndefined();
    });

    test('both unresolved counts both reasons independently', () => {
        const snap = acc().close();
        const a = acc();
        a.push(inst(0x1000));
        const s = a.close();
        expect(s.unresolved_pcs.get('function')).toBe(1);
        expect(s.unresolved_pcs.get('line')).toBe(1);
        expect(snap.total_instructions).toBe(0);
    });

    test('denominator is total instructions, not distinct rows', () => {
        const a = acc(new Map([[0x1000, 'main']]), new Map([[0x1000, { file: 'm.c', line: 1 }]]));
        for (let i = 0; i < 5; i++) {
            a.push(inst(0x1000));
        }
        const snap = a.close();
        expect(snap.total_instructions).toBe(5);
        expect([...snap.sample_hits.values()].reduce((x, y) => x + y, 0)).toBe(5);
        expect(snap.sample_hits.size).toBe(1);
    });

    test('first instruction starts the first fragment', () => {
        const a = acc(new Map([[0x1000, 'main']]));
        a.push(inst(0x1000));
        expect(a.close().block_hits.get(blockKey('main', 0x1000))).toBe(1);
    });

    test('consecutive non-terminators are one fragment', () => {
        const a = acc(
            new Map([
                [0x1000, 'main'],
                [0x1004, 'main'],
                [0x1008, 'main'],
            ])
        );
        for (const pc of [0x1000, 0x1004, 0x1008]) {
            a.push(inst(pc));
        }
        const hits = a.close().block_hits;
        expect(hits.size).toBe(1);
        expect(hits.get(blockKey('main', 0x1000))).toBe(1);
    });

    test.each([
        [InsnClass.BRANCH, 0x1004, 'main'],
        [InsnClass.JUMP, 0x2000, 'target'],
        [InsnClass.UNINFERABLE, 0x2000, 'callee'],
        [InsnClass.TRAP, 0x2000, 'handler'],
    ])('terminator class %i ends the fragment', (cls, nextPc, nextName) => {
        const a = acc(
            new Map([
                [0x1000, 'main'],
                [nextPc as number, nextName as string],
            ])
        );
        a.push(inst(0x1000, cls as InsnClass, nextPc as number));
        a.push(inst(nextPc as number));
        const hits = a.close().block_hits;
        expect(hits.get(blockKey('main', 0x1000))).toBe(1);
        expect(hits.get(blockKey(nextName as string, nextPc as number))).toBe(1);
    });

    test.each([
        ['sync', sync],
        ['trap', trap],
        ['gap', gap],
    ])('%s event ends the fragment', (_name, make) => {
        const a = acc(
            new Map([
                [0x1000, 'main'],
                [0x1004, 'main'],
            ])
        );
        a.push(inst(0x1000));
        a.push(make() as TraceEvent);
        a.push(inst(0x1004));
        const hits = a.close().block_hits;
        expect(hits.get(blockKey('main', 0x1000))).toBe(1);
        expect(hits.get(blockKey('main', 0x1004))).toBe(1);
    });

    test('block hits key is function and entry pc', () => {
        const a = acc(new Map([[0x1000, 'main']]));
        a.push(inst(0x1000));
        for (const k of a.close().block_hits.keys()) {
            const parsed = JSON.parse(k);
            expect(typeof parsed[0]).toBe('string');
            expect(typeof parsed[1]).toBe('number');
        }
    });

    test('repeated fragment execution counts up', () => {
        const a = acc(new Map([[0x1000, 'main']]));
        a.push(inst(0x1000, InsnClass.JUMP));
        a.push(inst(0x1000, InsnClass.JUMP));
        expect(a.close().block_hits.get(blockKey('main', 0x1000))).toBe(2);
    });

    test('unresolved function appears in block hits', () => {
        const a = acc();
        a.push(inst(0x1000));
        expect(a.close().block_hits.get(blockKey(unresolvedFunctionLabel(0x1000), 0x1000))).toBe(1);
    });

    test.each([
        ['sync', sync],
        ['trap', trap],
        ['gap', gap],
    ])('%s alone does not touch counters', (_n, make) => {
        const a = acc();
        a.push(make() as TraceEvent);
        const snap = a.close();
        expect(snap.sample_hits.size).toBe(0);
        expect(snap.unresolved_pcs.size).toBe(0);
        expect(snap.total_instructions).toBe(0);
    });

    test('two accumulators do not share state', () => {
        const a = acc(new Map([[0x1000, 'main']]));
        const b = acc(new Map([[0x2000, 'other']]));
        a.push(inst(0x1000));
        b.push(inst(0x2000));
        expect(a.close().total_instructions).toBe(1);
        expect(b.close().total_instructions).toBe(1);
    });
});

describe('mergeStatsSnapshots', () => {
    function snap(sample: [string, number][], block: [string, number][], unresolved: [string, number][], total: number): StatsSnapshot {
        return {
            sample_hits: new Map(sample),
            block_hits: new Map(block),
            unresolved_pcs: new Map(unresolved),
            total_instructions: total,
        };
    }

    test('merges counters and sums totals', () => {
        const merged = mergeStatsSnapshots([
            snap([[key('a', 'f.c', 1), 2]], [[blockKey('a', 0x1000), 1]], [['function', 1]], 2),
            snap(
                [
                    [key('a', 'f.c', 1), 3],
                    [key('b', 'g.c', 2), 1],
                ],
                [[blockKey('a', 0x1000), 4]],
                [['line', 2]],
                4
            ),
        ]);
        expect(merged.sample_hits.get(key('a', 'f.c', 1))).toBe(5);
        expect(merged.sample_hits.get(key('b', 'g.c', 2))).toBe(1);
        expect(merged.block_hits.get(blockKey('a', 0x1000))).toBe(5);
        expect(merged.unresolved_pcs.get('function')).toBe(1);
        expect(merged.unresolved_pcs.get('line')).toBe(2);
        expect(merged.total_instructions).toBe(6);
    });

    test('empty iterable yields an empty snapshot', () => {
        const merged = mergeStatsSnapshots([]);
        expect(merged.total_instructions).toBe(0);
        expect(merged.sample_hits.size).toBe(0);
    });
});
