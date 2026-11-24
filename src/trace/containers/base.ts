// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/containers/base.py (Apache-2.0).

import { ContainerError } from '../errors';
import * as abi from '../snapshot/abi';

export { ContainerError };

export interface TraceBuffer {
    core_id: number;
    raw: Buffer;
    capacity: number;
    head_offset: number;
    memory_mode: number;
    wrap_state: number;
    packet_format: number;
    address_mode: number;
    fifo_status_raw: number;
    intr_status_raw: number;
    owner: number;
    state: number;
    head_valid: boolean;
    encoder_params: abi.EncoderParams | undefined;
    segment_index: number | undefined;
    resync_mode: number;
    resync_threshold: number;
    fifo_empty: boolean;
    memory_full: boolean;
    fifo_overflow: boolean;
}

export interface Capture {
    source: 'espt' | 'coredump' | string;
    source_path: string;
    abi_major: number;
    abi_minor: number;
    capture_reason: number;
    write_seq: number;
    target_id: number | undefined;
    chip_revision: number | undefined;
    app_elf_sha256: Buffer | undefined;
    cores: TraceBuffer[];
    fifo_emptied: boolean | undefined; // undefined when the container has no END status
}

type CoreLike = Pick<
    abi.CoreDesc | abi.NoteRecord,
    | 'core_id'
    | 'capacity'
    | 'head_offset'
    | 'memory_mode'
    | 'packet_format'
    | 'address_mode'
    | 'fifo_status_raw'
    | 'intr_status_raw'
    | 'owner'
    | 'state'
    | 'head_valid'
    | 'fifo_empty'
    | 'memory_full'
    | 'fifo_overflow'
    | 'resync_mode'
    | 'resync_threshold'
>;

/** Build a buffer from an ESPT core descriptor or a coredump note record. */
export function traceBufferFromRecord(
    rec: CoreLike,
    raw: Buffer,
    params: abi.EncoderParams | undefined,
    segmentIndex: number | undefined
): TraceBuffer {
    const buf: TraceBuffer = {
        core_id: rec.core_id,
        raw,
        capacity: rec.capacity,
        head_offset: rec.head_offset,
        memory_mode: rec.memory_mode,
        wrap_state: abi.WrapState.UNKNOWN,
        packet_format: rec.packet_format,
        address_mode: rec.address_mode,
        fifo_status_raw: rec.fifo_status_raw,
        intr_status_raw: rec.intr_status_raw,
        owner: rec.owner,
        state: rec.state,
        head_valid: Boolean(rec.head_valid),
        fifo_empty: Boolean(rec.fifo_empty),
        memory_full: Boolean(rec.memory_full),
        fifo_overflow: Boolean(rec.fifo_overflow),
        encoder_params: params,
        segment_index: segmentIndex,
        resync_mode: rec.resync_mode,
        resync_threshold: rec.resync_threshold,
    };
    validateTraceBuffer(buf);
    return buf;
}

export function validateTraceBuffer(buf: TraceBuffer): void {
    if (buf.capacity <= 0) {
        throw new ContainerError(`core ${buf.core_id} capacity ${buf.capacity} must be positive`);
    }
    if (buf.raw.length !== buf.capacity) {
        throw new ContainerError(
            `core ${buf.core_id} buffer length ${buf.raw.length} does not match capacity ${buf.capacity}`
        );
    }
    if (buf.head_offset < 0 || buf.head_offset > buf.capacity) {
        throw new ContainerError(`core ${buf.core_id} head_offset ${buf.head_offset} outside [0, ${buf.capacity}]`);
    }
    if (buf.memory_mode === abi.MemoryMode.LINEAR && buf.wrap_state === abi.WrapState.WRAPPED) {
        throw new ContainerError(
            `core ${buf.core_id} has memory_mode=LINEAR but wrap_state=WRAPPED, which is impossible`
        );
    }
}

export function validateCapture(capture: Capture): void {
    const seen = new Set<number>();
    for (const core of capture.cores) {
        validateTraceBuffer(core);
        if (seen.has(core.core_id)) {
            throw new ContainerError(`duplicate core_id ${core.core_id} in capture`);
        }
        seen.add(core.core_id);
    }
}
