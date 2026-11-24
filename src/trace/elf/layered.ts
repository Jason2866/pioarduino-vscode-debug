// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/elf/layered.py (Apache-2.0).
// Layered ELF view combining an application ELF with an optional ROM ELF.

import { CodeImage, CodeReadError } from './image';
import { SourceLocation, SourceResolver } from './resolver';

const ROM_SYMBOL_PREFIX = 'rom:';

export class LayeredImage implements CodeImage {
    /** App-first, ROM-fallback executable + symbol view. */
    constructor(
        private readonly app: CodeImage,
        private readonly rom?: CodeImage
    ) {}

    read(vaddr: number, size: number): Buffer {
        try {
            return this.app.read(vaddr, size);
        } catch (appErr) {
            if (!(appErr instanceof CodeReadError) || this.rom === undefined) {
                throw appErr;
            }
            try {
                return this.rom.read(vaddr, size);
            } catch {
                throw appErr;
            }
        }
    }

    symbolAt(vaddr: number): string | undefined {
        /** Return symbol name at vaddr, prefixed with `rom:` if from ROM. */
        const name = this.app.symbolAt(vaddr);
        if (name !== undefined) {
            return name;
        }
        if (this.rom === undefined) {
            return undefined;
        }
        const romName = this.rom.symbolAt(vaddr);
        return romName === undefined ? undefined : ROM_SYMBOL_PREFIX + romName;
    }

    dataAt(vaddr: number): string | undefined {
        /** Return the variable at vaddr in the application ELF, when it names variables. */
        return this.app.dataAt?.(vaddr);
    }
}

export class LayeredResolver implements SourceResolver {
    /** App-first, ROM-fallback source line resolver. */
    constructor(
        private readonly app: SourceResolver,
        private readonly rom?: SourceResolver
    ) {}

    resolve(pc: number): SourceLocation | undefined {
        const loc = this.app.resolve(pc);
        if (loc !== undefined) {
            return loc;
        }
        if (this.rom === undefined) {
            return undefined;
        }
        return this.rom.resolve(pc);
    }
}
