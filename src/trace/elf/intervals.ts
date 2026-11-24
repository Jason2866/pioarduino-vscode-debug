// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/elf/intervals.py (Apache-2.0).

/** Find the value of the latest-starting `[start, end)` interval that contains an address. */
export class IntervalIndex<V> {
    /** `intervals` must be sorted by start. For equal starts the later entry wins. */
    constructor(intervals: ReadonlyArray<readonly [number, number, V]>) {
        this.starts = intervals.map((i) => i[0]);
        this.ends = intervals.map((i) => i[1]);
        this.values = intervals.map((i) => i[2]);
        this.maxEndPrefix = [];
        let maxEnd = 0;
        for (const end of this.ends) {
            maxEnd = Math.max(maxEnd, end);
            this.maxEndPrefix.push(maxEnd);
        }
    }

    private readonly starts: number[];
    private readonly ends: number[];
    private readonly values: V[];
    private readonly maxEndPrefix: number[];

    get length(): number {
        return this.starts.length;
    }

    lookup(addr: number): V | undefined {
        let i = bisectRight(this.starts, addr) - 1;
        while (i >= 0) {
            if (addr < this.ends[i]) {
                return this.values[i];
            }
            // Stop once no earlier interval reaches addr
            if (i === 0 || this.maxEndPrefix[i - 1] <= addr) {
                return undefined;
            }
            i -= 1;
        }
        return undefined;
    }

    startBefore(addr: number): number | undefined {
        const i = bisectRight(this.starts, addr) - 1;
        return i >= 0 ? this.starts[i] : undefined;
    }
}

function bisectRight(arr: readonly number[], x: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (x < arr[mid]) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}
