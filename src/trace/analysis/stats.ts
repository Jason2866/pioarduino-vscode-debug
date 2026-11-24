// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/analysis/stats.py (Apache-2.0).

import { CodeImage } from '../elf/image';
import { SourceResolver } from '../elf/resolver';
import {
    InsnClass,
    TraceEvent,
    TraceGap,
    TraceInstruction,
    TraceSync,
    TraceTrap,
} from '../ir/events';

export const UNRESOLVED_FILE = '<unresolved>';
export const UNRESOLVED_LINE = 0;

export function unresolvedFunctionLabel(pc: number): string {
    /** Return the placeholder label used when no symbol covers pc. */
    return `<0x${pc.toString(16).padStart(8, '0')}:unresolved>`;
}

const TERMINATOR_CLASSES = new Set<InsnClass>([
    InsnClass.BRANCH,
    InsnClass.JUMP,
    InsnClass.UNINFERABLE,
    InsnClass.TRAP,
]);

export interface StatsSnapshot {
    /** (function, file, line) -> hits */
    sample_hits: Map<string, number>;
    /** (function, pc) -> hits */
    block_hits: Map<string, number>;
    unresolved_pcs: Map<string, number>;
    total_instructions: number;
}

export class StatsAccumulator {
    private image: CodeImage;
    private resolver: SourceResolver;
    private sampleHits = new Map<string, number>();
    private blockHits = new Map<string, number>();
    private unresolved = new Map<string, number>();
    private totalInstructions = 0;
    private inBlock = false;

    constructor(image: CodeImage, resolver: SourceResolver) {
        this.image = image;
        this.resolver = resolver;
    }

    push(event: TraceEvent): void {
        if (event.event === 'instruction') {
            this.pushInsn(event);
        } else if (event.event === 'sync' || event.event === 'trap' || event.event === 'gap') {
            this.inBlock = false;
        }
    }

    close(): StatsSnapshot {
        return {
            sample_hits: new Map(this.sampleHits),
            block_hits: new Map(this.blockHits),
            unresolved_pcs: new Map(this.unresolved),
            total_instructions: this.totalInstructions,
        };
    }

    private pushInsn(event: TraceInstruction): void {
        const pc = event.pc;
        let functionName = this.image.symbolAt(pc);
        if (functionName === undefined) {
            functionName = unresolvedFunctionLabel(pc);
            this.unresolved.set('function', (this.unresolved.get('function') ?? 0) + 1);
        }

        const loc = this.resolver.resolve(pc);
        let fileName: string;
        let line: number;
        if (loc === undefined) {
            fileName = UNRESOLVED_FILE;
            line = UNRESOLVED_LINE;
            this.unresolved.set('line', (this.unresolved.get('line') ?? 0) + 1);
        } else {
            fileName = loc.file;
            line = loc.line;
        }

        // JSON tuple keys keep the (function, file, line) shape of upstream's Counter keys
        const key = JSON.stringify([functionName, fileName, line]);
        this.sampleHits.set(key, (this.sampleHits.get(key) ?? 0) + 1);
        this.totalInstructions++;

        if (!this.inBlock) {
            const blockKey = JSON.stringify([functionName, pc]);
            this.blockHits.set(blockKey, (this.blockHits.get(blockKey) ?? 0) + 1);
        }

        this.inBlock = !TERMINATOR_CLASSES.has(event.cls);
    }
}

export function mergeStatsSnapshots(snapshots: Iterable<StatsSnapshot>): StatsSnapshot {
    const sample = new Map<string, number>();
    const block = new Map<string, number>();
    const unresolved = new Map<string, number>();
    let total = 0;
    for (const snap of snapshots) {
        for (const [k, v] of snap.sample_hits) {
            sample.set(k, (sample.get(k) ?? 0) + v);
        }
        for (const [k, v] of snap.block_hits) {
            block.set(k, (block.get(k) ?? 0) + v);
        }
        for (const [k, v] of snap.unresolved_pcs) {
            unresolved.set(k, (unresolved.get(k) ?? 0) + v);
        }
        total += snap.total_instructions;
    }
    return { sample_hits: sample, block_hits: block, unresolved_pcs: unresolved, total_instructions: total };
}
