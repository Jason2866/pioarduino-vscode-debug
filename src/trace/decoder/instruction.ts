// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/instruction.py (Apache-2.0).

import { InsnClass, LinkKind } from '../ir/events';
import {
    InsnError,
    OPCODE_BRANCH,
    OPCODE_JAL,
    OPCODE_JALR,
    OPCODE_MASK,
    OPCODE_SYSTEM,
    QUADRANT_MASK,
    RA,
    T0,
    bImm,
    cbImm,
    cjImm,
    insnLength,
    jImm,
    zcmMnemonic,
} from './encoding';

// Program counters are 32 bits wide
const PC_MASK = 0xffffffff;

export interface DecodedInsn {
    length: number; // 2 or 4 bytes
    cls: InsnClass;
    direct_target: number | undefined; // absolute byte PC for BRANCH and JUMP
    link: LinkKind;
}

function makeInsn(length: number, cls: InsnClass, directTarget?: number, link: LinkKind = LinkKind.NONE): DecodedInsn {
    return { length, cls, direct_target: directTarget, link };
}

/** Decode the instruction starting at ``pc``. */
export function decodeInsn(pc: number, insnBytes: Buffer): DecodedInsn {
    if (insnBytes.length < 2) {
        throw new InsnError(`instruction at 0x${pc.toString(16).padStart(8, '0')} needs at least 2 bytes, got ${insnBytes.length}`);
    }
    const hw0 = insnBytes[0] | (insnBytes[1] << 8);
    const ilen = insnLength(hw0);
    if (insnBytes.length < ilen) {
        throw new InsnError(`instruction at 0x${pc.toString(16).padStart(8, '0')} needs ${ilen} bytes, got ${insnBytes.length}`);
    }
    if (ilen === 2) {
        return decodeRvc(pc, hw0);
    }
    const insn = (hw0 | (insnBytes[2] << 16) | (insnBytes[3] << 24)) >>> 0;
    return decodeRv32i(pc, insn);
}

// Valid branch funct3 values.
const BRANCH_FUNCT3 = new Set([0b000, 0b001, 0b100, 0b101, 0b110, 0b111]);

const LINK_REGS = new Set([RA, T0]);

// The Zcmp and Zcmt instructions that jump.
const ZCM_LINKS: Record<string, LinkKind> = {
    'cm.jt': LinkKind.JUMP,
    'cm.jalt': LinkKind.CALL,
    'cm.popret': LinkKind.RETURN,
    'cm.popretz': LinkKind.RETURN,
};

/** Return-address stack hint of a jump that writes ``rd`` and, when indirect, jumps through ``rs1``. */
function jumpLink(rd: number, rs1: number | undefined): LinkKind {
    const writesLink = LINK_REGS.has(rd);
    const readsLink = rs1 !== undefined && LINK_REGS.has(rs1);
    if (writesLink && readsLink) {
        return rd === rs1 ? LinkKind.CALL : LinkKind.COROUTINE;
    }
    if (writesLink) {
        return LinkKind.CALL;
    }
    if (readsLink) {
        return LinkKind.RETURN;
    }
    return LinkKind.JUMP;
}

function decodeRv32i(pc: number, insn: number): DecodedInsn {
    const opcode = insn & OPCODE_MASK;
    const rd = (insn >> 7) & 0x1f;
    if (opcode === OPCODE_BRANCH) {
        const funct3 = (insn >> 12) & 0x7;
        if (!BRANCH_FUNCT3.has(funct3)) {
            return makeInsn(4, InsnClass.NONE);
        }
        const target = (pc + bImm(insn)) & PC_MASK;
        return makeInsn(4, InsnClass.BRANCH, target);
    }
    if (opcode === OPCODE_JAL) {
        const target = (pc + jImm(insn)) & PC_MASK;
        return makeInsn(4, InsnClass.JUMP, target, jumpLink(rd, undefined));
    }
    if (opcode === OPCODE_JALR) {
        // JALR requires funct3 0.
        if (((insn >> 12) & 0x7) !== 0) {
            return makeInsn(4, InsnClass.NONE);
        }
        const rs1 = (insn >> 15) & 0x1f;
        return makeInsn(4, InsnClass.UNINFERABLE, undefined, jumpLink(rd, rs1));
    }
    if (opcode === OPCODE_SYSTEM) {
        return decodeSystem(insn);
    }
    return makeInsn(4, InsnClass.NONE);
}

function decodeSystem(insn: number): DecodedInsn {
    const funct3 = (insn >> 12) & 0x7;
    if (funct3 !== 0) {
        // Only funct3 0 encodes control-flow system instructions.
        return makeInsn(4, InsnClass.NONE);
    }
    if (insn === 0x00000073) {
        return makeInsn(4, InsnClass.TRAP);
    }
    if (insn === 0x00100073) {
        return makeInsn(4, InsnClass.TRAP);
    }
    if (insn === 0x30200073) {
        return makeInsn(4, InsnClass.UNINFERABLE, undefined, LinkKind.TRAP_RETURN);
    }
    if (insn === 0x10200073) {
        return makeInsn(4, InsnClass.UNINFERABLE, undefined, LinkKind.TRAP_RETURN);
    }
    return makeInsn(4, InsnClass.NONE);
}

function decodeRvc(pc: number, insn: number): DecodedInsn {
    const op = insn & QUADRANT_MASK;
    if (op === 0x1) {
        return decodeRvcOp01(pc, insn);
    }
    if (op === 0x2) {
        return decodeRvcOp10(insn);
    }
    // Quadrant 0 does not contain control flow instructions.
    return makeInsn(2, InsnClass.NONE);
}

function decodeRvcOp01(pc: number, insn: number): DecodedInsn {
    const funct3 = (insn >> 13) & 0x7;
    if (funct3 === 0x1) {
        // c.jal
        const target = (pc + cjImm(insn)) & PC_MASK;
        return makeInsn(2, InsnClass.JUMP, target, LinkKind.CALL);
    }
    if (funct3 === 0x5) {
        // c.j
        const target = (pc + cjImm(insn)) & PC_MASK;
        return makeInsn(2, InsnClass.JUMP, target, LinkKind.JUMP);
    }
    if (funct3 === 0x6 || funct3 === 0x7) {
        const target = (pc + cbImm(insn)) & PC_MASK;
        return makeInsn(2, InsnClass.BRANCH, target);
    }
    return makeInsn(2, InsnClass.NONE);
}

function decodeRvcOp10(insn: number): DecodedInsn {
    if (((insn >> 13) & 0x7) === 0x5) {
        return decodeZcm(insn);
    }
    const funct4 = (insn >> 12) & 0xf;
    const rs1 = (insn >> 7) & 0x1f;
    const rs2 = (insn >> 2) & 0x1f;
    // CR-format control flow instructions require rs2 to be zero.
    if (rs2 !== 0) {
        return makeInsn(2, InsnClass.NONE);
    }
    if (funct4 === 0x8 && rs1 !== 0) {
        // c.jr
        return makeInsn(2, InsnClass.UNINFERABLE, undefined, jumpLink(0, rs1));
    }
    if (funct4 === 0x9) {
        if (rs1 === 0) {
            return makeInsn(2, InsnClass.TRAP);
        }
        // c.jalr
        return makeInsn(2, InsnClass.UNINFERABLE, undefined, jumpLink(RA, rs1));
    }
    return makeInsn(2, InsnClass.NONE);
}

function decodeZcm(insn: number): DecodedInsn {
    const mnemonic = zcmMnemonic(insn);
    const link = mnemonic !== undefined ? ZCM_LINKS[mnemonic] : undefined;
    if (link === undefined) {
        // cm.push, cm.pop, cm.mva01s, cm.mvsa01 and reserved forms
        return makeInsn(2, InsnClass.NONE);
    }
    return makeInsn(2, InsnClass.UNINFERABLE, undefined, link);
}
