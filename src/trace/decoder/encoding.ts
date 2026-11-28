// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/encoding.py (Apache-2.0).

import { TraceError } from '../errors';

// Registers are 32 bits wide
export const MASK32 = 0xffffffff;

// Bytes of a register and of a stack slot
export const XLEN_BYTES = 4;

export const RA = 1;
export const SP = 2;
export const GP = 3;
export const TP = 4;
export const T0 = 5;
export const A0 = 10;
export const A1 = 11;
// s0 to s11
export const S_REGS = [8, 9, ...Array.from({ length: 10 }, (_, i) => 18 + i)];

// ecall has no compressed form
export const ECALL_LENGTH = 4;

// Bits 1..0 of the first parcel, which are 0b11 for a 32-bit instruction
export const QUADRANT_MASK = 0x3;
export const QUADRANT_32BIT = 0x3;
export const OPCODE_MASK = 0x7f;
export const OPCODE_LOAD = 0x03;
export const OPCODE_LOAD_FP = 0x07;
export const OPCODE_MISC_MEM = 0x0f;
export const OPCODE_OP_IMM = 0x13;
export const OPCODE_AUIPC = 0x17;
export const OPCODE_STORE = 0x23;
export const OPCODE_STORE_FP = 0x27;
export const OPCODE_AMO = 0x2f;
export const OPCODE_OP = 0x33;
export const OPCODE_LUI = 0x37;
export const OPCODE_MADD = 0x43;
export const OPCODE_MSUB = 0x47;
export const OPCODE_NMSUB = 0x4b;
export const OPCODE_NMADD = 0x4f;
export const OPCODE_OP_FP = 0x53;
export const OPCODE_BRANCH = 0x63;
export const OPCODE_JALR = 0x67;
export const OPCODE_JAL = 0x6f;
export const OPCODE_SYSTEM = 0x73;

// ABI names by register number
export const REG_NAMES = [
    'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
    's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
    'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
    's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
];

/** Return the ABI name of register ``x<reg>``. */
export function regName(reg: number): string {
    return REG_NAMES[reg];
}

export class InsnError extends TraceError {}

/** Return the encoded instruction length in bytes. */
export function insnLength(firstHalfword: number): number {
    if ((firstHalfword & QUADRANT_MASK) !== QUADRANT_32BIT) {
        return 2;
    }
    if ((firstHalfword & 0x3f) === 0x3f) {
        // bits 6..0 equal 0b0111111 or 0b1111111 flag a 64-bit or longer encoding
        throw new InsnError(`encoding wider than 32 bits (halfword 0x${firstHalfword.toString(16).padStart(4, '0')}) is unsupported`);
    }
    return 4;
}

/** Return the low ``bits`` of ``value`` as a two's complement number. */
export function signExtend(value: number, bits: number): number {
    const sign = 1 << (bits - 1);
    return (value & ((1 << bits) - 1)) - ((value & sign) << 1);
}

/** B-type immediate (BEQ, BNE, BLT, BGE, BLTU, BGEU). */
export function bImm(insn: number): number {
    let imm = ((insn >> 31) & 1) << 12;
    imm |= ((insn >> 25) & 0x3f) << 5;
    imm |= ((insn >> 8) & 0xf) << 1;
    imm |= ((insn >> 7) & 1) << 11;
    return signExtend(imm, 13);
}

/** J-type immediate (JAL). */
export function jImm(insn: number): number {
    let imm = ((insn >> 31) & 1) << 20;
    imm |= ((insn >> 21) & 0x3ff) << 1;
    imm |= ((insn >> 20) & 1) << 11;
    imm |= ((insn >> 12) & 0xff) << 12;
    return signExtend(imm, 21);
}

/** CB-type immediate (C.BEQZ, C.BNEZ). */
export function cbImm(insn: number): number {
    let imm = ((insn >> 12) & 1) << 8;
    imm |= ((insn >> 10) & 0x3) << 3;
    imm |= ((insn >> 5) & 0x3) << 6;
    imm |= ((insn >> 3) & 0x3) << 1;
    imm |= ((insn >> 2) & 1) << 5;
    return signExtend(imm, 9);
}

/** CJ-type immediate (C.J, C.JAL). */
export function cjImm(insn: number): number {
    let imm = ((insn >> 12) & 1) << 11;
    imm |= ((insn >> 11) & 1) << 4;
    imm |= ((insn >> 9) & 0x3) << 8;
    imm |= ((insn >> 8) & 1) << 10;
    imm |= ((insn >> 7) & 1) << 6;
    imm |= ((insn >> 6) & 1) << 7;
    imm |= ((insn >> 3) & 0x7) << 1;
    imm |= ((insn >> 2) & 1) << 5;
    return signExtend(imm, 12);
}

// cm.push and the cm.pop forms by bits 12..8
const ZCMP_STACK: Record<number, string> = {
    0b11000: 'cm.push',
    0b11010: 'cm.pop',
    0b11100: 'cm.popretz',
    0b11110: 'cm.popret',
};
// Register lists in bits 7..4 below {ra} are reserved
export const ZCMP_RLIST_MIN = 4;
// cm.mvsa01 and cm.mva01s by bits 6..5, when bits 12..10 are 0b011
const ZCMP_MOVES: Record<number, string> = { 1: 'cm.mvsa01', 3: 'cm.mva01s' };
// cm.jt and cm.jalt share an index field. Indexes from this one up are cm.jalt.
export const ZCMT_JALT_MIN = 32;

/** Return the Zcmp or Zcmt mnemonic in the c.fsdsp slot of a 16-bit instruction, undefined when reserved. */
export function zcmMnemonic(insn: number): string | undefined {
    const stack = ZCMP_STACK[(insn >> 8) & 0x1f];
    if (stack !== undefined) {
        return ((insn >> 4) & 0xf) >= ZCMP_RLIST_MIN ? stack : undefined;
    }
    const form = (insn >> 10) & 0x7;
    if (form === 0b011) {
        const mnemonic = ZCMP_MOVES[(insn >> 5) & 0x3];
        // cm.mvsa01 cannot write one s register twice
        if (mnemonic === 'cm.mvsa01' && ((insn >> 7) & 0x7) === ((insn >> 2) & 0x7)) {
            return undefined;
        }
        return mnemonic;
    }
    if (form === 0) {
        return ((insn >> 2) & 0xff) >= ZCMT_JALT_MIN ? 'cm.jalt' : 'cm.jt';
    }
    return undefined;
}
