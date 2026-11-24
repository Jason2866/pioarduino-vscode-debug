// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Batched addr2line-backed SourceResolver. Analysis is synchronous, so PCs are
// collected first and resolved in one pass before the accumulators run.

import { PersistentAddr2line } from '../addr2lineResolver';
import { SourceLocation, SourceResolver } from './resolver';

/** Synchronous resolver over a pre-resolved PC -> location map. */
export class PrefetchedResolver implements SourceResolver {
    constructor(private readonly locations: ReadonlyMap<number, SourceLocation>) {}

    resolve(pc: number): SourceLocation | undefined {
        return this.locations.get(pc);
    }
}

/** Empty resolver: every lookup is unresolved. */
export class NullResolver implements SourceResolver {
    resolve(_pc: number): SourceLocation | undefined {
        return undefined;
    }
}

export const NULL_RESOLVER = new NullResolver();

/**
 * Resolve every PC in `pcs` through `addr2line -f -C -i -e elfPath` and return
 * a synchronous resolver. Addresses that addr2line cannot place are absent.
 */
export async function resolveSourceLines(
    pcs: Iterable<number>,
    addr2linePath: string,
    elfPath: string,
    pool?: PersistentAddr2line
): Promise<PrefetchedResolver> {
    const unique = [...new Set(pcs)].sort((a, b) => a - b);
    const locations = new Map<number, SourceLocation>();
    if (!unique.length) {
        return new PrefetchedResolver(locations);
    }
    const instance = pool ?? new PersistentAddr2line(addr2linePath, elfPath);
    const owned = pool === undefined;
    try {
        // Batch in chunks so one giant capture does not build one enormous request.
        const CHUNK = 8192;
        for (let i = 0; i < unique.length; i += CHUNK) {
            const chunk = unique.slice(i, i + CHUNK);
            const results = await instance.resolveBatch(chunk.map((pc) => `0x${pc.toString(16).padStart(8, '0')}`));
            for (const result of results) {
                const pc = parseInt(result.address, 16);
                if (result.file === undefined || result.line === undefined) {
                    continue;
                }
                const line = parseInt(result.line, 10);
                if (!Number.isFinite(line)) {
                    continue;
                }
                locations.set(pc, { file: result.file, line });
            }
        }
    } finally {
        if (owned) {
            instance.dispose();
        }
    }
    return new PrefetchedResolver(locations);
}
