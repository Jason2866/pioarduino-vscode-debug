// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/elf/__init__.py SourceResolver contract (Apache-2.0).

export interface SourceLocation {
    file: string;
    line: number;
}

/** Source coordinates for program counters. */
export interface SourceResolver {
    resolve(pc: number): SourceLocation | undefined;
}
