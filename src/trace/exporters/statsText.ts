// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/exporters/stats_text.py (Apache-2.0).
// Text exporter for trace statistics tables.

import { StatsSnapshot, UNRESOLVED_FILE, UNRESOLVED_LINE } from '../analysis/stats';
import { FUNCTION_COLUMN_WIDTH, oneLine } from './_format';

const PCT_FMT = (pct: number): string => pct.toFixed(2).padStart(6);
const COUNT_FMT = (count: number): string => String(count).padStart(6);

const HEADER_STATS = `#    pct  count  ${'function'.padEnd(FUNCTION_COLUMN_WIDTH)}  file:line`;
const HEADER_BLOCKS_TABLE = '#          count  entry_pc';

export function formatStats(
    snapshot: StatsSnapshot,
    opts: { top?: number; per_block?: boolean; label?: string } = {}
): string[] {
    /** Return the lines for one `StatsSnapshot` table. */
    const top = opts.top ?? 20;
    const perBlock = opts.per_block ?? false;
    const label = opts.label ?? '';
    if (top < 0) {
        throw new Error(`top must be >= 0, got ${top}`);
    }
    const lines: string[] = [];
    lines.push(statsHeaderMeta(snapshot, top, label));

    if (snapshot.total_instructions === 0) {
        lines.push('# no instructions retired, sample table is empty');
        return lines;
    }

    lines.push(HEADER_STATS);
    const ranked = rankSampleHits(snapshot);
    const topRows = ranked.slice(0, top);
    const functionsSeen: string[] = [];
    const seenSet = new Set<string>();
    for (const [key, count] of topRows) {
        const [func, fileName, line] = JSON.parse(key) as [string, string, number];
        const pct = (100.0 * count) / snapshot.total_instructions;
        lines.push(formatSampleRow(pct, count, func, fileName, line));
        if (!seenSet.has(func)) {
            seenSet.add(func);
            functionsSeen.push(func);
        }
    }

    const unresolved = snapshot.unresolved_pcs;
    if (unresolved.size) {
        const parts = [...unresolved.entries()]
            .filter(([, v]) => v > 0)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${k}=${v}`);
        if (parts.length) {
            lines.push(`#                   unresolved_pcs=${parts.join(', ')}`);
        }
    }

    if (perBlock) {
        lines.push(...formatBlockTables(snapshot, functionsSeen));
    }

    return lines;
}

function statsHeaderMeta(snapshot: StatsSnapshot, top: number, label: string): string {
    const div = snapshot.total_instructions;
    const labelPart = label ? `${oneLine(label)}  ` : '';
    return `# stats             ${labelPart}instructions=${snapshot.total_instructions}  denominator=${div}  top=${top}`;
}

function rankSampleHits(snapshot: StatsSnapshot): Array<readonly [string, number]> {
    return [...snapshot.sample_hits.entries()].sort((a, b) => {
        const ka = JSON.parse(a[0]) as [string, string, number];
        const kb = JSON.parse(b[0]) as [string, string, number];
        if (b[1] !== a[1]) {
            return b[1] - a[1];
        }
        for (let i = 0; i < 3; i++) {
            const x = ka[i];
            const y = kb[i];
            if (x !== y) {
                return x < y ? -1 : 1;
            }
        }
        return 0;
    });
}

function formatSampleRow(pct: number, count: number, func: string, fileName: string, line: number): string {
    const pctS = PCT_FMT(pct);
    const countS = COUNT_FMT(count);
    const funcRender = renderFunction(func);
    const fileRender = renderFileLine(fileName, line);
    const funcPadded = funcRender.padEnd(FUNCTION_COLUMN_WIDTH);
    return `  ${pctS} ${countS}  ${funcPadded}  ${fileRender}`;
}

function renderFunction(func: string): string {
    // Do not append parentheses to unresolved label placeholders.
    const safe = oneLine(func);
    if (safe.startsWith('<') && safe.endsWith('>')) {
        if (safe.length <= FUNCTION_COLUMN_WIDTH) {
            return safe;
        }
        return safe.slice(0, FUNCTION_COLUMN_WIDTH - 1) + '~';
    }
    const display = `${safe}()`;
    if (display.length <= FUNCTION_COLUMN_WIDTH) {
        return display;
    }
    return display.slice(0, FUNCTION_COLUMN_WIDTH - 1) + '~';
}

function renderFileLine(fileName: string, line: number): string {
    if (fileName === UNRESOLVED_FILE && line === UNRESOLVED_LINE) {
        return UNRESOLVED_FILE;
    }
    const safe = oneLine(fileName);
    if (line === UNRESOLVED_LINE) {
        return safe;
    }
    return `${safe}:${line}`;
}

function formatBlockTables(snapshot: StatsSnapshot, functionsSeen: string[]): string[] {
    const lines: string[] = [];
    const grouped = new Map<string, Array<readonly [number, number]>>();
    for (const [key, count] of snapshot.block_hits) {
        const [func, entryPc] = JSON.parse(key) as [string, number];
        let list = grouped.get(func);
        if (list === undefined) {
            list = [];
            grouped.set(func, list);
        }
        list.push([entryPc, count]);
    }
    if (!grouped.size) {
        return lines;
    }

    lines.push(`# blocks            distinct_entry_pcs=${snapshot.block_hits.size}`);
    const seen = new Set<string>();
    const orderedFunctions = functionsSeen.filter((f) => grouped.has(f));
    for (const func of orderedFunctions) {
        seen.add(func);
        lines.push(...formatOneFunctionBlocks(func, grouped.get(func)!));
    }
    for (const func of [...grouped.keys()].sort()) {
        if (seen.has(func)) {
            continue;
        }
        lines.push(...formatOneFunctionBlocks(func, grouped.get(func)!));
    }
    return lines;
}

function formatOneFunctionBlocks(func: string, entries: Array<readonly [number, number]>): string[] {
    const lines: string[] = [];
    lines.push(`# ${renderFunction(func)}`);
    lines.push(HEADER_BLOCKS_TABLE);
    const sorted = [...entries].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    for (const [entryPc, count] of sorted) {
        const countS = COUNT_FMT(count);
        lines.push(`          ${countS}  0x${entryPc.toString(16).padStart(8, '0')}`);
    }
    return lines;
}
