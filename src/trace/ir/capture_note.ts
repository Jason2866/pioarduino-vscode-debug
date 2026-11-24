// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/ir/capture_note.py (Apache-2.0).

import * as abi from '../snapshot/abi';

export enum InferredWrapState {
    INFERRED_WRAPPED = 'inferred_wrapped',
    INFERRED_NOT_WRAPPED = 'inferred_not_wrapped',
}

export enum ElfShaStatus {
    MATCH = 'match',
    MISMATCH = 'mismatch',
    NO_SNAPSHOT_HASH = 'no_snapshot_hash',
    NO_ELF = 'no_elf',
}

/** Compare the hash a capture recorded with the SHA-256 of the application ELF. */
export function compareElfSha(
    recorded: Buffer | undefined,
    size: number,
    elfSha256: Buffer | undefined
): ElfShaStatus {
    if (elfSha256 === undefined) {
        return ElfShaStatus.NO_ELF;
    }
    const prefix = recorded === undefined ? Buffer.alloc(0) : recorded.subarray(0, Math.max(size, 0));
    if (prefix.length === 0) {
        return ElfShaStatus.NO_SNAPSHOT_HASH;
    }
    return prefix.equals(elfSha256.subarray(0, prefix.length)) ? ElfShaStatus.MATCH : ElfShaStatus.MISMATCH;
}

export interface TraceCaptureNote {
    /** One core's decoder header. */
    source: string;
    chip: string | undefined;
    core_id: number;
    packet_format: string;
    address_mode: string;
    memory_mode: string;
    resync_mode: string;
    resync_threshold: number;
    wrap_state: string;
    capacity: number;
    head_offset: number;
    fifo_status_raw: number;
    intr_status_raw: number;
    fifo_empty: boolean;
    memory_full: boolean;
    fifo_overflow: boolean;
    capture_reason: string;
    owner: string;
    target_id: number | undefined;
    chip_revision: number | undefined;
    snapshot_app_elf_sha256: Buffer | undefined;
    elf_path: string | undefined;
    elf_sha256: Buffer | undefined;
    elf_sha_status: ElfShaStatus;
    wrap_reason?: string;
    rom_elf_path?: string;
    rom_elf_status?: string;
    fifo_emptied?: boolean;
    abi_major?: number;
    abi_minor?: number;
}
