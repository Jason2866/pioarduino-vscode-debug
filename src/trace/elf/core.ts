// Minimal ELF32 little-endian core-file reader for ESP coredump containers.
// Only the features needed by the trace container loaders are implemented.

import { TraceError } from '../errors';

export const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF

export const PT_NULL = 0;
export const PT_LOAD = 1;
export const PT_NOTE = 4;
export const ET_CORE = 4;

export const SHT_SYMTAB = 2;
export const SHT_DYNSYM = 11;
export const SHF_EXECINSTR = 0x4;

export const STT_NOTYPE = 0;
export const STT_OBJECT = 1;
export const STT_FUNC = 2;
export const SHN_UNDEF = 0;
export const SHN_ABS = 0xfff1;

export interface ElfSectionHeader {
    index: number;
    name: string;
    sh_type: number;
    sh_flags: number;
    sh_addr: number;
    sh_offset: number;
    sh_size: number;
    sh_link: number;
    sh_info: number;
    sh_addralign: number;
    sh_entsize: number;
}

export interface ElfSymbol {
    name: string;
    nameOffset: number;
    value: number;
    size: number;
    /** st_info: bind in the high nibble, type in the low nibble. */
    info: number;
    other: number;
    shndx: number;
}

export interface ParsedElfSections {
    sections: ElfSectionHeader[];
}

export interface ElfProgramHeader {
    p_type: number;
    p_offset: number;
    p_vaddr: number;
    p_paddr: number;
    p_filesz: number;
    p_memsz: number;
    p_flags: number;
    p_align: number;
}

export interface ElfNoteEntry {
    name: string;
    type: number;
    desc: Buffer;
}

export interface ElfSegmentData {
    header: ElfProgramHeader;
    data: Buffer;
}

export interface ParsedElfHeaders {
    e_type: number;
    e_machine: number;
    programHeaders: ElfProgramHeader[];
}

export interface ParsedElfCore extends ParsedElfHeaders {
    notes: ElfNoteEntry[];
    loads: ElfSegmentData[];
}

export function isElf(data: Buffer | Uint8Array): boolean {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return b.length >= 4 && b.subarray(0, 4).equals(ELF_MAGIC);
}

function checkElfHeader(b: Buffer): void {
    if (b.length < 52) {
        throw new TraceError(`ELF file is only ${b.length} bytes, need at least 52 for the ELF32 header`);
    }
    if (!b.subarray(0, 4).equals(ELF_MAGIC)) {
        throw new TraceError('file does not start with the ELF magic');
    }
    const elfClass = b.readUInt8(4);
    const dataEncoding = b.readUInt8(5);
    if (elfClass !== 1) {
        throw new TraceError(`unsupported ELF class ${elfClass}, only ELFCLASS32 is supported`);
    }
    if (dataEncoding !== 1) {
        throw new TraceError(`unsupported ELF data encoding ${dataEncoding}, only little-endian is supported`);
    }
}

/** Parse the ELF header and program header table without touching segment payloads. */
export function parseElfProgramHeaders(data: Buffer | Uint8Array): ParsedElfHeaders {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    checkElfHeader(b);

    const eType = b.readUInt16LE(16);
    const eMachine = b.readUInt16LE(18);
    const ePhoff = b.readUInt32LE(28);
    const ePhentsize = b.readUInt16LE(42);
    const ePhnum = b.readUInt16LE(44);

    if (ePhentsize < 32) {
        throw new TraceError(`invalid ELF program header entry size ${ePhentsize}`);
    }
    const programHeaders: ElfProgramHeader[] = [];
    for (let i = 0; i < ePhnum; i++) {
        const off = ePhoff + i * ePhentsize;
        if (off + 32 > b.length) {
            throw new TraceError(`ELF program header ${i} is truncated`);
        }
        programHeaders.push({
            p_type: b.readUInt32LE(off),
            p_offset: b.readUInt32LE(off + 4),
            p_vaddr: b.readUInt32LE(off + 8),
            p_paddr: b.readUInt32LE(off + 12),
            p_filesz: b.readUInt32LE(off + 16),
            p_memsz: b.readUInt32LE(off + 20),
            p_flags: b.readUInt32LE(off + 24),
            p_align: b.readUInt32LE(off + 28),
        });
    }
    return { e_type: eType, e_machine: eMachine, programHeaders };
}

export function parseElfCoreFile(data: Buffer | Uint8Array): ParsedElfCore {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const { e_type: eType, e_machine: eMachine, programHeaders } = parseElfProgramHeaders(b);

    const loads: ElfSegmentData[] = [];
    const notes: ElfNoteEntry[] = [];
    for (const ph of programHeaders) {
        // PT_NULL entries carry undefined fields, so they are skipped before
        // any file-range validation.
        if (ph.p_type === PT_NULL) {
            continue;
        }
        const start = ph.p_offset;
        const end = start + ph.p_filesz;
        if (end > b.length) {
            throw new TraceError(
                `ELF segment type ${ph.p_type} file range [${start}, ${end}) exceeds file size ${b.length}`
            );
        }
        const segData = b.subarray(start, end);
        if (ph.p_type === PT_LOAD) {
            loads.push({ header: ph, data: Buffer.from(segData) });
        } else if (ph.p_type === PT_NOTE) {
            notes.push(...parseNotes(segData));
        }
    }

    return { e_type: eType, e_machine: eMachine, programHeaders, notes, loads };
}

/** Parse the ELF32 section header table, resolving names through shstrtab. */
export function parseElfSections(data: Buffer | Uint8Array): ParsedElfSections {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    checkElfHeader(b);
    const eShoff = b.readUInt32LE(32);
    const eShentsize = b.readUInt16LE(46);
    const eShnum = b.readUInt16LE(48);
    const eShstrndx = b.readUInt16LE(50);

    // An executable ELF may carry no section header table at all.
    if (eShnum === 0) {
        return { sections: [] };
    }
    if (eShentsize < 40) {
        throw new TraceError(`invalid ELF section header entry size ${eShentsize}`);
    }
    const raw: Array<Omit<ElfSectionHeader, 'name'>> = [];
    for (let i = 0; i < eShnum; i++) {
        const off = eShoff + i * eShentsize;
        if (off + 40 > b.length) {
            throw new TraceError(`ELF section header ${i} is truncated`);
        }
        raw.push({
            index: i,
            sh_type: b.readUInt32LE(off + 4),
            sh_flags: b.readUInt32LE(off + 8),
            sh_addr: b.readUInt32LE(off + 12),
            sh_offset: b.readUInt32LE(off + 16),
            sh_size: b.readUInt32LE(off + 20),
            sh_link: b.readUInt32LE(off + 24),
            sh_info: b.readUInt32LE(off + 28),
            sh_addralign: b.readUInt32LE(off + 32),
            sh_entsize: b.readUInt32LE(off + 36),
        });
    }
    // Section names live in the section named by e_shstrndx
    let stringTable: Buffer | undefined;
    if (eShstrndx !== 0 && eShstrndx < raw.length) {
        const shstr = raw[eShstrndx];
        stringTable = b.subarray(shstr.sh_offset, shstr.sh_offset + shstr.sh_size);
    }
    const nameAt = (nameOffset: number): string => {
        if (stringTable === undefined || nameOffset >= stringTable.length) {
            return '';
        }
        const end = stringTable.indexOf(0, nameOffset);
        return stringTable.toString('latin1', nameOffset, end === -1 ? stringTable.length : end);
    };
    // sh_name is the first field of each raw header; re-read it
    const sections: ElfSectionHeader[] = raw.map((sec, i) => {
        const off = eShoff + i * eShentsize;
        return { ...sec, name: nameAt(b.readUInt32LE(off)) };
    });
    return { sections };
}

/** Iterate the symbols of an SHT_SYMTAB or SHT_DYNSYM section. */
export function elfSymbols(data: Buffer | Uint8Array, section: ElfSectionHeader): ElfSymbol[] {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const symbols: ElfSymbol[] = [];
    const count = Math.floor(section.sh_size / 16);
    for (let i = 0; i < count; i++) {
        const off = section.sh_offset + i * 16;
        if (off + 16 > b.length) {
            throw new TraceError(`ELF symbol ${i} of section ${section.name} is truncated`);
        }
        const nameOffset = b.readUInt32LE(off);
        symbols.push({
            name: '',
            nameOffset,
            value: b.readUInt32LE(off + 4),
            size: b.readUInt32LE(off + 8),
            info: b.readUInt8(off + 12),
            other: b.readUInt8(off + 13),
            shndx: b.readUInt16LE(off + 14),
        });
    }
    return symbols;
}

/** Return the name of `symbol` from its string table. */
export function elfSymbolName(strtab: Buffer, symbol: ElfSymbol): string {
    const offset = symbol.nameOffset;
    if (offset >= strtab.length) {
        return '';
    }
    const end = strtab.indexOf(0, offset);
    return strtab.toString('latin1', offset, end === -1 ? strtab.length : end);
}

/** Read the string table section linked by a symbol table section. */
export function elfStringTable(
    data: Buffer | Uint8Array,
    sections: ElfSectionHeader[],
    symtab: ElfSectionHeader
): Buffer {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const strtab = sections[symtab.sh_link];
    if (strtab === undefined) {
        throw new TraceError(`symbol table ${symtab.name} has no linked string table`);
    }
    return b.subarray(strtab.sh_offset, strtab.sh_offset + strtab.sh_size);
}

function align4(n: number): number {
    // Non-bitwise padding: note lengths are u32 and `(n + 3) & ~3` would wrap
    // negative through int32 for lengths near 2^32.
    return n + ((4 - (n % 4)) % 4);
}

function parseNotes(seg: Buffer): ElfNoteEntry[] {
    const notes: ElfNoteEntry[] = [];
    let off = 0;
    while (off + 12 <= seg.length) {
        const namesz = seg.readUInt32LE(off);
        const descsz = seg.readUInt32LE(off + 4);
        const type = seg.readUInt32LE(off + 8);
        off += 12;

        const nameEnd = off + align4(namesz);
        const descStart = nameEnd;
        const descEnd = descStart + align4(descsz);
        if (nameEnd > seg.length || descEnd > seg.length) {
            throw new TraceError('ELF note is truncated');
        }
        const rawName = seg.subarray(off, off + namesz);
        const name = rawName.toString('latin1').replace(/\0+$/g, '');
        notes.push({ name, type, desc: Buffer.from(seg.subarray(descStart, descStart + descsz)) });
        off = descEnd;
    }
    return notes;
}
