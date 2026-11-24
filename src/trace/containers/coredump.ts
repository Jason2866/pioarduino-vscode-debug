// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/containers/coredump.py (Apache-2.0).

import * as fs from 'fs';
import * as path from 'path';
import { AbiError, ContainerError, TraceError } from '../errors';
import { ET_CORE, ElfNoteEntry, ElfSegmentData, ParsedElfCore, parseElfCoreFile } from '../elf/core';
import * as abi from '../snapshot/abi';
import { Capture, TraceBuffer, traceBufferFromRecord, validateCapture } from './base';

/** Return true when ``headBytes`` starts with the ELF magic. */
export function sniff(headBytes: Buffer | Uint8Array): boolean {
    const b = Buffer.isBuffer(headBytes) ? headBytes : Buffer.from(headBytes);
    return b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
}

export function load(filePath: string): Capture {
    const p = path.resolve(filePath);
    const data = fs.readFileSync(p);

    let elf: ParsedElfCore;
    try {
        elf = parseElfCoreFile(data);
    } catch (error) {
        if (error instanceof ContainerError) {
            throw error;
        }
        const message = error instanceof TraceError ? error.message : String(error);
        throw new ContainerError(`${p} is not a valid ELF file. ${message}`);
    }
    if (elf.e_type !== ET_CORE) {
        throw new ContainerError(`${p} is not a core file (e_type=${elf.e_type})`);
    }

    const noteDesc = findRiscvTraceNote(elf.notes);
    if (noteDesc === undefined) {
        throw new ContainerError(`${p} has no ESP_RISCV_TRACE note (type ${abi.NOTE_TYPE})`);
    }

    let header: abi.NoteHeader;
    let records: abi.NoteRecord[];
    try {
        ({ header, records } = abi.parseNote(noteDesc));
    } catch (error) {
        if (error instanceof AbiError) {
            throw new ContainerError(`${p} has a malformed ESP_RISCV_TRACE note. ${error.message}`);
        }
        throw error;
    }

    const ptLoads = indexPtLoads(elf.loads);
    const buffers: TraceBuffer[] = [];
    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (rec.segment_index === abi.NOTE_NO_SEGMENT) {
            continue;
        }
        const key = `${rec.segment_vaddr}:${rec.segment_size}`;
        const matches = ptLoads.get(key) ?? [];
        if (matches.length === 0) {
            throw new ContainerError(
                `${p} core[${i}] references vaddr=0x${rec.segment_vaddr.toString(16)} ` +
                    `size=${rec.segment_size} but no PT_LOAD matches`
            );
        }
        if (matches.length > 1) {
            throw new ContainerError(
                `${p} core[${i}] references vaddr=0x${rec.segment_vaddr.toString(16)} ` +
                    `size=${rec.segment_size} but ${matches.length} PT_LOADs match`
            );
        }
        const raw = matches[0];
        if (raw.length !== rec.segment_size) {
            throw new ContainerError(
                `${p} core[${i}] segment payload is ${raw.length} bytes, expected ${rec.segment_size}`
            );
        }
        buffers.push(traceBufferFromRecord(rec, Buffer.from(raw), header.encoder_params, rec.segment_index));
    }

    const shaBytes = header.app_elf_sha256_size === 32 ? Buffer.from(header.app_elf_sha256) : undefined;

    const capture: Capture = {
        source: 'coredump',
        source_path: p,
        abi_major: header.abi_major,
        abi_minor: header.abi_minor,
        capture_reason: header.capture_reason,
        write_seq: header.write_seq,
        target_id: header.target_id,
        chip_revision: header.chip_revision,
        app_elf_sha256: shaBytes,
        cores: buffers,
        fifo_emptied: undefined,
    };
    validateCapture(capture);
    return capture;
}

function findRiscvTraceNote(notes: ElfNoteEntry[]): Buffer | undefined {
    for (const note of notes) {
        if (note.name === abi.NOTE_NAME && note.type === abi.NOTE_TYPE) {
            return note.desc;
        }
    }
    return undefined;
}

/** Group ``PT_LOAD`` segments by ``(p_vaddr, p_filesz)``. */
function indexPtLoads(loads: ElfSegmentData[]): Map<string, Buffer[]> {
    const idx = new Map<string, Buffer[]>();
    for (const seg of loads) {
        const key = `${seg.header.p_vaddr}:${seg.header.p_filesz}`;
        const list = idx.get(key) ?? [];
        list.push(seg.data);
        idx.set(key, list);
    }
    return idx;
}
