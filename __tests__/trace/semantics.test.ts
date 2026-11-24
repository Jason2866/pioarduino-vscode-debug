// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace tests/test_semantics.py (Apache-2.0).

import {
    InsnError,
    REG_NAMES,
    insnLength,
} from '../../src/trace/decoder/encoding';
import { decodeInsn } from '../../src/trace/decoder/instruction';
import {
    InsnInfo,
    MemAccess,
    decodeAt,
    decodeInsnSemantics,
    evaluate,
    sources,
} from '../../src/trace/decoder/semantics';
import { InsnClass, LinkKind } from '../../src/trace/ir/events';
import { CodeImage, CodeReadError } from '../../src/trace/elf/image';

function reg(name: string): number {
    return REG_NAMES.indexOf(name);
}

function regs(...names: string[]): Set<number> {
    return new Set(names.map(reg));
}

const PC = 0x42000100;
const MASK32 = 0xffffffff;

// Encodings from riscv32-esp-elf-as
const EVALUATE_CASES: Array<[number, string, Record<string, number>, number]> = [
    [0x408007b7, 'a5', {}, 0x40800000], // lui a5,0x40800
    [0xffc78793, 'a5', { a5: 0x40800000 }, 0x407ffffc], // addi a5,a5,-4
    [0x00001517, 'a0', {}, (PC + 0x1000) >>> 0], // auipc a0,0x1
    [0x00500513, 'a0', {}, 5], // addi a0,zero,5 reads x0 as zero
    [0x57fd, 'a5', {}, 0xffffffff], // c.li a5,-1
    [0x87aa, 'a5', { a0: 0x1234 }, 0x1234], // c.mv a5,a0
    [0x00b50533, 'a0', { a0: 0xffffffff, a1: 1 }, 0], // add a0,a0,a1 wraps at 32 bits
    [0x40455513, 'a0', { a0: 0x80000000 }, 0xf8000000], // srai keeps the sign
    [0x20f747b3, 'a5', { a4: 3, a5: 0x1000 }, 0x100c], // sh2add a5,a4,a5
    [0x713d, 'sp', { sp: 0x3fc88000 }, 0x3fc87fe0], // c.addi16sp sp,-32
    [0x0808, 'a0', { sp: 0x3fc88000 }, 0x3fc88010], // c.addi4spn a0,sp,16
    [0x9ff5, 'a5', { a5: 0 }, 0xffffffff], // c.not a5
    [0x9fe1, 'a5', { a5: 0x1ff }, 0xff], // c.zext.b a5
    [0xff7ff0ef, 'ra', {}, (PC + 4) >>> 0], // jal ra writes the return address
    [0x9782, 'ra', {}, (PC + 2) >>> 0], // c.jalr a5
    [0xb862, 'sp', { sp: 0x3fc88000 }, 0x3fc87ff0], // cm.push {ra,s0-s1},-16
    [0xba62, 'sp', { sp: 0x3fc87ff0 }, 0x3fc88000], // cm.pop {ra,s0-s1},16
    [0xbef2, 'sp', { sp: 0x3fc87fc0 }, 0x3fc88000], // cm.popret {ra,s0-s11},64
    [0xbc42, 'a0', {}, 0], // cm.popretz {ra},16
    [0xad66, 'a0', { s2: 7, s1: 9 }, 7], // cm.mva01s s2,s1
    [0xad66, 'a1', { s2: 7, s1: 9 }, 9],
    [0xac26, 's1', { a0: 7, a1: 9 }, 9], // cm.mvsa01 s0,s1
    [0xac62, 'a1', { s0: 7 }, 7], // cm.mva01s s0,s0
];

describe('semantics evaluate', () => {
    test.each(EVALUATE_CASES.map((c, i) => [i, ...c] as const))(
        'case %#',
        (_i, insn, target, known, value) => {
            const knownRegs: Record<number, number> = {};
            for (const [name, v] of Object.entries(known)) {
                knownRegs[reg(name)] = v;
            }
            expect(evaluate(decodeInsnSemantics(insn), reg(target), PC, knownRegs)).toBe(value);
        }
    );
});

// Encodings from riscv32-esp-elf-as -march=rv32ima. No app ELF has the .aq and .rl forms of the AMOs.
const ATOMICS: Array<[number, string, string, string, string]> = [
    [0x00b6252f, 'amoadd.w', 'a0', 'a1', 'a2'],
    [0x04b6252f, 'amoadd.w.aq', 'a0', 'a1', 'a2'],
    [0x02b6252f, 'amoadd.w.rl', 'a0', 'a1', 'a2'],
    [0x06b6252f, 'amoadd.w.aqrl', 'a0', 'a1', 'a2'],
    [0x0c9122af, 'amoswap.w.aq', 't0', 's1', 'sp'],
    [0xe2b6202f, 'amomaxu.w.rl', 'zero', 'a1', 'a2'],
];

describe('AMO ordering', () => {
    test.each(ATOMICS)('%s', (insn, mnemonic, rd, rs2, base) => {
        const info = decodeInsnSemantics(insn);
        expect([info.mnemonic, info.size, info.supported]).toEqual([mnemonic, 4, true]);
        expect(info.reads).toEqual(regs(rs2, base));
        const expectedWrites = new Set(regs(rd));
        expectedWrites.delete(0);
        expect(info.writes).toEqual(expectedWrites);
        expect(info.loaded).toEqual(expectedWrites);
        // An AMO counts as a store, as mcause reports its faults
        expect(info.mem).toEqual({ base: reg(base), offset: 0, width: 4, is_store: true } as MemAccess);
        if (rd !== 'zero') {
            // The old value comes from memory
            expect(sources(info, reg(rd))).toBeUndefined();
        }
    });
});

const RESERVATION: Array<[number, string, string[], string[], boolean]> = [
    [0x1406252f, 'lr.w.aq', ['a2'], ['a0'], false],
    [0x1206252f, 'lr.w.rl', ['a2'], ['a0'], false],
    [0x1cb626af, 'sc.w.aq', ['a1', 'a2'], ['a3'], true],
    [0x1eb626af, 'sc.w.aqrl', ['a1', 'a2'], ['a3'], true],
];

describe('reservation ordering', () => {
    test.each(RESERVATION)('%s', (insn, mnemonic, reads, writes, isStore) => {
        const info = decodeInsnSemantics(insn);
        expect(info.mnemonic).toBe(mnemonic);
        expect(info.reads).toEqual(regs(...reads));
        expect(info.writes).toEqual(regs(...writes));
        expect(info.mem).toEqual({ base: reg('a2'), offset: 0, width: 4, is_store: isStore } as MemAccess);
        // lr.w loads rd. sc.w writes its success status, which comes from neither memory nor registers.
        expect(info.loaded).toEqual(isStore ? new Set<number>() : regs(...writes));
        expect(sources(info, reg(writes[0]))).toBeUndefined();
    });
});

// Reserved encodings, and the Zcmp and Zcmt forms that share the c.fsdsp encoding
const FORMS: Array<[string, number, string | undefined]> = [
    ['cm_push', 0xb862, 'cm.push'], // cm.push {ra,s0-s1},-16
    ['cm_popret', 0xbef2, 'cm.popret'], // cm.popret {ra,s0-s11},64
    ['cm_mva01s', 0xad66, 'cm.mva01s'], // cm.mva01s s2,s1
    ['cm_jt_31', 0xa07e, 'cm.jt'],
    ['cm_jalt_32', 0xa082, 'cm.jalt'],
    ['cm_push_reserved_rlist', 0xb802, undefined],
    ['cm_popret_reserved_rlist', 0xbe02, undefined],
    ['cm_mva01s_same_registers', 0xac62, 'cm.mva01s'], // cm.mva01s s0,s0
    ['cm_mvsa01_same_registers', 0xac22, undefined], // cm.mvsa01 s0,s0
    ['c_fsdsp_slot_reserved', 0xa402, undefined], // bits 12..10 0b001
    ['c_addi4spn_zero', 0x0004, undefined],
    ['c_addi16sp_zero', 0x6101, undefined],
    ['c_lui_zero', 0x6781, undefined],
    ['c_srli_shamt_32', 0x9101, undefined],
    ['c_slli_shamt_32', 0x1502, undefined],
    ['c_jr_x0', 0x8002, undefined],
    ['c_lwsp_x0', 0x4002, undefined],
    ['jalr_funct3', 0x00009067, undefined],
    ['branch_funct3', 0x00b52063, undefined],
    ['slli_shamt_32', 0x02051513, undefined],
    ['ld', 0x00053503, undefined], // RV64 only
    ['fcvt_w_s_rounding_101', 0xc0005553, undefined],
    ['fcvt_w_s_rounding_110', 0xc0006553, undefined],
    ['fcvt_w_s_dynamic_rounding', 0xc0007553, 'fcvt.w.s'],
    ['fadd_s_rounding_101', 0x00005053, undefined],
    ['fmadd_s_rounding_110', 0x00006043, undefined],
    ['esp_vst_128_ip', 0x8311009f, undefined], // PIE, in the 48-bit prefix space
];

describe('instruction forms', () => {
    test.each(FORMS)('%s', (_name, insn, mnemonic) => {
        const size = (insn & 0x3) === 0x3 ? 4 : 2;
        const info = decodeInsnSemantics(insn);
        expect(info.size).toBe(size);
        if (mnemonic === undefined) {
            // Nothing is known, so a walk stops here instead of guessing
            expect([info.supported, info.mnemonic]).toEqual([false, 'unknown']);
            expect([info.reads.size, info.writes.size, info.loaded.size, info.mem]).toEqual([0, 0, 0, undefined]);
        } else {
            expect([info.supported, info.mnemonic]).toEqual([true, mnemonic]);
        }
    });

    test('unimp', () => {
        const info = decodeInsnSemantics(0x0000);
        expect(info).toEqual({
            insn: 0, size: 2, mnemonic: 'c.unimp', supported: false,
            reads: new Set(), writes: new Set(), loaded: new Set(), mem: undefined,
            rd: undefined, rs1: undefined, rs2: undefined, imm: undefined, csr: undefined,
        } as InsnInfo);
    });

    test.each([0x0000003f, 0x0000007f, 0x000000bf])('wide encoding rejected %#', (insn) => {
        expect(() => decodeInsnSemantics(insn)).toThrow(InsnError);
        expect(() => decodeInsnSemantics(insn)).toThrow(/wider than 32 bits/);
    });
});

// Control-flow agreement between semantics and the instruction decoder
const BRANCH_NAMES = new Set(['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu', 'c.beqz', 'c.bnez']);
const ZCM_LINKS: Record<string, LinkKind> = {
    'cm.jt': LinkKind.JUMP,
    'cm.jalt': LinkKind.CALL,
    'cm.popret': LinkKind.RETURN,
    'cm.popretz': LinkKind.RETURN,
};

function rasLink(rd: number, rs1: number | undefined): LinkKind {
    /** Return-address stack hint table of the RISC-V unprivileged ISA, whose link registers are ra and t0. */
    const writes = rd === 1 || rd === 5;
    const reads = rs1 === 1 || rs1 === 5;
    if (writes && reads) {
        return rd === rs1 ? LinkKind.CALL : LinkKind.COROUTINE;
    }
    if (writes) {
        return LinkKind.CALL;
    }
    return reads ? LinkKind.RETURN : LinkKind.JUMP;
}

function controlFlow(info: InsnInfo, pc: number): [number, InsnClass, LinkKind, number | undefined] {
    const name = info.supported ? info.mnemonic : undefined;
    if (name !== undefined && BRANCH_NAMES.has(name)) {
        if (info.imm === undefined) throw new Error('branch without imm');
        return [info.size, InsnClass.BRANCH, LinkKind.NONE, (pc + info.imm) >>> 0];
    }
    if (name === 'jal' || name === 'c.j' || name === 'c.jal') {
        if (info.imm === undefined) throw new Error('jump without imm');
        return [info.size, InsnClass.JUMP, rasLink(info.rd ?? 0, undefined), (pc + info.imm) >>> 0];
    }
    if (name === 'jalr' || name === 'c.jr' || name === 'c.jalr') {
        return [info.size, InsnClass.UNINFERABLE, rasLink(info.rd ?? 0, info.rs1), undefined];
    }
    if (name === 'mret' || name === 'sret') {
        return [info.size, InsnClass.UNINFERABLE, LinkKind.TRAP_RETURN, undefined];
    }
    if (name !== undefined && name in ZCM_LINKS) {
        return [info.size, InsnClass.UNINFERABLE, ZCM_LINKS[name], undefined];
    }
    if (name === 'ecall' || name === 'ebreak' || name === 'c.ebreak') {
        return [info.size, InsnClass.TRAP, LinkKind.NONE, undefined];
    }
    return [info.size, InsnClass.NONE, LinkKind.NONE, undefined];
}

function insnBytes(insn: number, size: number): Buffer {
    const buf = Buffer.alloc(size);
    if (size === 2) {
        buf.writeUInt16LE(insn & 0xffff, 0);
    } else {
        buf.writeUInt32LE(insn >>> 0, 0);
    }
    return buf;
}

function disagreements(words: number[], pc: number): string[] {
    const problems: string[] = [];
    for (const insn of words) {
        const size = insnLength(insn & 0xffff);
        const decoded = decodeInsn(pc, insnBytes(insn, size));
        const got: [number, InsnClass, LinkKind, number | undefined] = [
            decoded.length, decoded.cls, decoded.link, decoded.direct_target,
        ];
        const want = controlFlow(decodeInsnSemantics(insn), pc);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
            problems.push(
                `0x${insn.toString(16).padStart(size * 2, '0')}: control flow ${JSON.stringify(got)}, semantics ${JSON.stringify(want)}`
            );
        }
    }
    return problems;
}

describe('control-flow agreement', () => {
    test('every compressed encoding', () => {
        const words: number[] = [];
        for (let hw = 0; hw < 0x10000; hw++) {
            if ((hw & 0x3) !== 0x3) {
                words.push(hw);
            }
        }
        const problems = disagreements(words, PC);
        expect(problems.slice(0, 20)).toEqual([]);
    });

    test('32-bit encodings', () => {
        const words: number[] = [];
        for (let opcode = 0x03; opcode < 0x80; opcode += 4) {
            if ((opcode & 0x3f) === 0x3f) {
                continue;
            }
            for (const funct3 of [0, 1, 2, 3, 4, 5, 6, 7]) {
                for (const rd of [0, 1, 5, 10]) {
                    for (const rs1 of [0, 1, 5, 10]) {
                        for (const upper of [0x000, 0x001, 0x102, 0x105, 0x302, 0x7ff, 0x800, 0xfff]) {
                            words.push((upper << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
                        }
                    }
                }
            }
        }
        const problems = disagreements(words, PC);
        expect(problems.slice(0, 20)).toEqual([]);
    });
});

describe('decodeAt', () => {
    test('decodes through a CodeImage and returns undefined on failure', () => {
        const bytes = Buffer.from([0xef, 0xf0, 0x7f, 0xff]); // jal ra, PC+4 style fixture not needed; any valid insn
        const image: CodeImage = {
            read: (vaddr: number, size: number) => {
                const out = bytes.subarray(vaddr - PC, vaddr - PC + size);
                if (out.length !== size) {
                    throw new CodeReadError(`vaddr 0x${vaddr.toString(16)} out of range`);
                }
                return out;
            },
            symbolAt: () => undefined,
        };
        const info = decodeAt(image, PC);
        expect(info).toBeDefined();
        expect(decodeAt(undefined, PC)).toBeUndefined();
        expect(decodeAt(image, PC + 0x1000)).toBeUndefined();
    });
});
