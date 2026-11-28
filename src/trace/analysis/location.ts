// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/analysis/location.py (Apache-2.0).

import { CodeImage } from '../elf/image';
import { SourceLocation, SourceResolver } from '../elf/resolver';

export interface CodeLocation {
    /** Where a program counter is in the code. Fields the ELF files cannot resolve are undefined. */
    pc: number;
    function: string | undefined;
    file: string | undefined;
    line: number | undefined;
}

export function locate(
    pc: number,
    image: CodeImage | undefined,
    resolver: SourceResolver | undefined
): CodeLocation {
    /** Resolve `pc` to its function and source line, treating a failing lookup as unresolved. */
    let functionName: string | undefined;
    if (image !== undefined) {
        try {
            functionName = image.symbolAt(pc);
        } catch {
            functionName = undefined;
        }
    }
    let source: SourceLocation | undefined;
    if (resolver !== undefined) {
        try {
            source = resolver.resolve(pc);
        } catch {
            source = undefined;
        }
    }
    if (source === undefined) {
        return { pc, function: functionName, file: undefined, line: undefined };
    }
    return { pc, function: functionName, file: source.file, line: source.line };
}
