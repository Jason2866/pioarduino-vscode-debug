// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/exporters/profile.py (Apache-2.0).
// Flame graph exporters for profiles: folded stacks and the speedscope file format.

import { Profile, profileStacks } from '../analysis/profile';
import { oneLine } from './_format';

export const SPEEDSCOPE_SCHEMA = 'https://www.speedscope.app/file-format-schema.json';
// Matches upstream esp_riscv_trace.__version__
const EXPORTER_VERSION = '0.3.0';

function frameName(name: string): string {
    // The folded format separates frames with semicolons
    return oneLine(name).replace(/;/g, ':');
}

export function formatFolded(profiles: Array<readonly [string | undefined, Profile]>): string[] {
    /** Return one `frame;frame;function count` line per stack, as FlameGraph and speedscope read. */
    const lines: string[] = [];
    for (const [root, profile] of profiles) {
        // Sort stacks like Python's tuple ordering: element-wise, shorter prefix first.
        const stacks = [...profileStacks(profile).entries()]
            .map(([key, count]) => [JSON.parse(key) as string[], count] as const)
            .sort((a, b) => compareStacks(a[0], b[0]));
        for (const [stack, count] of stacks) {
            const frames = root === undefined ? stack : [root, ...stack];
            lines.push(`${frames.map(frameName).join(';')} ${count}`);
        }
    }
    return lines;
}

function compareStacks(a: string[], b: string[]): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) {
            return a[i] < b[i] ? -1 : 1;
        }
    }
    return a.length - b.length;
}

export function profileToSpeedscope(
    profiles: Array<readonly [string, Profile]>,
    name: string
): Record<string, unknown> {
    /** Return a speedscope file with one sampled profile per named profile. */
    const frames: Array<{ name: string }> = [];
    const index = new Map<string, number>();

    const frameIds = (stack: string[]): number[] => {
        const ids: number[] = [];
        for (const frame of stack) {
            let id = index.get(frame);
            if (id === undefined) {
                id = frames.length;
                index.set(frame, id);
                frames.push({ name: frame });
            }
            ids.push(id);
        }
        return ids;
    };

    const out = profiles.map(([profileName, profile]) => ({
        type: 'sampled',
        name: profileName,
        unit: 'none',
        startValue: 0,
        endValue: profile.instructions,
        samples: profile.runs.map(([stack]) => frameIds(stack)),
        weights: profile.runs.map(([, count]) => count),
    }));
    return {
        $schema: SPEEDSCOPE_SCHEMA,
        name,
        exporter: `esp-riscv-trace ${EXPORTER_VERSION}`,
        activeProfileIndex: 0,
        shared: { frames },
        profiles: out,
    };
}
