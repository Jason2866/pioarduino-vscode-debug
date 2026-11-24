// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/exporters/_format.py (Apache-2.0).
// Formatting helpers shared by the text and stats exporters.

export const FUNCTION_COLUMN_WIDTH = 32;
const SHORT_SHA_CHARS = 16;

export function oneLine(s: string): string {
    /** Escape backslashes and line terminators so a value never breaks out of its row. */
    return s.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function oneLineQuoted(s: string): string {
    /** Return `oneLine(s)` with double quotes escaped too, for values written inside quotes. */
    return oneLine(s).replace(/"/g, '\\"');
}

export function shortSha(sha: Buffer | undefined): string {
    /** Return the first hex digits of `sha`, or `none`. */
    if (sha === undefined) {
        return 'none';
    }
    return sha.toString('hex').slice(0, SHORT_SHA_CHARS);
}

export function marker(body: string, prov: string): string {
    /** Return a `--- ... ---` event marker line, with provenance when there is one. */
    return prov ? `--- ${body} ${prov} ---` : `--- ${body} ---`;
}

/** Serialize like Python's `json.dumps` default separators (`, ` and `: `). */
export function pyJson(value: unknown): string {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (typeof value === 'number') {
        return Number.isInteger(value) ? String(value) : JSON.stringify(value);
    }
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(pyJson).join(', ')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`).join(', ')}}`;
}
