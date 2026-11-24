// Minimal ELF32 little-endian core-file reader for ESP coredump containers.
// Only the features needed by the trace container loaders are implemented.

import { TraceError } from '../errors';

export const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF

export const PT_LOAD = 1;
export const PT_NOTE = 4;
export const ET_CORE = 4;

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

export interface ParsedElfCore {
    e_type: number;
    e_machine: number;
    programHeaders: ElfProgramHeader[];
    notes: ElfNoteEntry[];
    loads: ElfSegmentData[];
}

export function isElf(data: Buffer | Uint8Array): boolean {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return b.length >= 4 && b.subarray(0, 4).equals(ELF_MAGIC);
}

export function parseElfCoreFile(data: Buffer | Uint8Array): ParsedElfCore {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
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

    const loads: ElfSegmentData[] = [];
    const notes: ElfNoteEntry[] = [];
    for (const ph of programHeaders) {
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

function align4(n: number): number {
    return (n + 3) & ~3;
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
        if (descEnd > seg.length) {
            throw new TraceError('ELF note is truncated');
        }
        const rawName = seg.subarray(off, off + namesz);
        const name = rawName.toString('latin1').replace(/\0+$/g, '');
        notes.push({ name, type, desc: Buffer.from(seg.subarray(descStart, descStart + descsz)) });
        off = descEnd;
    }
    return notes;
}
