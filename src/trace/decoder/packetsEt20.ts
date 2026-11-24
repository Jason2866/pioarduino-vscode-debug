// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/packets_et20.py (Apache-2.0).

import { Frame } from './framing';
import {
    BRANCHES_BITS,
    FORMAT_BITS,
    BitReader,
    FormatReaders,
    Packet,
    PacketParseError,
    TrapPacket,
    Format2Packet,
    Format1WithAddrPacket,
    SupportPacket,
    branchMapWidth,
    parsePacket,
} from './packets';
import { DecoderProfile, profileAddressBits, profilePcFromRaw } from './params';

// Address field widths a Format 1 or Format 2 payload can end with
const ADDRESS_WIDTHS = new Set([8, 16, 24, 32]);
const F2_ZERO_EXTEND_BITS = 4;
// TRM 3.6.3.3 zero_ext width per branch_map width
const F1_ZERO_EXT_BITS: Record<number, number> = { 1: 6, 3: 4, 7: 0, 15: 0, 31: 0 };
const IOPTIONS_BITS = 6;
const IOPTIONS_FULL_ADDRESS_BIT = 2;

export function parseEt20(frame: Frame, profile: DecoderProfile): Packet {
    return parsePacket(frame, profile, READERS);
}

function parseTrap(frame: Frame, reader: BitReader, profile: DecoderProfile): TrapPacket {
    const branch = reader.read(1);
    const privilege = reader.read(profile.privilege_width);
    const ecause = reader.read(profile.ecause_width);
    const interrupt = reader.read(1);
    const thaddr = reader.read(1);
    const rawAddress = reader.read(profileAddressBits(profile));
    const tval = interrupt === 0 ? reader.read(profile.iaddress_width) : undefined;
    return {
        kind: 'trap',
        frame,
        branch,
        privilege,
        ecause,
        interrupt,
        thaddr,
        raw_address: rawAddress,
        address_pc: profilePcFromRaw(profile, rawAddress),
        tval,
    };
}

function parseSupport(frame: Frame, reader: BitReader, profile: DecoderProfile): SupportPacket {
    const enable = reader.read(1);
    const encoderMode = reader.read(1);
    const qualStatus = reader.read(2);
    const ioptions = reader.read(IOPTIONS_BITS);
    return {
        kind: 'support',
        frame,
        enable,
        qual_status: qualStatus,
        encoder_mode: encoderMode,
        ioptions,
        full_address_mode: Boolean((ioptions >> IOPTIONS_FULL_ADDRESS_BIT) & 1),
    };
}

function parseF2(frame: Frame, reader: BitReader, profile: DecoderProfile): Format2Packet {
    const notify = reader.read(1);
    const updiscon = reader.read(1);
    reader.skip(F2_ZERO_EXTEND_BITS);
    const addressBits = reader.remaining();
    if (!ADDRESS_WIDTHS.has(addressBits)) {
        throw new PacketParseError(`Format 2 address field is ${addressBits} bits, expected 8/16/24/32`);
    }
    return {
        kind: 'format2',
        frame,
        notify,
        updiscon,
        raw_address: reader.read(addressBits),
        address_width_bits: addressBits,
    };
}

function parseF1WithAddr(
    frame: Frame,
    reader: BitReader,
    profile: DecoderProfile,
    branches: number
): Format1WithAddrPacket {
    const width = branchMapWidth(branches);
    const branchMap = reader.read(width);
    const notify = reader.read(1);
    const updiscon = reader.read(1);
    const fixedBits = FORMAT_BITS + BRANCHES_BITS + width + 1 + 1;
    if (reader.totalBits - fixedBits <= 0) {
        throw new PacketParseError(
            `Format 1 with address has no room for zero_ext and address (payload ${reader.totalBits} bits, fixed ${fixedBits})`
        );
    }
    const zeroExt = F1_ZERO_EXT_BITS[width];
    reader.skip(zeroExt);
    const addressBits = reader.remaining();
    if (!ADDRESS_WIDTHS.has(addressBits)) {
        throw new PacketParseError(
            `Format 1 address field is ${addressBits} bits (branches ${branches}, branch_map_width ${width}, zero_ext ${zeroExt}), expected 8/16/24/32`
        );
    }
    return {
        kind: 'format1_with_addr',
        frame,
        branches,
        branch_map: branchMap,
        branch_map_width_bits: width,
        notify,
        updiscon,
        raw_address: reader.read(addressBits),
        address_width_bits: addressBits,
    };
}

const READERS: FormatReaders = {
    trap: parseTrap,
    support: parseSupport,
    f2: parseF2,
    f1_with_addr: parseF1WithAddr,
};
