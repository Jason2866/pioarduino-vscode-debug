// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/snapshot/abi.py (Apache-2.0).

import { AbiError } from '../errors';

export const MAGIC = 0x53545652;
export const ABI_MAJOR = 1;
export const ABI_MINOR = 1;
export const SNAPSHOT_DESC_SIZE = 32;
export const CORE_DESC_SIZE = 36;
export const ENCODER_PARAMS_SIZE = 28;
export const ENCODER_PARAMS_VERSION = 1;

// Eight exceeds current Espressif hart counts and rejects corrupt data.
export const CORE_COUNT_MAX = 8;

export const NOTE_NAME = 'ESP_RISCV_TRACE';
export const NOTE_TYPE = 680;
export const NOTE_HEADER_SIZE = 80;
export const NOTE_RECORD_SIZE = 44;
export const NOTE_NO_SEGMENT = 0xffffffff;

export enum CaptureReason {
    UNKNOWN = 0,
    EXPLICIT_STOP = 1,
    PANIC = 2,
    MEMORY_FULL = 3,
}

export enum PacketFormat {
    UNKNOWN = 0,
    PROCESSOR_TRACE_1_0 = 100,
    EFFICIENT_TRACE_2_0 = 200,
}

export enum State {
    UNAVAILABLE = 0,
    READY = 1,
    CAPTURING = 2,
    STOPPED = 3,
    FROZEN = 4,
}

export enum WrapState {
    UNKNOWN = 0,
    NOT_WRAPPED = 1,
    WRAPPED = 2,
}

export enum MemoryMode {
    UNKNOWN = 0,
    LINEAR = 1,
    LOOP = 2,
}

export enum AddressMode {
    UNKNOWN = 0,
    DELTA = 1,
    FULL = 2,
}

export enum Owner {
    FW = 0,
    OPENOCD = 1,
}

export enum ResyncMode {
    UNKNOWN = 0,
    DISABLED = 1,
    PACKET = 2,
    CYCLE = 3,
}

/** Return the lower-case enum member name or ``unknown(<value>)``. */
export function enumName(cls: Record<string, unknown>, value: number): string {
    const name = cls[value];
    return typeof name === 'string' ? name.toLowerCase() : `unknown(${value})`;
}

export interface SnapshotDesc {
    magic: number;
    abi_major: number;
    abi_minor: number;
    snapshot_desc_size: number;
    core_desc_size: number;
    core_count: number;
    capture_reason: number;
    write_seq: number;
    cores_addr: number;
    app_elf_sha256_addr: number;
    app_elf_sha256_size: number;
    target_id: number;
    chip_revision: number;
    encoder_params_addr: number;
    encoder_params_size: number;
}

export interface CoreDesc {
    core_id: number;
    state: number;
    buffer_addr: number;
    capacity: number;
    head_offset: number;
    memory_mode: number;
    packet_format: number;
    address_mode: number;
    resync_mode: number;
    owner: number;
    head_valid: number;
    fifo_empty: number;
    memory_full: number;
    fifo_overflow: number;
    resync_threshold: number;
    fifo_status_raw: number;
    intr_status_raw: number;
}

export interface EncoderParams {
    params_version: number;
    params_size: number;
    arch_p: number;
    bpred_size_p: number;
    cache_size_p: number;
    call_counter_size_p: number;
    ctype_width_p: number;
    context_width_p: number;
    ecause_width_p: number;
    ecause_choice_p: number;
    f0s_width_p: number;
    filter_context_p: number;
    filter_excint_p: number;
    filter_privilege_p: number;
    filter_tval_p: number;
    iaddress_lsb_p: number;
    iaddress_width_p: number;
    iretire_width_p: number;
    ilastsize_width_p: number;
    itype_width_p: number;
    nocontext_p: number;
    notime_p: number;
    privilege_width_p: number;
    retires_p: number;
    return_stack_size_p: number;
    sijump_p: number;
    taken_branches_p: number;
    impdef_width_p: number;
}

export interface NoteHeader {
    magic: number;
    abi_major: number;
    abi_minor: number;
    note_header_size: number;
    note_record_size: number;
    core_count: number;
    capture_reason: number;
    write_seq: number;
    target_id: number;
    chip_revision: number;
    app_elf_sha256_size: number;
    app_elf_sha256: Buffer;
    encoder_params_size: number;
    encoder_params: EncoderParams | undefined;
}

export interface NoteRecord {
    core_id: number;
    state: number;
    segment_index: number;
    segment_vaddr: number;
    segment_size: number;
    capacity: number;
    head_offset: number;
    memory_mode: number;
    packet_format: number;
    address_mode: number;
    resync_mode: number;
    owner: number;
    head_valid: number;
    fifo_empty: number;
    memory_full: number;
    fifo_overflow: number;
    resync_threshold: number;
    fifo_status_raw: number;
    intr_status_raw: number;
}

const FLAG_FIELDS = ['head_valid', 'fifo_empty', 'memory_full', 'fifo_overflow'] as const;

function asBuffer(data: Buffer | Uint8Array): Buffer {
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function need(data: Buffer, size: number, what: string): void {
    if (data.length < size) {
        throw new AbiError(`${what} needs ${size} bytes, got ${data.length}`);
    }
}

function checkCommonHeader(v: { magic: number; abi_major: number; write_seq: number }): void {
    if (v.magic !== MAGIC) {
        throw new AbiError(`bad magic 0x${v.magic.toString(16).padStart(8, '0')}, want 0x${MAGIC.toString(16).padStart(8, '0')}`);
    }
    if (v.abi_major !== ABI_MAJOR) {
        throw new AbiError(`unsupported abi_major ${v.abi_major}, want ${ABI_MAJOR}`);
    }
    if (v.write_seq & 1) {
        throw new AbiError(`write_seq ${v.write_seq} is odd, snapshot was mid-update`);
    }
}

function checkCoreCount(v: { core_count: number }): void {
    if (v.core_count === 0 || v.core_count > CORE_COUNT_MAX) {
        throw new AbiError(`core_count ${v.core_count} out of range 1..${CORE_COUNT_MAX}`);
    }
}

function checkShaSize(v: { app_elf_sha256_size: number }): void {
    if (v.app_elf_sha256_size !== 0 && v.app_elf_sha256_size !== 32) {
        throw new AbiError(`app_elf_sha256_size ${v.app_elf_sha256_size}, want 0 or 32`);
    }
}

export function parseSnapshotDesc(data: Buffer | Uint8Array): SnapshotDesc {
    const b = asBuffer(data);
    need(b, SNAPSHOT_DESC_SIZE, 'snapshot descriptor');
    const v = {
        magic: b.readUInt32LE(0),
        write_seq: b.readUInt32LE(4),
        cores_addr: b.readUInt32LE(8),
        app_elf_sha256_addr: b.readUInt32LE(12),
        encoder_params_addr: b.readUInt32LE(16),
        target_id: b.readUInt16LE(20),
        chip_revision: b.readUInt16LE(22),
        abi_major: b.readUInt8(24),
        abi_minor: b.readUInt8(25),
        snapshot_desc_size: b.readUInt8(26),
        core_desc_size: b.readUInt8(27),
        core_count: b.readUInt8(28),
        capture_reason: b.readUInt8(29),
        app_elf_sha256_size: b.readUInt8(30),
        encoder_params_size: b.readUInt8(31),
    };
    checkCommonHeader(v);
    if (v.snapshot_desc_size !== SNAPSHOT_DESC_SIZE) {
        throw new AbiError(`snapshot_desc_size ${v.snapshot_desc_size}, want ${SNAPSHOT_DESC_SIZE}`);
    }
    if (v.core_desc_size !== CORE_DESC_SIZE) {
        throw new AbiError(`core_desc_size ${v.core_desc_size}, want ${CORE_DESC_SIZE}`);
    }
    checkCoreCount(v);
    if (v.cores_addr === 0) {
        throw new AbiError(`core_count ${v.core_count} but cores_addr is 0`);
    }
    checkShaSize(v);
    if (v.app_elf_sha256_size === 32 && v.app_elf_sha256_addr === 0) {
        throw new AbiError('app_elf_sha256_size is 32 but app_elf_sha256_addr is 0');
    }
    const paramsAddr = v.encoder_params_addr;
    const paramsSize = v.encoder_params_size;
    if (Boolean(paramsAddr) !== Boolean(paramsSize)) {
        throw new AbiError(
            `encoder_params_addr 0x${paramsAddr.toString(16)} and encoder_params_size ${paramsSize} must both be zero or both nonzero`
        );
    }
    if (paramsAddr && paramsSize < ENCODER_PARAMS_SIZE) {
        throw new AbiError(`encoder_params_size ${paramsSize} < ${ENCODER_PARAMS_SIZE}`);
    }
    return {
        magic: v.magic,
        abi_major: v.abi_major,
        abi_minor: v.abi_minor,
        snapshot_desc_size: v.snapshot_desc_size,
        core_desc_size: v.core_desc_size,
        core_count: v.core_count,
        capture_reason: v.capture_reason,
        write_seq: v.write_seq,
        cores_addr: v.cores_addr,
        app_elf_sha256_addr: v.app_elf_sha256_addr,
        app_elf_sha256_size: v.app_elf_sha256_size,
        target_id: v.target_id,
        chip_revision: v.chip_revision,
        encoder_params_addr: v.encoder_params_addr,
        encoder_params_size: v.encoder_params_size,
    };
}

export function parseCoreDesc(data: Buffer | Uint8Array): CoreDesc {
    const b = asBuffer(data);
    need(b, CORE_DESC_SIZE, 'core descriptor');
    const v = {
        buffer_addr: b.readUInt32LE(0),
        capacity: b.readUInt32LE(4),
        head_offset: b.readUInt32LE(8),
        resync_threshold: b.readUInt32LE(12),
        fifo_status_raw: b.readUInt32LE(16),
        intr_status_raw: b.readUInt32LE(20),
        core_id: b.readUInt8(24),
        state: b.readUInt8(25),
        memory_mode: b.readUInt8(26),
        packet_format: b.readUInt8(27),
        address_mode: b.readUInt8(28),
        resync_mode: b.readUInt8(29),
        owner: b.readUInt8(30),
        head_valid: b.readUInt8(31),
        fifo_empty: b.readUInt8(32),
        memory_full: b.readUInt8(33),
        fifo_overflow: b.readUInt8(34),
        reserved: b.readUInt8(35),
    };
    checkFlags(v, 'core descriptor');
    const { buffer_addr: bufferAddr, capacity, head_offset: headOffset } = v;
    if (bufferAddr !== 0 && capacity !== 0) {
        if (headOffset > capacity) {
            throw new AbiError(`head_offset ${headOffset} exceeds capacity ${capacity}`);
        }
    } else if (bufferAddr !== 0 || capacity !== 0 || headOffset !== 0) {
        throw new AbiError('buffer_addr, capacity and head_offset must all be zero when the buffer is absent');
    } else if (v.head_valid) {
        throw new AbiError('head_valid set but buffer_addr or capacity is 0');
    }
    checkHead(v);
    return {
        core_id: v.core_id,
        state: v.state,
        buffer_addr: v.buffer_addr,
        capacity: v.capacity,
        head_offset: v.head_offset,
        memory_mode: v.memory_mode,
        packet_format: v.packet_format,
        address_mode: v.address_mode,
        resync_mode: v.resync_mode,
        owner: v.owner,
        head_valid: v.head_valid,
        fifo_empty: v.fifo_empty,
        memory_full: v.memory_full,
        fifo_overflow: v.fifo_overflow,
        resync_threshold: v.resync_threshold,
        fifo_status_raw: v.fifo_status_raw,
        intr_status_raw: v.intr_status_raw,
    };
}

const ENCODER_PARAM_FIELDS = [
    'arch_p',
    'bpred_size_p',
    'cache_size_p',
    'call_counter_size_p',
    'ctype_width_p',
    'context_width_p',
    'ecause_width_p',
    'ecause_choice_p',
    'f0s_width_p',
    'filter_context_p',
    'filter_excint_p',
    'filter_privilege_p',
    'filter_tval_p',
    'iaddress_lsb_p',
    'iaddress_width_p',
    'iretire_width_p',
    'ilastsize_width_p',
    'itype_width_p',
    'nocontext_p',
    'notime_p',
    'privilege_width_p',
    'retires_p',
    'return_stack_size_p',
    'sijump_p',
    'taken_branches_p',
    'impdef_width_p',
] as const;

export function parseEncoderParams(data: Buffer | Uint8Array): EncoderParams {
    const b = asBuffer(data);
    need(b, ENCODER_PARAMS_SIZE, 'encoder params');
    const v: Record<string, number> = {
        params_version: b.readUInt8(0),
        params_size: b.readUInt8(1),
    };
    ENCODER_PARAM_FIELDS.forEach((name, i) => {
        v[name] = b.readUInt8(2 + i);
    });
    if (v.params_version !== ENCODER_PARAMS_VERSION) {
        throw new AbiError(`params_version ${v.params_version}, want ${ENCODER_PARAMS_VERSION}`);
    }
    if (v.params_size !== ENCODER_PARAMS_SIZE) {
        throw new AbiError(`params_size ${v.params_size}, want ${ENCODER_PARAMS_SIZE}`);
    }
    return v as unknown as EncoderParams;
}

export function parseNoteHeader(data: Buffer | Uint8Array): NoteHeader {
    const b = asBuffer(data);
    need(b, NOTE_HEADER_SIZE, 'note header');
    const v = {
        magic: b.readUInt32LE(0),
        write_seq: b.readUInt32LE(4),
        target_id: b.readUInt16LE(8),
        chip_revision: b.readUInt16LE(10),
        abi_major: b.readUInt8(12),
        abi_minor: b.readUInt8(13),
        note_header_size: b.readUInt8(14),
        note_record_size: b.readUInt8(15),
        core_count: b.readUInt8(16),
        capture_reason: b.readUInt8(17),
        app_elf_sha256_size: b.readUInt8(18),
        encoder_params_size: b.readUInt8(19),
        app_elf_sha256: Buffer.from(b.subarray(20, 52)),
        encoder_params_blob: b.subarray(52, 80),
    };
    checkCommonHeader(v);
    if (v.note_header_size !== NOTE_HEADER_SIZE) {
        throw new AbiError(`note_header_size ${v.note_header_size}, want ${NOTE_HEADER_SIZE}`);
    }
    if (v.note_record_size !== NOTE_RECORD_SIZE) {
        throw new AbiError(`note_record_size ${v.note_record_size}, want ${NOTE_RECORD_SIZE}`);
    }
    checkCoreCount(v);
    checkShaSize(v);
    if (v.app_elf_sha256_size === 0 && v.app_elf_sha256.some((byte) => byte !== 0)) {
        throw new AbiError('app_elf_sha256 area is non-zero while size is 0');
    }
    const paramsSize = v.encoder_params_size;
    if (paramsSize !== 0 && paramsSize !== ENCODER_PARAMS_SIZE) {
        throw new AbiError(`encoder_params_size ${paramsSize}, want 0 or ${ENCODER_PARAMS_SIZE}`);
    }
    let params: EncoderParams | undefined;
    if (paramsSize === ENCODER_PARAMS_SIZE) {
        params = parseEncoderParams(v.encoder_params_blob);
    } else if (v.encoder_params_blob.some((byte) => byte !== 0)) {
        throw new AbiError('encoder params area is non-zero while encoder_params_size is 0');
    }
    return {
        magic: v.magic,
        abi_major: v.abi_major,
        abi_minor: v.abi_minor,
        note_header_size: v.note_header_size,
        note_record_size: v.note_record_size,
        core_count: v.core_count,
        capture_reason: v.capture_reason,
        write_seq: v.write_seq,
        target_id: v.target_id,
        chip_revision: v.chip_revision,
        app_elf_sha256_size: v.app_elf_sha256_size,
        app_elf_sha256: v.app_elf_sha256,
        encoder_params_size: v.encoder_params_size,
        encoder_params: params,
    };
}

export function parseNoteRecord(data: Buffer | Uint8Array): NoteRecord {
    const b = asBuffer(data);
    need(b, NOTE_RECORD_SIZE, 'note record');
    const v = {
        core_id: b.readUInt8(0),
        state: b.readUInt8(1),
        memory_mode: b.readUInt8(2),
        packet_format: b.readUInt8(3),
        address_mode: b.readUInt8(4),
        resync_mode: b.readUInt8(5),
        owner: b.readUInt8(6),
        head_valid: b.readUInt8(7),
        fifo_empty: b.readUInt8(8),
        memory_full: b.readUInt8(9),
        fifo_overflow: b.readUInt8(10),
        reserved: b.readUInt8(11),
        segment_index: b.readUInt32LE(12),
        segment_vaddr: b.readUInt32LE(16),
        segment_size: b.readUInt32LE(20),
        capacity: b.readUInt32LE(24),
        head_offset: b.readUInt32LE(28),
        resync_threshold: b.readUInt32LE(32),
        fifo_status_raw: b.readUInt32LE(36),
        intr_status_raw: b.readUInt32LE(40),
    };
    checkFlags(v, 'note record');
    const { capacity, head_offset: headOffset } = v;
    if (v.segment_index !== NOTE_NO_SEGMENT) {
        if (v.segment_vaddr === 0 || v.segment_size === 0) {
            throw new AbiError('segment_index is set but segment_vaddr or segment_size is 0');
        }
        if (capacity !== v.segment_size) {
            throw new AbiError(`capacity ${capacity} does not match segment_size ${v.segment_size}`);
        }
        if (headOffset > capacity) {
            throw new AbiError(`head_offset ${headOffset} exceeds capacity ${capacity}`);
        }
    } else {
        if (v.segment_vaddr !== 0 || v.segment_size !== 0) {
            throw new AbiError('segment_index is NO_SEGMENT but segment_vaddr or segment_size is set');
        }
        if (capacity !== 0) {
            throw new AbiError('buffer is absent but capacity is set');
        }
    }
    checkHead(v);
    return {
        core_id: v.core_id,
        state: v.state,
        segment_index: v.segment_index,
        segment_vaddr: v.segment_vaddr,
        segment_size: v.segment_size,
        capacity: v.capacity,
        head_offset: v.head_offset,
        memory_mode: v.memory_mode,
        packet_format: v.packet_format,
        address_mode: v.address_mode,
        resync_mode: v.resync_mode,
        owner: v.owner,
        head_valid: v.head_valid,
        fifo_empty: v.fifo_empty,
        memory_full: v.memory_full,
        fifo_overflow: v.fifo_overflow,
        resync_threshold: v.resync_threshold,
        fifo_status_raw: v.fifo_status_raw,
        intr_status_raw: v.intr_status_raw,
    };
}

export function parseNoteRecords(data: Buffer | Uint8Array, coreCount: number): NoteRecord[] {
    if (coreCount <= 0 || coreCount > CORE_COUNT_MAX) {
        throw new AbiError(`core_count ${coreCount} out of range 1..${CORE_COUNT_MAX}`);
    }
    const b = asBuffer(data);
    const needBytes = coreCount * NOTE_RECORD_SIZE;
    if (b.length < needBytes) {
        throw new AbiError(`note record array needs ${needBytes} bytes, got ${b.length}`);
    }
    const records: NoteRecord[] = [];
    for (let i = 0; i < coreCount; i++) {
        const off = i * NOTE_RECORD_SIZE;
        records.push(parseNoteRecord(b.subarray(off, off + NOTE_RECORD_SIZE)));
    }
    return records;
}

export function parseNote(body: Buffer | Uint8Array): { header: NoteHeader; records: NoteRecord[] } {
    const b = asBuffer(body);
    const header = parseNoteHeader(b.subarray(0, NOTE_HEADER_SIZE));
    const expected = NOTE_HEADER_SIZE + header.core_count * NOTE_RECORD_SIZE;
    if (b.length !== expected) {
        throw new AbiError(
            `note body length ${b.length} does not match expected ${expected} for core_count ${header.core_count}`
        );
    }
    const records = parseNoteRecords(b.subarray(NOTE_HEADER_SIZE), header.core_count);
    return { header, records };
}

function checkFlags(
    v: Record<string, number>,
    what: string
): void {
    for (const name of FLAG_FIELDS) {
        if (v[name] !== 0 && v[name] !== 1) {
            throw new AbiError(`${name} ${v[name]}, want 0 or 1`);
        }
    }
    if (v.reserved !== 0) {
        throw new AbiError(`${what} reserved byte ${v.reserved}, want 0`);
    }
}

function checkHead(v: { head_valid: number; head_offset: number }): void {
    if (!v.head_valid && v.head_offset !== 0) {
        throw new AbiError(`head_valid is 0 but head_offset is ${v.head_offset}`);
    }
}
