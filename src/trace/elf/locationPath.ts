// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Normalize and resolve DWARF / addr2line / GDB source file paths on disk.

import * as fs from 'fs';
import * as path from 'path';

const SYNTHETIC_MARKERS = new Set(['', '??', '<unresolved>', '<built-in>', '<command-line>']);
const SUFFIX_ANCHORS = ['src/', 'lib/', 'components/', 'main/', 'include/', 'test/'];

export function isSyntheticSourcePath(file: string): boolean {
    const trimmed = file.trim();
    return SYNTHETIC_MARKERS.has(trimmed) || (trimmed.startsWith('<') && trimmed.endsWith('>'));
}

function isAbsoluteAny(p: string): boolean {
    return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * Resolve a source file path emitted by DWARF / addr2line / GDB against local
 * `searchRoots` (e.g. workspace folder, build dir, ELF directory).
 */
export function resolveSourceFilePath(
    rawFile: string,
    searchRoots: readonly string[],
    exists: (p: string) => boolean = fs.existsSync
): string | undefined {
    const trimmed = rawFile.trim();
    if (isSyntheticSourcePath(trimmed)) {
        return undefined;
    }

    if (isAbsoluteAny(trimmed) && exists(trimmed)) {
        return trimmed;
    }

    const posix = trimmed.replace(/\\/g, '/');
    const roots = [...new Set(searchRoots.filter((r) => r && r.trim() !== ''))];

    for (const root of roots) {
        if (!isAbsoluteAny(posix)) {
            const candidate = path.resolve(root, posix);
            if (exists(candidate)) {
                return candidate;
            }
        }
    }

    // Try stripping a foreign build-machine prefix up to a known project directory,
    // preferring the longest (most specific) matching relative suffix first.
    const lower = posix.toLowerCase();
    const candidates: string[] = [];
    for (const anchor of SUFFIX_ANCHORS) {
        if (lower.startsWith(anchor)) {
            candidates.push(posix);
        }
        let searchFrom = 0;
        while (true) {
            const idx = lower.indexOf('/' + anchor, searchFrom);
            if (idx === -1) {
                break;
            }
            candidates.push(posix.slice(idx + 1));
            searchFrom = idx + 1;
        }
    }
    const uniqueCandidates = [...new Set(candidates)].sort((a, b) => b.length - a.length);
    for (const rel of uniqueCandidates) {
        for (const root of roots) {
            const candidate = path.resolve(root, rel);
            if (exists(candidate)) {
                return candidate;
            }
        }
    }

    return undefined;
}
