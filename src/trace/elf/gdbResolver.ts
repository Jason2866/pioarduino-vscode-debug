// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// GDB `info line` fallback for source resolution when addr2line is unavailable.

import { spawn } from 'child_process';
import { PrefetchedResolver } from './addr2lineResolver';
import { SourceLocation } from './resolver';

const GDB_TIMEOUT_MS = 30_000;
const PC_MARKER_PREFIX = '__PC__=0x';
const LINE_INFO_RE = /^Line\s+(\d+)\s+of\s+"([^"]+)"/;

/**
 * Parse `info line *0x...` output grouped by `__PC__=0x...` echo markers.
 */
export function parseGdbInfoLineOutput(stdout: string): Map<number, SourceLocation> {
    const locations = new Map<number, SourceLocation>();
    let currentPc: number | undefined;

    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const markerIdx = line.indexOf(PC_MARKER_PREFIX);
        if (markerIdx !== -1) {
            const hex = line.slice(markerIdx + PC_MARKER_PREFIX.length).trim();
            const parsed = parseInt(hex, 16);
            currentPc = Number.isFinite(parsed) ? parsed : undefined;
            continue;
        }
        if (currentPc === undefined) {
            continue;
        }
        // Strip optional `(gdb) ` prompt prefix that may precede output on stdin-driven runs.
        const cleaned = line.replace(/^\(gdb\)\s*/, '');
        const match = LINE_INFO_RE.exec(cleaned);
        if (match) {
            const lineNum = parseInt(match[1], 10);
            if (Number.isFinite(lineNum) && !locations.has(currentPc)) {
                locations.set(currentPc, { file: match[2], line: lineNum });
            }
        }
    }

    return locations;
}

/**
 * Resolve every PC in `pcs` via `gdb -nx -q <elfPath>` using `info line *0x...`.
 * Used as a fallback when `addr2line` is unavailable or fails.
 */
export async function resolveSourceLinesWithGdb(
    pcs: Iterable<number>,
    gdbPath: string,
    elfPath: string,
    timeoutMs: number = GDB_TIMEOUT_MS
): Promise<PrefetchedResolver> {
    const unique = [...new Set(pcs)].sort((a, b) => a - b);
    if (!unique.length) {
        return new PrefetchedResolver(new Map());
    }

    const scriptLines: string[] = ['set pagination off', 'set confirm off'];
    for (const pc of unique) {
        const hex = (pc >>> 0).toString(16).padStart(8, '0');
        scriptLines.push(`echo ${PC_MARKER_PREFIX}${hex}\\n`);
        scriptLines.push(`info line *0x${hex}`);
    }
    scriptLines.push('quit');
    const script = scriptLines.join('\n') + '\n';

    const stdout = await new Promise<string>((resolve, reject) => {
        const proc = spawn(gdbPath, ['-nx', '-q', elfPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let out = '';
        let err = '';
        let settled = false;

        const finish = (error?: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (error) {
                reject(error);
            } else {
                resolve(out);
            }
        };

        const timer = setTimeout(() => {
            proc.kill();
            finish(new Error(`gdb timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.stdout?.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf-8');
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
            err += chunk.toString('utf-8');
        });
        proc.on('error', (error) => {
            finish(error);
        });
        proc.on('close', (code) => {
            if (code !== 0 && out.length === 0) {
                finish(new Error(err.trim() || `gdb exited with code ${code}`));
            } else {
                finish();
            }
        });

        proc.stdin?.end(script);
    });

    return new PrefetchedResolver(parseGdbInfoLineOutput(stdout));
}
