// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/params.py (Apache-2.0).

import { TraceError } from '../errors';
import * as abi from '../snapshot/abi';
import { isRiscvTraceChip } from '../snapshot/chip';

export class ParamsError extends TraceError {}

export interface DecoderProfile {
    chip: string;
    packet_format: abi.PacketFormat;
    iaddress_width: number;
    iaddress_lsb: number;
    privilege_width: number;
    ecause_width: number;
}

export function profileAddressBits(profile: DecoderProfile): number {
    return profile.iaddress_width - profile.iaddress_lsb;
}

export function profilePcFromRaw(profile: DecoderProfile, rawAddress: number): number {
    // `<<` yields a signed int32; PCs at or above 0x80000000 must stay unsigned.
    return (rawAddress << profile.iaddress_lsb) >>> 0;
}

const ET20 = abi.PacketFormat.EFFICIENT_TRACE_2_0;
const PT10 = abi.PacketFormat.PROCESSOR_TRACE_1_0;

function make(chip: string, packetFormat: abi.PacketFormat, privilegeWidth: number, ecauseWidth: number): DecoderProfile {
    return {
        chip,
        packet_format: packetFormat,
        iaddress_width: 32,
        iaddress_lsb: 1,
        privilege_width: privilegeWidth,
        ecause_width: ecauseWidth,
    };
}

const CHIP_DEFAULTS: Record<string, DecoderProfile> = {
    esp32c5: make('esp32c5', ET20, 1, 6),
    esp32c61: make('esp32c61', ET20, 1, 6),
    esp32h4: make('esp32h4', ET20, 1, 6),
    esp32p4: make('esp32p4', ET20, 1, 6),
    esp32s31: make('esp32s31', ET20, 2, 6),
    esp32c6: make('esp32c6', PT10, 1, 5),
    esp32h2: make('esp32h2', PT10, 1, 5),
    esp32h21: make('esp32h21', PT10, 1, 5),
};

export function defaultProfile(chip: string): DecoderProfile {
    const key = chip.trim().toLowerCase();
    if (!isRiscvTraceChip(key)) {
        throw new ParamsError(`chip ${JSON.stringify(chip)} has no supported trace encoder`);
    }
    const profile = CHIP_DEFAULTS[key];
    if (!profile) {
        throw new ParamsError(`no fallback profile for chip ${JSON.stringify(chip)}`);
    }
    return profile;
}

function checkSnapshotParams(chip: string, params: abi.EncoderParams): void {
    if (params.iaddress_width_p <= params.iaddress_lsb_p) {
        throw new ParamsError(
            `chip ${chip} snapshot iaddress_width_p ${params.iaddress_width_p} must exceed iaddress_lsb_p ${params.iaddress_lsb_p}`
        );
    }
    if (params.iaddress_width_p > 64) {
        throw new ParamsError(`chip ${chip} snapshot iaddress_width_p ${params.iaddress_width_p} exceeds 64`);
    }
    if (params.privilege_width_p === 0 || params.privilege_width_p > 3) {
        throw new ParamsError(`chip ${chip} snapshot privilege_width_p ${params.privilege_width_p} out of range 1..3`);
    }
    if (params.ecause_width_p === 0 || params.ecause_width_p > 6) {
        throw new ParamsError(`chip ${chip} snapshot ecause_width_p ${params.ecause_width_p} out of range 1..6`);
    }
}

export function resolveProfile(chip: string, params?: abi.EncoderParams): DecoderProfile {
    const base = defaultProfile(chip);
    if (params === undefined) {
        return base;
    }
    checkSnapshotParams(base.chip, params);
    return {
        chip: base.chip,
        packet_format: base.packet_format,
        iaddress_width: params.iaddress_width_p,
        iaddress_lsb: params.iaddress_lsb_p,
        privilege_width: params.privilege_width_p,
        ecause_width: params.ecause_width_p,
    };
}
