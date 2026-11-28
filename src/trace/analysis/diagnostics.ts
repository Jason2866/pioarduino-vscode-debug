// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/analysis/diagnostics.py (Apache-2.0).

import { GapReason } from '../decoder/reconstruct';
import { TraceCaptureNote } from '../ir/capture_note';
import {
    TraceBoundary,
    TraceEvent,
    TraceGap,
    TraceInstruction,
    TraceSync,
    TraceTrap,
    TraceWarning,
} from '../ir/events';
import { ResyncMode, enumName } from '../snapshot/abi';

export const DIAG_ROOT_NO_PCS_RECOVERED = 'no_pcs_recovered';

const HINT_RESYNC = 'enable packet resync in the encoder config';
const HINT_NO_SYNC_POINT = 'no synchronization point in this window. Capture a longer trace';

const TOP_GAP_REASONS = 3;
const TOP_REPEATED_GAPS = 5;
const REPEATED_GAP_MIN_COUNT = 2;

function topCounts(counts: Map<string, number>): Array<readonly [string, number]> {
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export interface TraceDiagnostic {
    instructions: number;
    syncs: number;
    traps: number;
    gaps: number;
    gap_reasons: Map<string, number>;
    top_gap_reasons: Array<readonly [string, number]>;
    root_cause: string | undefined;
    hint: string | undefined;
    repeated_gaps: Array<readonly [string, string, number]>;
    warnings: number;
    warning_reasons: Array<readonly [string, number]>;
    boundaries: number;
    boundary_kinds: Array<readonly [string, number]>;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
    map.set(key, (map.get(key) ?? 0) + by);
}

export class DiagnosticAccumulator {
    instructions = 0;
    syncs = 0;
    traps = 0;
    gaps = 0;
    warnings = 0;
    boundaries = 0;
    private gapReasons = new Map<string, number>();
    private warningReasons = new Map<string, number>();
    private boundaryKinds = new Map<string, number>();
    private lastGapReason: string | undefined;
    private isolatedGapDetails = new Map<string, Map<string, number>>();

    push(event: TraceEvent): void {
        if (event.event === 'instruction' || event.event === 'sync' || event.event === 'trap') {
            if (event.event === 'instruction') {
                this.instructions++;
            } else if (event.event === 'sync') {
                this.syncs++;
            } else {
                this.traps++;
            }
            this.lastGapReason = undefined;
        } else if (event.event === 'gap') {
            const gap = event as TraceGap;
            this.gaps++;
            bump(this.gapReasons, gap.reason);
            // Code outside the traced range runs often, as every call into ROM, and is no decoding problem
            if (gap.reason !== this.lastGapReason && gap.reason !== GapReason.UNTRACED) {
                let details = this.isolatedGapDetails.get(gap.reason);
                if (details === undefined) {
                    details = new Map<string, number>();
                    this.isolatedGapDetails.set(gap.reason, details);
                }
                bump(details, gap.detail);
            }
            this.lastGapReason = gap.reason;
        } else if (event.event === 'warning') {
            const warning = event as TraceWarning;
            this.warnings++;
            bump(this.warningReasons, warning.kind);
            this.lastGapReason = undefined;
        } else if (event.event === 'boundary') {
            const boundary = event as TraceBoundary;
            this.boundaries++;
            bump(this.boundaryKinds, boundary.kind);
            this.lastGapReason = undefined;
        }
    }

    close(note: TraceCaptureNote): TraceDiagnostic {
        const gapReasons = new Map(this.gapReasons);
        const top = topCounts(gapReasons).slice(0, TOP_GAP_REASONS);
        const repeated = this.repeatedGapsTop();
        const rootCause = this.pickRootCause();
        const hint = this.pickHint(rootCause, note);
        return {
            instructions: this.instructions,
            syncs: this.syncs,
            traps: this.traps,
            gaps: this.gaps,
            gap_reasons: gapReasons,
            top_gap_reasons: top,
            root_cause: rootCause,
            hint,
            repeated_gaps: repeated,
            warnings: this.warnings,
            warning_reasons: topCounts(this.warningReasons),
            boundaries: this.boundaries,
            boundary_kinds: topCounts(this.boundaryKinds),
        };
    }

    private repeatedGapsTop(): Array<readonly [string, string, number]> {
        const items: Array<readonly [string, string, number]> = [];
        for (const [reason, details] of this.isolatedGapDetails) {
            for (const [detail, count] of details) {
                if (count >= REPEATED_GAP_MIN_COUNT) {
                    items.push([reason, detail, count]);
                }
            }
        }
        items.sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
        return items.slice(0, TOP_REPEATED_GAPS);
    }

    private pickRootCause(): string | undefined {
        if (this.instructions === 0 && this.syncs === 0 && this.gaps > 0) {
            return DIAG_ROOT_NO_PCS_RECOVERED;
        }
        return undefined;
    }

    private pickHint(rootCause: string | undefined, note: TraceCaptureNote): string | undefined {
        if (rootCause !== DIAG_ROOT_NO_PCS_RECOVERED) {
            return undefined;
        }
        const disabled = enumName(ResyncMode, ResyncMode.DISABLED);
        const unknown = enumName(ResyncMode, ResyncMode.UNKNOWN);
        // Resync already on. A longer capture is the likely fix.
        if (note.resync_mode === disabled || note.resync_mode === unknown) {
            return HINT_RESYNC;
        }
        return HINT_NO_SYNC_POINT;
    }
}
