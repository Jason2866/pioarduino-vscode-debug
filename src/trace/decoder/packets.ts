// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/packets.py (Apache-2.0).

import { Frame } from './framing';
import { DecoderProfile, profileAddressBits, profilePcFromRaw } from './params';

// TRM 3.6.3 payload format prefix (bits 0..1 of payload byte 0).
export const FORMAT_F0 = 0;
export const FORMAT_F1 = 1;
export const FORMAT_F2 = 2;
export const FORMAT_F3 = 3;

// TRM 3.6.3.1 Format 3 subformat encoding (bits 2..3 of payload byte 0).
export const F3_SYNC = 0;
export const F3_TRAP = 1;
export const F3_CONTEXT = 2;
export const F3_SUPPORT = 3;

// TRM support packet qual_status value for an ended trace whose preceding packet names the last traced instruction
export const QUAL_STATUS_ENDED_REP = 1;
// TRM support packet qual_status value for an ended trace with a pending updiscon
export const QUAL_STATUS_ENDED_NTR = 3;

export const FORMAT_BITS = 2;
export const SUBFORMAT_BITS = 2;
export const BRANCHES_BITS = 5;
export const BRANCHES_MAX = (1 << BRANCHES_BITS) - 1;
export const NO_ADDR_BRANCH_MAP_BITS = 31;

export class PacketParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PacketParseError';
    }
}

/** LSB-first bit reader over a byte payload. Uses BigInt because payloads can exceed 53 bits. */
export class BitReader {
    private readonly buf: bigint;
    private readonly nbits: number;
    private pos = 0;

    constructor(data: Buffer) {
        let value = 0n;
        for (let i = data.length - 1; i >= 0; i--) {
            value = (value << 8n) | BigInt(data[i]);
        }
        this.buf = value;
        this.nbits = data.length * 8;
    }

    get totalBits(): number {
        return this.nbits;
    }

    remaining(): number {
        return this.nbits - this.pos;
    }

    read(n: number): number {
        if (n < 0 || this.pos + n > this.nbits) {
            throw new PacketParseError(`read ${n} bits past end (pos ${this.pos}, total ${this.nbits})`);
        }
        const mask = (1n << BigInt(n)) - 1n;
        const value = Number((this.buf >> BigInt(this.pos)) & mask);
        this.pos += n;
        return value;
    }

    skip(n: number): void {
        if (n < 0 || this.pos + n > this.nbits) {
            throw new PacketParseError(`skip ${n} bits past end (pos ${this.pos}, total ${this.nbits})`);
        }
        this.pos += n;
    }
}

interface PacketBase {
    frame: Frame;
}

export type PacketKind =
    | 'sync'
    | 'trap'
    | 'context'
    | 'support'
    | 'format2'
    | 'format1_with_addr'
    | 'format1_no_addr'
    | 'format0';

export interface SyncPacket extends PacketBase {
    kind: 'sync';
    branch: number;
    privilege: number;
    raw_address: number;
    pc: number;
}

export interface TrapPacket extends PacketBase {
    kind: 'trap';
    branch: number;
    privilege: number;
    ecause: number;
    interrupt: number;
    thaddr: number | undefined;
    raw_address: number;
    address_pc: number;
    tval: number | undefined;
}

export interface ContextPacket extends PacketBase {
    kind: 'context';
}

export interface SupportPacket extends PacketBase {
    kind: 'support';
    enable: number;
    qual_status: number;
    encoder_mode: number | undefined;
    ioptions: number | undefined;
    full_address_mode: boolean | undefined;
}

export interface Format2Packet extends PacketBase {
    kind: 'format2';
    notify: number;
    updiscon: number;
    raw_address: number;
    address_width_bits: number;
}

export interface Format1WithAddrPacket extends PacketBase {
    kind: 'format1_with_addr';
    branches: number;
    branch_map: number;
    branch_map_width_bits: number;
    notify: number;
    updiscon: number;
    raw_address: number;
    address_width_bits: number;
}

export interface Format1NoAddrPacket extends PacketBase {
    kind: 'format1_no_addr';
    branches: number;
    branch_map: number;
}

export interface Format0Packet extends PacketBase {
    kind: 'format0';
}

export type Packet =
    | SyncPacket
    | TrapPacket
    | ContextPacket
    | SupportPacket
    | Format2Packet
    | Format1WithAddrPacket
    | Format1NoAddrPacket
    | Format0Packet;

export type FieldReader = (frame: Frame, reader: BitReader, profile: DecoderProfile) => Packet;
export type Format1WithAddrReader = (
    frame: Frame,
    reader: BitReader,
    profile: DecoderProfile,
    branches: number
) => Packet;

export interface FormatReaders {
    trap: FieldReader;
    support: FieldReader;
    f2: FieldReader;
    f1_with_addr: Format1WithAddrReader;
}

export function branchMapWidth(branches: number): number {
    if (branches < 1 || branches > BRANCHES_MAX) {
        throw new PacketParseError(`branches ${branches} out of range 1..${BRANCHES_MAX} for Format 1 with address`);
    }
    return (1 << branches.toString(2).length) - 1;
}

export function parsePacket(frame: Frame, profile: DecoderProfile, readers: FormatReaders): Packet {
    const reader = new BitReader(frame.payload);
    const fmt = reader.read(FORMAT_BITS);
    if (fmt === FORMAT_F3) {
        const subformat = reader.read(SUBFORMAT_BITS);
        if (subformat === F3_SYNC) {
            return parseSync(frame, reader, profile);
        }
        if (subformat === F3_TRAP) {
            return readers.trap(frame, reader, profile);
        }
        if (subformat === F3_CONTEXT) {
            return { kind: 'context', frame };
        }
        return readers.support(frame, reader, profile);
    }
    if (fmt === FORMAT_F2) {
        return readers.f2(frame, reader, profile);
    }
    if (fmt === FORMAT_F1) {
        const branches = reader.read(BRANCHES_BITS);
        if (branches === 0) {
            return {
                kind: 'format1_no_addr',
                frame,
                branches: 0,
                branch_map: reader.read(NO_ADDR_BRANCH_MAP_BITS),
            };
        }
        return readers.f1_with_addr(frame, reader, profile, branches);
    }
    return { kind: 'format0', frame };
}

function parseSync(frame: Frame, reader: BitReader, profile: DecoderProfile): SyncPacket {
    const branch = reader.read(1);
    const privilege = reader.read(profile.privilege_width);
    const rawAddress = reader.read(profileAddressBits(profile));
    return {
        kind: 'sync',
        frame,
        branch,
        privilege,
        raw_address: rawAddress,
        pc: profilePcFromRaw(profile, rawAddress),
    };
}
