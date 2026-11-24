// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/elf/image.py (Apache-2.0).
// ELF executable-code and symbol view. DWARF/source resolution is layered on top later.

import * as fs from 'fs';
import * as crypto from 'crypto';
import { TraceError } from '../errors';
import { IntervalIndex } from './intervals';
import {
    PT_LOAD,
    SHF_EXECINSTR,
    SHN_ABS,
    SHT_DYNSYM,
    SHT_SYMTAB,
    STT_FUNC,
    STT_NOTYPE,
    STT_OBJECT,
    ElfSectionHeader,
    ElfSymbol,
    elfSymbolName,
    elfStringTable,
    elfSymbols,
    parseElfProgramHeaders,
    parseElfSections,
} from './core';

export class CodeReadError extends TraceError {}
export class ElfImageError extends TraceError {}

/** Read-only view of executable bytes addressed by virtual address. */
export interface CodeImage {
    read(vaddr: number, size: number): Buffer;
    /** Name of the STT_FUNC covering `vaddr`, or undefined. */
    symbolAt(vaddr: number): string | undefined;
    /** Variable at `vaddr` as `name` or `name+offset`, or undefined. */
    dataAt?(vaddr: number): string | undefined;
}

interface ExecRegion {
    vaddr: number;
    size: number;
    data: Buffer;
}

const PF_X = 0x1;
const SYMBOL_CACHE_SIZE = 4096;

export class ElfImage implements CodeImage {
    private readonly bytes: Buffer;
    private readonly regions: ExecRegion[] = [];
    private regionStarts: number[] = [];
    private sha256Digest: Buffer | undefined;
    private sections: ElfSectionHeader[] = [];
    private symbols: IntervalIndex<string> = new IntervalIndex<string>([]);
    private labels: Array<readonly [number, number, string]> = [];
    private labelStarts: number[] = [];
    private objects: { starts: number[]; entries: Array<readonly [number, number, string]> } = {
        starts: [],
        entries: [],
    };
    private symbolCache = new Map<number, string | undefined>();
    private allSymbols: ElfSymbol[] = [];

    constructor(readonly path: string) {
        try {
            this.bytes = fs.readFileSync(path);
        } catch {
            throw new ElfImageError(`cannot open ELF ${path}`);
        }
        let elf;
        try {
            // Headers only: parseElfCoreFile would copy every PT_LOAD payload
            // and parse notes that an executable image never uses.
            elf = parseElfProgramHeaders(this.bytes);
            this.sections = parseElfSections(this.bytes).sections;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ElfImageError(`cannot parse ELF ${path}: ${message}`);
        }
        try {
            for (const ph of elf.programHeaders) {
                if (ph.p_type !== PT_LOAD || !(ph.p_flags & PF_X)) {
                    continue;
                }
                const covered = Math.min(ph.p_filesz, ph.p_memsz);
                if (covered === 0) {
                    continue;
                }
                const start = ph.p_offset;
                const data = this.bytes.subarray(start, start + covered);
                if (data.length !== covered) {
                    throw new ElfImageError(
                        `executable segment at 0x${ph.p_vaddr.toString(16)} is truncated (got ${data.length} bytes, expected ${covered})`
                    );
                }
                this.regions.push({ vaddr: ph.p_vaddr, size: covered, data: Buffer.from(data) });
            }
            this.regions.sort((a, b) => a.vaddr - b.vaddr);
            for (let i = 0; i < this.regions.length - 1; i++) {
                const end = this.regions[i].vaddr + this.regions[i].size;
                if (end > this.regions[i + 1].vaddr) {
                    throw new ElfImageError(
                        `overlapping executable segments at 0x${this.regions[i + 1].vaddr.toString(16)}`
                    );
                }
            }
            this.regionStarts = this.regions.map((r) => r.vaddr);
            this.loadSymbols();
            this.labels = this.loadLabels();
            this.labelStarts = this.labels.map((l) => l[0]);
            this.loadObjects();
        } catch (error) {
            if (error instanceof ElfImageError) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new ElfImageError(`cannot parse ELF ${path}: ${message}`);
        }
    }

    sha256(): Buffer {
        if (this.sha256Digest === undefined) {
            this.sha256Digest = crypto.createHash('sha256').update(this.bytes).digest();
        }
        // Callers must not be able to mutate the cached digest.
        return Buffer.from(this.sha256Digest);
    }

    /** Return `size` bytes from executable memory at `vaddr`. */
    read(vaddr: number, size: number): Buffer {
        if (size <= 0) {
            throw new CodeReadError(`non-positive size ${size}`);
        }
        if (this.regions.length === 0) {
            throw new CodeReadError(`vaddr 0x${vaddr.toString(16)} out of range, ELF has no executable segments`);
        }
        // binary search: last region with vaddr <= address
        let lo = 0;
        let hi = this.regionStarts.length - 1;
        let idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.regionStarts[mid] <= vaddr) {
                idx = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (idx < 0) {
            throw new CodeReadError(`vaddr 0x${vaddr.toString(16)}+${size} below first executable segment`);
        }
        const region = this.regions[idx];
        if (vaddr < region.vaddr || vaddr + size > region.vaddr + region.size) {
            throw new CodeReadError(
                `vaddr 0x${vaddr.toString(16)}+${size} not fully inside executable segment ` +
                    `[0x${region.vaddr.toString(16)}, 0x${(region.vaddr + region.size).toString(16)})`
            );
        }
        const off = vaddr - region.vaddr;
        // Copy: region.data is shared with the ELF bytes, and a caller mutating
        // the result must not change later reads.
        return Buffer.from(region.data.subarray(off, off + size));
    }

    /** Return the name of the STT_FUNC that covers `vaddr`, or undefined. */
    symbolAt(vaddr: number): string | undefined {
        return this.lookupSymbol(vaddr);
    }

    /** Return the variable at `vaddr`, as `name` or `name+offset`, or undefined. */
    dataAt(vaddr: number): string | undefined {
        const { starts, entries } = this.objects;
        let lo = 0;
        let hi = starts.length - 1;
        let i = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (starts[mid] <= vaddr) {
                i = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (i < 0) {
            return undefined;
        }
        // Objects can nest: an earlier, larger object may still cover vaddr
        // when the latest-starting one has ended. Walk back to the covering
        // entry with the latest start.
        for (let j = i; j >= 0 && starts[j] <= vaddr; j--) {
            const [start, size, name] = entries[j];
            if (vaddr < start + size) {
                return vaddr === start ? name : `${name}+${vaddr - start}`;
            }
        }
        return undefined;
    }

    private lookupSymbol(vaddr: number): string | undefined {
        if (this.symbolCache.size >= SYMBOL_CACHE_SIZE && !this.symbolCache.has(vaddr)) {
            // Bound the cache like upstream's lru_cache
            const first = this.symbolCache.keys().next().value;
            if (first !== undefined) {
                this.symbolCache.delete(first);
            }
        }
        if (!this.symbolCache.has(vaddr)) {
            this.symbolCache.set(vaddr, this.lookupUncached(vaddr));
        }
        return this.symbolCache.get(vaddr);
    }

    private lookupUncached(vaddr: number): string | undefined {
        const name = this.symbols.lookup(vaddr);
        if (name !== undefined) {
            return name;
        }
        // Last label starting at or before vaddr
        let lo = 0;
        let hi = this.labelStarts.length - 1;
        let i = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.labelStarts[mid] <= vaddr) {
                i = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (i < 0) {
            return undefined;
        }
        const [start, end, label] = this.labels[i];
        if (vaddr >= end) {
            return undefined;
        }
        const functionStart = this.symbols.startBefore(vaddr);
        if (functionStart !== undefined && functionStart > start) {
            return undefined;
        }
        return label;
    }

    private *iterSymbols(): Generator<ElfSymbol> {
        for (const sec of this.sections) {
            if (sec.sh_type !== SHT_SYMTAB && sec.sh_type !== SHT_DYNSYM) {
                continue;
            }
            const strtab = elfStringTable(this.bytes, this.sections, sec);
            for (const sym of elfSymbols(this.bytes, sec)) {
                sym.name = elfSymbolName(strtab, sym);
                yield sym;
            }
        }
    }

    private loadSymbols(): void {
        const addrs: number[] = [];
        const sizes: number[] = [];
        const names: string[] = [];
        const limits: Array<number | undefined> = [];
        for (const sym of this.iterSymbols()) {
            const kind = sym.info & 0xf;
            const absolute = sym.shndx === SHN_ABS;
            // The linker scripts of ESP-IDF name ROM functions with absolute symbols. A
            // script assignment keeps the type and size of the definition it replaces,
            // such as the 766 bytes of the qsort of libc, so they name only their address.
            if (kind !== STT_FUNC && !(absolute && kind === STT_NOTYPE)) {
                continue;
            }
            const name = sym.name;
            if (!name) {
                continue;
            }
            const addr = sym.value;
            const size = absolute ? 0 : sym.size;
            // Absolute labels in the code of the ELF mark section bounds, as _iram_text_start does
            if (addr === 0 || (absolute && kind === STT_NOTYPE && this.inCode(addr))) {
                continue;
            }
            addrs.push(addr);
            sizes.push(size);
            names.push(name);
            limits.push(this.sectionEnd(sym.shndx));
        }
        // Sort sized symbols after size 0 aliases for the same address.
        const order = addrs
            .map((_, i) => i)
            .sort((a, b) => addrs[a] - addrs[b] || (sizes[a] ? 1 : 0) - (sizes[b] ? 1 : 0));
        const sortedAddrs = order.map((i) => addrs[i]);
        const sortedSizes = fillZeroSizes(
            sortedAddrs,
            order.map((i) => sizes[i]),
            order.map((i) => limits[i])
        );
        // A size 0 symbol covers only its own address
        const intervals: Array<readonly [number, number, string]> = sortedAddrs.map((addr, i) => [
            addr,
            addr + (sortedSizes[i] || 1),
            names[order[i]],
        ]);
        this.symbols = new IntervalIndex<string>(intervals);
    }

    private loadLabels(): Array<readonly [number, number, string]> {
        /** Labels in code sections outside every function, as [address, section end, name], sorted. */
        const labels = new Map<number, [number, string]>();
        for (const sym of this.iterSymbols()) {
            if ((sym.info & 0xf) !== STT_NOTYPE) {
                continue;
            }
            const name = sym.name;
            // $x and $d only mark code and data for disassemblers
            if (!name || name.startsWith('$')) {
                continue;
            }
            const addr = sym.value;
            const shndx = sym.shndx;
            const end = this.sectionEnd(shndx);
            if (addr === 0 || end === undefined || !this.holdsCode(shndx) || this.symbols.lookup(addr) !== undefined) {
                continue;
            }
            // A label that is not a local one, as ".skip_restore" is, names the code better
            const existing = labels.get(addr);
            if (existing === undefined || (existing[1].startsWith('.') && !name.startsWith('.'))) {
                labels.set(addr, [end, name]);
            }
        }
        return [...labels.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([addr, [end, name]]) => [addr, end, name] as const);
    }

    private loadObjects(): void {
        /** Sized STT_OBJECT symbols name variables, which code runs in when a jump goes into a buffer. */
        const entries: Array<readonly [number, number, string]> = [];
        for (const sym of this.iterSymbols()) {
            if (
                (sym.info & 0xf) === STT_OBJECT &&
                sym.size &&
                sym.name &&
                sym.shndx !== SHN_ABS
            ) {
                entries.push([sym.value, sym.size, sym.name]);
            }
        }
        entries.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
        this.objects = { starts: entries.map((e) => e[0]), entries };
    }

    private inCode(vaddr: number): boolean {
        const idx = bisectRight(this.regionStarts, vaddr) - 1;
        return idx >= 0 && this.regionContains(this.regions[idx], vaddr, 1);
    }

    private regionContains(region: ExecRegion, addr: number, n: number): boolean {
        return region.vaddr <= addr && addr + n <= region.vaddr + region.size;
    }

    private holdsCode(shndx: number): boolean {
        const sec = this.sections[shndx];
        return sec !== undefined && (sec.sh_flags & SHF_EXECINSTR) !== 0;
    }

    private sectionEnd(shndx: number): number | undefined {
        const sec = this.sections[shndx];
        if (sec === undefined || shndx <= 0) {
            return undefined;
        }
        return sec.sh_addr + sec.sh_size;
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

function fillZeroSizes(addrs: number[], sizes: number[], limits: Array<number | undefined>): number[] {
    /** Extend size 0 symbols up to the next symbol start or their section end. */
    const sizedAddrs = new Set(addrs.filter((_, i) => sizes[i] !== 0));
    const out = [...sizes];
    for (let i = 0; i < addrs.length; i++) {
        const addr = addrs[i];
        const size = sizes[i];
        const limit = limits[i];
        if (size !== 0 || limit === undefined || sizedAddrs.has(addr)) {
            continue;
        }
        const j = bisectRight(addrs, addr);
        const end = j < addrs.length ? Math.min(addrs[j], limit) : limit;
        if (end > addr) {
            out[i] = end - addr;
        }
    }
    return out;
}
