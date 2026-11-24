// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/exporters/history.py (Apache-2.0).
// Text and JSON exporters for the call history.

import {
    CodeLoop,
    History,
    HistoryEntry,
    HistoryItem,
    HistoryKind,
    HistoryLoop,
    causeName,
    iterEntries,
} from '../analysis/history';
import { CodeLocation, locate } from '../analysis/location';
import { CodeImage } from '../elf/image';
import { SourceResolver } from '../elf/resolver';
import { oneLine } from './_format';

const INDENT = '  ';
// Deeper lines are drawn at this depth, so a runaway recursion stays readable
const MAX_DRAWN_DEPTH = 32;
const OUTLINE_WIDTH = 72;
const UNTRACED = '<untraced>';
const UNKNOWN = '?';
const DATA = ' (data)';
const INFERRED = ' (untraced)';

interface Line {
    pc: number | undefined; // source line shown for this line
    instructions: number | undefined;
    depth: number;
    text: string;
}

export function formatHistory(
    history: History,
    image: CodeImage | undefined,
    resolver: SourceResolver | undefined,
    opts: { label: string }
): string[] {
    /** Return the call outline as text lines, oldest first. */
    const lines = [
        `# history           ${opts.label}  items=${history.items.length}  omitted=${history.omitted}  ` +
            `instructions=${history.instructions}`,
    ];
    const fault = history.fault;
    if (fault !== undefined) {
        lines.push(`# fault             ${faultSummary(fault, image)}`);
    }
    lines.push(`#         pc    insns  outline${' '.repeat(OUTLINE_WIDTH - 'outline'.length)}  source`);
    for (const line of outline(history.items, image, 0)) {
        lines.push(render(line, resolver));
    }
    return lines;
}

export function historyToDict(
    history: History,
    image: CodeImage | undefined,
    resolver: SourceResolver | undefined
): Record<string, unknown> {
    /** Return the history as JSON-ready data. Addresses are `0x`-prefixed hex strings. */
    const location = (pc: number | undefined): Record<string, unknown> | null => {
        if (pc === undefined) {
            return null;
        }
        const loc = locate(pc, image, resolver);
        return { function: loc.function, file: loc.file, line: loc.line };
    };

    const entry = (e: HistoryEntry): Record<string, unknown> => ({
        kind: e.kind,
        depth: e.depth,
        segment: e.segment,
        instructions: e.instructions,
        pc: hex(e.pc),
        target: hex(e.target),
        target_inferred: e.target_inferred,
        site: location(e.pc),
        dest: location(e.target),
        cause: e.cause ?? null,
        cause_name:
            e.cause !== undefined
                ? causeName(e.cause, e.kind === HistoryKind.INTERRUPT || e.interrupt)
                : null,
        tval: hex(e.tval),
        detail: e.detail || null,
    });

    const item = (i: HistoryItem): Record<string, unknown> => {
        if (isHistoryLoop(i)) {
            return {
                kind: 'loop',
                count: i.count,
                instructions: i.instructions,
                body: i.body.map(item),
            };
        }
        return entry(i);
    };

    return {
        omitted: history.omitted,
        instructions: history.instructions,
        fault: history.fault !== undefined ? entry(history.fault) : null,
        items: history.items.map(item),
    };
}

function* outline(items: HistoryItem[], image: CodeImage | undefined, extra: number): Generator<Line> {
    let i = 0;
    while (i < items.length) {
        const it = items[i];
        if (isHistoryLoop(it)) {
            const depth = Math.min(...[...iterEntries(it.body)].map((e) => e.depth)) + extra;
            yield { pc: undefined, instructions: it.instructions, depth, text: `loop x${it.count} {` };
            yield* outline(it.body as HistoryEntry[], image, extra + 1);
            yield { pc: undefined, instructions: undefined, depth, text: '}' };
            i++;
            continue;
        }
        const entry = it as HistoryEntry;
        const after = i + 1 < items.length ? items[i + 1] : undefined;
        if (entry.kind === HistoryKind.CALL && returnsAtOnce(entry, after)) {
            const pc = entry.pc !== undefined ? entry.pc : entry.target;
            yield { pc, instructions: entry.instructions, depth: entry.depth + extra, text: callee(entry, image) };
            i += 2;
            continue;
        }
        const [pc, text] = describe(entry, image);
        yield { pc, instructions: entry.instructions, depth: entry.depth + extra, text };
        i++;
    }
}

function returnsAtOnce(call: HistoryEntry, after: HistoryItem | undefined): boolean {
    return (
        after !== undefined &&
        !isHistoryLoop(after) &&
        after.kind === HistoryKind.RETURN &&
        after.depth === call.depth &&
        after.segment === call.segment &&
        !after.detail
    );
}

function describe(e: HistoryEntry, image: CodeImage | undefined): [number | undefined, string] {
    /** Return the PC whose source line the entry shows, and its outline text. */
    const kind = e.kind;
    if (kind === HistoryKind.START) {
        return [e.target, `start in ${functionAt(e.target, image)}`];
    }
    if (kind === HistoryKind.CALL) {
        return [e.pc !== undefined ? e.pc : e.target, `${callee(e, image)} {`];
    }
    if (kind === HistoryKind.RETURN) {
        let text = `} ${functionAt(e.pc, image)}`;
        const pc = e.target !== undefined ? e.target : e.pc;
        if (e.detail) {
            text = `${text}  !! ${e.detail}`;
        }
        return [pc, text];
    }
    if (kind === HistoryKind.TAIL_CALL) {
        return [e.pc, `~> ${functionAt(e.target, image)}`];
    }
    if (kind === HistoryKind.INTERRUPT) {
        return [e.pc, `interrupt ${e.cause} in ${functionAt(e.pc, image)} {`];
    }
    if (kind === HistoryKind.ECALL) {
        return [e.pc, `ecall in ${functionAt(e.pc, image)} {`];
    }
    if (kind === HistoryKind.TRAP_RETURN) {
        if (e.detail) {
            return [e.target, `mret to ${functionAt(e.target, image)}  (${e.detail})`];
        }
        return [e.target, '} mret'];
    }
    if (kind === HistoryKind.CONTEXT_SWITCH) {
        let text = `<~ switch to ${functionAt(e.target, image)}`;
        if (e.detail) {
            text = `${text}  (${e.detail})`;
        }
        return [e.target, text];
    }
    if (kind === HistoryKind.FAULT) {
        return [e.pc, `!! ${faultSummary(e, image)}`];
    }
    return [undefined, `-- gap ${e.detail}`];
}

function faultSummary(e: HistoryEntry, image: CodeImage | undefined): string {
    const name = e.cause !== undefined ? causeName(e.cause, e.interrupt) : 'fault';
    const tval = e.tval !== undefined ? `  tval=${hex(e.tval)}` : '';
    const epc = e.pc !== undefined ? `  epc=${hex(e.pc)}` : '';
    return `${name} in ${functionAt(e.pc, image)}${epc}${tval}`;
}

function render(line: Line, resolver: SourceResolver | undefined): string {
    const pc = line.pc !== undefined ? `0x${line.pc.toString(16).padStart(8, '0')}` : '';
    const count = line.instructions !== undefined ? String(line.instructions) : '';
    const outline = INDENT.repeat(Math.min(line.depth, MAX_DRAWN_DEPTH)) + oneLine(line.text);
    let source = '';
    if (line.pc !== undefined) {
        const loc = locate(line.pc, undefined, resolver);
        if (loc.file !== undefined) {
            source = oneLine(`${loc.file}:${loc.line}`);
        }
    }
    let row = `${pc.padStart(10)}  ${count.padStart(7)}  ${outline}`;
    if (source) {
        row = row.padEnd(10 + 2 + 7 + 2 + OUTLINE_WIDTH) + `  ${source}`;
    }
    return row.trimEnd();
}

function functionAt(pc: number | undefined, image: CodeImage | undefined): string {
    /** The function at `pc`, or the variable code runs in there, as `s_buf (data)`. */
    if (pc === undefined) {
        return UNTRACED;
    }
    const loc: CodeLocation = locate(pc, image, undefined);
    if (loc.function) {
        return loc.function;
    }
    let variable: string | undefined;
    try {
        variable = image?.dataAt?.(pc);
    } catch {
        variable = undefined;
    }
    return variable ? variable + DATA : UNKNOWN;
}

function callee(call: HistoryEntry, image: CodeImage | undefined): string {
    /** Where a call goes, as `foo()`, or as the variable when it goes into data. */
    const name = functionAt(call.target, image);
    const text = name.endsWith(DATA) ? name : `${name}()`;
    return call.target_inferred ? text + INFERRED : text;
}

function hex(value: number | undefined): string | null {
    return value !== undefined ? `0x${value.toString(16).padStart(8, '0')}` : null;
}

function isHistoryLoop(item: HistoryItem): item is HistoryLoop {
    return 'body' in item;
}
