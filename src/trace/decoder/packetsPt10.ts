// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/packets_pt10.py (Apache-2.0).

import { Frame } from './framing';
import {
    BitReader,
    FormatReaders,
    Packet,
    TrapPacket,
    Format2Packet,
    Format1WithAddrPacket,
    SupportPacket,
    branchMapWidth,
    parsePacket,
} from './packets';
import { DecoderProfile, profileAddressBits, profilePcFromRaw } from './params';

export function parsePt10(frame: Frame, profile: DecoderProfile): Packet {
    return parsePacket(frame, profile, READERS);
}

function parseTrap(frame: Frame, reader: BitReader, profile: DecoderProfile): TrapPacket {
    const branch = reader.read(1);
    const privilege = reader.read(profile.privilege_width);
    const ecause = reader.read(profile.ecause_width);
    const interrupt = reader.read(1);
    const rawAddress = reader.read(profileAddressBits(profile));
    const tval = reader.read(profile.iaddress_width);
    return {
        kind: 'trap',
        frame,
        branch,
        privilege,
        ecause,
        interrupt,
        thaddr: undefined,
        raw_address: rawAddress,
        address_pc: profilePcFromRaw(profile, rawAddress),
        tval,
    };
}

function parseSupport(frame: Frame, reader: BitReader, profile: DecoderProfile): SupportPacket {
    const enable = reader.read(1);
    const qualStatus = reader.read(2);
    return {
        kind: 'support',
        frame,
        enable,
        qual_status: qualStatus,
        encoder_mode: undefined,
        ioptions: undefined,
        full_address_mode: undefined,
    };
}

function parseF2(frame: Frame, reader: BitReader, profile: DecoderProfile): Format2Packet {
    const rawAddress = reader.read(profileAddressBits(profile));
    const notify = reader.read(1);
    const updiscon = reader.read(1);
    return {
        kind: 'format2',
        frame,
        notify,
        updiscon,
        raw_address: rawAddress,
        address_width_bits: profileAddressBits(profile),
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
    const rawAddress = reader.read(profileAddressBits(profile));
    const notify = reader.read(1);
    const updiscon = reader.read(1);
    return {
        kind: 'format1_with_addr',
        frame,
        branches,
        branch_map: branchMap,
        branch_map_width_bits: width,
        notify,
        updiscon,
        raw_address: rawAddress,
        address_width_bits: profileAddressBits(profile),
    };
}

const READERS: FormatReaders = {
    trap: parseTrap,
    support: parseSupport,
    f2: parseF2,
    f1_with_addr: parseF1WithAddr,
};
