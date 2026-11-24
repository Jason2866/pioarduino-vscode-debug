// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/containers/espt.py (Apache-2.0).

import * as fs from 'fs';
import * as path from 'path';
import { AbiError, ContainerError } from '../errors';
import * as abi from '../snapshot/abi';
import { Capture, TraceBuffer, traceBufferFromRecord, validateCapture } from './base';

export const MAGIC = Buffer.from('ESPT', 'latin1');
export const VERSION = 1;

const PREAMBLE_SIZE = 8; // u32 magic, u16 version, u16 hdr_size
const OFF_SNAPSHOT = PREAMBLE_SIZE;
const OFF_PARAMS = OFF_SNAPSHOT + abi.SNAPSHOT_DESC_SIZE;
const OFF_SHA256 = OFF_PARAMS + abi.ENCODER_PARAMS_SIZE;
const SHA256_SIZE = 32;
const HDR_SIZE = OFF_SHA256 + SHA256_SIZE;

const RECORD_HEADER_SIZE = 8; // u8 type, u8 core, u16 flags, u32 len

const REC_CORE_DESC = 1;
const REC_DATA = 2;
const REC_END = 3;

const END_OK = 0;
const END_FIFO_NOT_EMPTY = 1;

/** Return true when ``headBytes`` starts with the ESPT magic. */
export function sniff(headBytes: Buffer | Uint8Array): boolean {
    const b = Buffer.isBuffer(headBytes) ? headBytes : Buffer.from(headBytes);
    return b.length >= 4 && b.subarray(0, 4).equals(MAGIC);
}

export function load(filePath: string): Capture {
    const p = path.resolve(filePath);
    const data = fs.readFileSync(p);
    if (data.length < HDR_SIZE) {
        throw new ContainerError(`${p} is only ${data.length} bytes, need at least ${HDR_SIZE} for the ESPT header`);
    }

    if (!data.subarray(0, 4).equals(MAGIC)) {
        throw new ContainerError(`${p} does not start with the ESPT magic`);
    }
    const version = data.readUInt16LE(4);
    const hdrSize = data.readUInt16LE(6);
    if (version !== VERSION) {
        throw new ContainerError(`${p} has ESPT version ${version}, this decoder supports ${VERSION}`);
    }
    if (hdrSize < HDR_SIZE || hdrSize > data.length) {
        throw new ContainerError(`${p} has invalid ESPT header size ${hdrSize}`);
    }

    let snap: abi.SnapshotDesc;
    let params: abi.EncoderParams | undefined;
    try {
        snap = abi.parseSnapshotDesc(data.subarray(OFF_SNAPSHOT, OFF_PARAMS));
        // The snapshot descriptor marks the encoder-params slot absent when
        // both address and size are zero; the fixed slot in the file header is
        // then unused and may be zero-filled.
        const paramsSlot = data.subarray(OFF_PARAMS, OFF_SHA256);
        const paramsAbsent =
            (snap.encoder_params_addr === 0 && snap.encoder_params_size === 0) ||
            paramsSlot.every((byte) => byte === 0);
        params = paramsAbsent ? undefined : abi.parseEncoderParams(paramsSlot);
    } catch (error) {
        if (error instanceof AbiError) {
            throw new ContainerError(`${p} has an invalid ESPT header. ${error.message}`);
        }
        throw error;
    }

    let shaBytes: Buffer | undefined;
    if (snap.app_elf_sha256_size === SHA256_SIZE) {
        shaBytes = Buffer.from(data.subarray(OFF_SHA256, HDR_SIZE));
    }

    const buffers: TraceBuffer[] = [];
    let coreDesc: abi.CoreDesc | undefined;
    let endStatus: number | undefined;
    let off = hdrSize;
    while (off < data.length) {
        if (endStatus !== undefined) {
            throw new ContainerError(`${p} has data after the END record at offset ${off}`);
        }
        if (data.length - off < RECORD_HEADER_SIZE) {
            throw new ContainerError(`${p} truncated in a record header at offset ${off}`);
        }
        const rtype = data.readUInt8(off);
        const core = data.readUInt8(off + 1);
        // flags at off+2 (u16) are ignored, matching upstream.
        const length = data.readUInt32LE(off + 4);
        const payloadOff = off + RECORD_HEADER_SIZE;
        const payloadEnd = payloadOff + length;
        if (payloadEnd > data.length) {
            throw new ContainerError(`${p} record type ${rtype} at offset ${off} is truncated`);
        }
        const payload = data.subarray(payloadOff, payloadEnd);
        const recordOffset = off;
        off = payloadEnd;

        if (rtype === REC_CORE_DESC) {
            try {
                coreDesc = abi.parseCoreDesc(payload);
            } catch (error) {
                if (error instanceof AbiError) {
                    throw new ContainerError(`${p} core ${core} descriptor invalid. ${error.message}`);
                }
                throw error;
            }
            if (coreDesc.core_id !== core) {
                throw new ContainerError(`${p} CORE_DESC record core ${core} holds core_id ${coreDesc.core_id}`);
            }
        } else if (rtype === REC_DATA) {
            if (coreDesc === undefined || coreDesc.core_id !== core) {
                throw new ContainerError(`${p} DATA record for core ${core} has no matching CORE_DESC`);
            }
            if (length !== coreDesc.capacity) {
                throw new ContainerError(
                    `${p} core ${core} DATA is ${length} bytes, descriptor capacity is ${coreDesc.capacity}`
                );
            }
            buffers.push(traceBufferFromRecord(coreDesc, Buffer.from(payload), params, undefined));
            coreDesc = undefined;
        } else if (rtype === REC_END) {
            if (length !== 4) {
                throw new ContainerError(`${p} END record has ${length} bytes, expected 4`);
            }
            endStatus = payload.readUInt32LE(0);
        } else {
            throw new ContainerError(`${p} has unknown record type ${rtype} at offset ${recordOffset}`);
        }
    }

    if (endStatus === undefined) {
        throw new ContainerError(`${p} has no END record, the file is truncated`);
    }
    if (endStatus !== END_OK && endStatus !== END_FIFO_NOT_EMPTY) {
        throw new ContainerError(`${p} capture ended with status ${endStatus}`);
    }

    const capture: Capture = {
        source: 'espt',
        source_path: p,
        abi_major: snap.abi_major,
        abi_minor: snap.abi_minor,
        capture_reason: snap.capture_reason,
        write_seq: snap.write_seq,
        target_id: snap.target_id,
        chip_revision: snap.chip_revision,
        app_elf_sha256: shaBytes,
        cores: buffers,
        fifo_emptied: endStatus === END_OK,
    };
    validateCapture(capture);
    return capture;
}
