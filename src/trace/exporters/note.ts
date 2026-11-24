// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/exporters/note.py (Apache-2.0).
// Describe the trace note of a core dump in the lines esp-coredump `info_corefile` prints.

import {
    AddressMode,
    CaptureReason,
    MemoryMode,
    NOTE_NO_SEGMENT,
    NoteHeader,
    NoteRecord,
    PacketFormat,
    ResyncMode,
} from '../snapshot/abi';

const FORMAT_NAMES: Record<number, string> = {
    [PacketFormat.PROCESSOR_TRACE_1_0]: 'PT10',
    [PacketFormat.EFFICIENT_TRACE_2_0]: 'ET20',
};

export function formatNote(header: NoteHeader, records: NoteRecord[]): string[] {
    /** Return the lines that describe the note header and the record of each core. */
    const lines = [
        `ABI ${header.abi_major}.${header.abi_minor}, reason ${name(CaptureReason, header.capture_reason)}, ` +
            `cores ${header.core_count}`,
        `Target 0x${header.target_id.toString(16).padStart(4, '0')}, chip revision v${Math.floor(header.chip_revision / 100)}.${header.chip_revision % 100}`,
    ];
    if (header.app_elf_sha256.some((b) => b !== 0)) {
        lines.push(`App ELF SHA256: ${header.app_elf_sha256.toString('hex')}`);
    }
    for (const record of records) {
        lines.push(...formatRecord(record));
    }
    return lines;
}

function formatRecord(record: NoteRecord): string[] {
    const packetFormat = FORMAT_NAMES[record.packet_format] ?? name(PacketFormat, record.packet_format);
    const lines = [
        `Core ${record.core_id}: memory ${name(MemoryMode, record.memory_mode)}, format ${packetFormat}, ` +
            `address ${name(AddressMode, record.address_mode)}`,
        `  resync ${name(ResyncMode, record.resync_mode)}, threshold ${record.resync_threshold}`,
    ];
    if (hasSegment(record)) {
        const head = record.head_valid ? `0x${record.head_offset.toString(16)}` : 'invalid';
        lines.push(
            `  buffer 0x${record.segment_vaddr.toString(16)}, capacity 0x${record.capacity.toString(16)}, head ${head}, ` +
                `segment ${record.segment_index}`
        );
    } else {
        lines.push('  no buffer');
    }
    lines.push(
        `  hw fifo 0x${record.fifo_status_raw.toString(16).padStart(8, '0')}, intr 0x${record.intr_status_raw.toString(16).padStart(8, '0')}, ` +
            `empty ${yesNo(record.fifo_empty)}, full ${yesNo(record.memory_full)}, ` +
            `overflow ${yesNo(record.fifo_overflow)}`
    );
    const flags = qualityFlags(record);
    if (flags.length) {
        lines.push(`  quality: ${flags.join(', ')}`);
    }
    return lines;
}

function name(cls: Record<string, unknown>, value: number): string {
    // Numeric enums map value -> member name; upstream prints cls(value).name
    const member = cls[value];
    return typeof member === 'string' ? member : String(value);
}

function yesNo(flag: number): string {
    return flag ? 'yes' : 'no';
}

function hasSegment(record: NoteRecord): boolean {
    return record.segment_index !== NOTE_NO_SEGMENT;
}

function qualityFlags(record: NoteRecord): string[] {
    const flags: string[] = [];
    if (!record.head_valid) {
        flags.push('HEAD_INVALID');
    }
    if (record.memory_full) {
        flags.push('MEMORY_FULL');
    }
    if (record.fifo_overflow) {
        flags.push('FIFO_OVERFLOW');
    }
    if (hasSegment(record) && !record.fifo_empty) {
        flags.push('FIFO_NOT_EMPTY');
    }
    return flags;
}
