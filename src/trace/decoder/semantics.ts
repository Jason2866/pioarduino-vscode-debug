// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/semantics.py (Apache-2.0).
// Integer register effects of RV32 instructions, for following a value back through the trace.
// Floating point registers are not tracked. x0 is never in `reads` or `writes`.

import { CodeImage, CodeReadError } from '../elf/image';
import {
    A0,
    A1,
    InsnError,
    OPCODE_AMO,
    OPCODE_AUIPC,
    OPCODE_BRANCH,
    OPCODE_JAL,
    OPCODE_JALR,
    OPCODE_LOAD,
    OPCODE_LOAD_FP,
    OPCODE_LUI,
    OPCODE_MADD,
    OPCODE_MASK,
    OPCODE_MISC_MEM,
    OPCODE_MSUB,
    OPCODE_NMADD,
    OPCODE_NMSUB,
    OPCODE_OP,
    OPCODE_OP_FP,
    OPCODE_OP_IMM,
    OPCODE_STORE,
    OPCODE_STORE_FP,
    OPCODE_SYSTEM,
    QUADRANT_32BIT,
    QUADRANT_MASK,
    RA,
    S_REGS,
    SP,
    XLEN_BYTES,
    ZCMP_RLIST_MIN,
    bImm,
    cbImm,
    cjImm,
    insnLength,
    jImm,
    regName,
    signExtend,
    zcmMnemonic,
} from './encoding';

// The first 16-bit parcel of an instruction
const PARCEL_MASK = 0xffff;
const PARCEL_BYTES = 2;
const XLEN_BITS = 32;
// Shift amounts and bit indexes of a 32-bit register take five bits
const SHAMT_MASK = 31;
// The 3-bit register fields of compressed instructions name x8 to x15
const C_REG_BASE = 8;

export interface MemAccess {
    /** One memory access at base register + offset. */
    base: number;
    offset: number;
    width: number;
    // AMOs load and store. They count as stores, as mcause reports their faults.
    is_store: boolean;
}

export interface InsnInfo {
    /** What one instruction does to the integer registers. */
    insn: number;
    size: number;
    mnemonic: string; // as riscv32-esp-elf-objdump -M no-aliases prints it
    supported: boolean;
    reads: ReadonlySet<number>;
    writes: ReadonlySet<number>;
    // Written registers whose new value comes from memory, which are loads, lr, AMOs and the cm.pop forms
    loaded: ReadonlySet<number>;
    // cm.push and cm.pop access several addresses and have no single MemAccess
    mem: MemAccess | undefined;
    rd: number | undefined;
    rs1: number | undefined;
    rs2: number | undefined;
    // Sign-extended immediate. lui and auipc hold the shifted value, cm.push a negative stack adjustment.
    imm: number | undefined;
    csr: number | undefined;
}

const EMPTY_SET: ReadonlySet<number> = new Set<number>();

function regs(...regs: Array<number | undefined>): ReadonlySet<number> {
    return new Set(regs.filter((r): r is number => r !== undefined && r !== 0));
}

export function decodeInsnSemantics(insn: number): InsnInfo {
    /** Decode the instruction in the low 16 or 32 bits of `insn`. Throws InsnError as insnLength() does. */
    let info: InsnInfo | undefined;
    if (insnLength(insn & PARCEL_MASK) === PARCEL_BYTES) {
        info = decode16(insn & PARCEL_MASK);
    } else {
        info = decode32(insn >>> 0);
    }
    return info ?? unsupported(insn);
}

export function decodeAt(image: CodeImage | undefined, pc: number): InsnInfo | undefined {
    /** Decode the instruction of `image` at `pc`, undefined when it cannot be read or decoded. */
    if (image === undefined) {
        return undefined;
    }
    try {
        const low = image.read(pc, PARCEL_BYTES).readUInt16LE(0);
        const size = insnLength(low);
        if (size === PARCEL_BYTES) {
            return decodeInsnSemantics(low);
        }
        return decodeInsnSemantics(image.read(pc, size).readUInt32LE(0));
    } catch (error) {
        if (error instanceof CodeReadError || error instanceof InsnError) {
            return undefined;
        }
        throw error;
    }
}

export function sources(info: InsnInfo, reg: number): ReadonlySet<number> | undefined {
    /** Return the registers the value `info` writes to `reg` is computed from, undefined when not from registers.

    An empty set is a constant or an address relative to the instruction.
    */
    if (!info.writes.has(reg) || info.loaded.has(reg) || info.csr !== undefined) {
        return undefined;
    }
    const mnemonic = info.mnemonic;
    if (mnemonic.startsWith('f') || mnemonic.startsWith('sc.')) {
        return undefined;
    }
    if (ZCMP_STACK_SET.has(mnemonic)) {
        return reg === A0 ? EMPTY_SET : new Set([SP]);
    }
    if (mnemonic === 'cm.mva01s') {
        const source = reg === A0 ? info.rs1 : info.rs2;
        if (source === undefined) {
            throw new InsnError('cm.mva01s without a source register');
        }
        return new Set([source]);
    }
    if (mnemonic === 'cm.mvsa01') {
        return new Set([reg === info.rs1 ? A0 : A1]);
    }
    if (LINKS.has(mnemonic)) {
        return EMPTY_SET;
    }
    return info.reads;
}

export function evaluate(info: InsnInfo, reg: number, pc: number, regsMap: ReadonlyMap<number, number> | Record<number, number>): number | undefined {
    /** Return the value `info` at `pc` writes to `reg`, undefined when `regs` or the operation lack it. */
    const needed = sources(info, reg);
    if (needed === undefined) {
        return undefined;
    }
    const lookup = (r: number): number | undefined =>
        regsMap instanceof Map ? regsMap.get(r) : (regsMap as Record<number, number>)[r];
    for (const r of needed) {
        if (lookup(r) === undefined) {
            return undefined;
        }
    }
    const operation = EVALUATE.get(info.mnemonic);
    if (operation === undefined) {
        return undefined;
    }
    const value = (r: number | undefined): number => {
        if (r === undefined || r === 0) {
            return 0;
        }
        const v = lookup(r);
        return v === undefined ? 0 : v >>> 0;
    };
    return operation(info, reg, pc, value) >>> 0;
}

function unsupported(insn: number, mnemonic = 'unknown'): InsnInfo {
    return {
        insn,
        size: insnLength(insn & PARCEL_MASK),
        mnemonic,
        supported: false,
        reads: EMPTY_SET,
        writes: EMPTY_SET,
        loaded: EMPTY_SET,
        mem: undefined,
        rd: undefined,
        rs1: undefined,
        rs2: undefined,
        imm: undefined,
        csr: undefined,
    };
}

// ---------------------------------------------------------------------------
// Memory accesses
// ---------------------------------------------------------------------------

// Access width in bytes by opcode and funct3. The RV64 ld, lwu and sd are left out, the 8-byte ones are fld and fsd.
const LOAD_WIDTHS: Record<number, Record<number, number>> = {
    [OPCODE_LOAD]: { 0: 1, 1: 2, 2: 4, 4: 1, 5: 2 },
    [OPCODE_LOAD_FP]: { 2: 4, 3: 8 },
};
const STORE_WIDTHS: Record<number, Record<number, number>> = {
    [OPCODE_STORE]: { 0: 1, 1: 2, 2: 4 },
    [OPCODE_STORE_FP]: { 2: 4, 3: 8 },
};

function memoryAccess(insn: number): [number, number, number] | undefined {
    /** Return the base register, signed byte offset and width in bytes of a load or store, undefined for others. */
    if ((insn & QUADRANT_MASK) === QUADRANT_32BIT) {
        const opcode = insn & OPCODE_MASK;
        const funct3 = (insn >>> 12) & 0x7;
        let width: number | undefined;
        let imm: number;
        const loadWidths = LOAD_WIDTHS[opcode];
        const storeWidths = STORE_WIDTHS[opcode];
        if (loadWidths !== undefined) {
            width = loadWidths[funct3];
            imm = insn >>> 20;
        } else if (storeWidths !== undefined) {
            width = storeWidths[funct3];
            imm = ((insn >>> 25) << 5) | ((insn >>> 7) & 0x1f);
        } else {
            return undefined;
        }
        if (width === undefined) {
            return undefined;
        }
        return [(insn >>> 15) & 0x1f, signExtend(imm, 12), width];
    }

    insn &= PARCEL_MASK;
    const quadrant = insn & QUADRANT_MASK;
    const funct3 = insn >>> 13;
    if (quadrant === 0) {
        const rs1 = ((insn >>> 7) & 0x7) + C_REG_BASE;
        if (funct3 === 4) {
            // Zcb c.lbu, c.lhu, c.lh, c.sb, c.sh. Bits 12..10 pick the form.
            const form = (insn >>> 10) & 0x7;
            if (form === 0 || form === 2) {
                // A byte access takes uimm[1] from bit 5 and uimm[0] from bit 6
                return [rs1, (((insn >>> 5) & 0x1) << 1) | ((insn >>> 6) & 0x1), 1];
            }
            if (form === 1 || form === 3) {
                // A halfword access takes uimm[1] from bit 5
                return [rs1, ((insn >>> 5) & 0x1) << 1, 2];
            }
            return undefined;
        }
        if (funct3 === 1 || funct3 === 5) {
            // c.fld, c.fsd
            return [rs1, (((insn >>> 10) & 0x7) << 3) | (((insn >>> 5) & 0x3) << 6), 8];
        }
        if (funct3 === 2 || funct3 === 3 || funct3 === 6 || funct3 === 7) {
            // c.lw, c.flw, c.sw, c.fsw
            return [rs1, (((insn >>> 10) & 0x7) << 3) | (((insn >>> 6) & 0x1) << 2) | (((insn >>> 5) & 0x1) << 6), 4];
        }
        return undefined;
    }
    if (quadrant === 2) {
        if (funct3 === 5) {
            // Zcmp owns this slot, see zcmMnemonic()
            return undefined;
        }
        if (funct3 === 1) {
            // c.fldsp
            return [SP, (((insn >>> 12) & 0x1) << 5) | (((insn >>> 5) & 0x3) << 3) | (((insn >>> 2) & 0x7) << 6), 8];
        }
        if (funct3 === 2 || funct3 === 3) {
            // c.lwsp, c.flwsp
            return [SP, (((insn >>> 12) & 0x1) << 5) | (((insn >>> 4) & 0x7) << 2) | (((insn >>> 2) & 0x3) << 6), 4];
        }
        if (funct3 === 6 || funct3 === 7) {
            // c.swsp, c.fswsp
            return [SP, (((insn >>> 9) & 0xf) << 2) | (((insn >>> 7) & 0x3) << 6), 4];
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// 32-bit encodings
// ---------------------------------------------------------------------------

function make(
    insn: number,
    mnemonic: string,
    options: {
        reads?: Array<number | undefined>;
        writes?: Array<number | undefined>;
        loaded?: Array<number | undefined>;
        mem?: MemAccess;
        rd?: number;
        rs1?: number;
        rs2?: number;
        imm?: number;
        csr?: number;
    } = {}
): InsnInfo {
    return {
        insn,
        size: insnLength(insn & PARCEL_MASK),
        mnemonic,
        supported: true,
        reads: regs(...(options.reads ?? [])),
        writes: regs(...(options.writes ?? [])),
        loaded: regs(...(options.loaded ?? [])),
        mem: options.mem,
        rd: options.rd,
        rs1: options.rs1,
        rs2: options.rs2,
        imm: options.imm,
        csr: options.csr,
    };
}

function mem(insn: number, isStore: boolean): MemAccess | undefined {
    const access = memoryAccess(insn);
    if (access === undefined) {
        return undefined;
    }
    return { base: access[0], offset: access[1], width: access[2], is_store: isStore };
}

const BRANCHES: Record<number, string> = { 0: 'beq', 1: 'bne', 4: 'blt', 5: 'bge', 6: 'bltu', 7: 'bgeu' };
const LOADS: Record<number, string> = { 0: 'lb', 1: 'lh', 2: 'lw', 4: 'lbu', 5: 'lhu' };
const STORES: Record<number, string> = { 0: 'sb', 1: 'sh', 2: 'sw' };
const OP_IMM: Record<number, string> = { 0: 'addi', 2: 'slti', 3: 'sltiu', 4: 'xori', 6: 'ori', 7: 'andi' };
// (funct7, funct3) of OP for RV32I, M, Zba, Zbb, Zbs and Zicond
const OP: Record<string, string> = {
    '0,0': 'add', '32,0': 'sub', '0,1': 'sll', '0,2': 'slt',
    '0,3': 'sltu', '0,4': 'xor', '0,5': 'srl', '32,5': 'sra',
    '0,6': 'or', '0,7': 'and',
    '1,0': 'mul', '1,1': 'mulh', '1,2': 'mulhsu', '1,3': 'mulhu',
    '1,4': 'div', '1,5': 'divu', '1,6': 'rem', '1,7': 'remu',
    '16,2': 'sh1add', '16,4': 'sh2add', '16,6': 'sh3add',
    '32,7': 'andn', '32,6': 'orn', '32,4': 'xnor',
    '5,4': 'min', '5,5': 'minu', '5,6': 'max', '5,7': 'maxu',
    '5,1': 'clmul', '5,2': 'clmulr', '5,3': 'clmulh',
    '48,1': 'rol', '48,5': 'ror',
    '36,1': 'bclr', '36,5': 'bext', '20,1': 'bset', '52,1': 'binv',
    '7,5': 'czero.eqz', '7,7': 'czero.nez',
};
// OP-IMM funct3 1 and 5 by imm[11:5]
const SHIFT_IMM: Record<string, string> = {
    '1,0': 'slli', '1,36': 'bclri', '1,20': 'bseti', '1,52': 'binvi',
    '5,0': 'srli', '5,32': 'srai', '5,36': 'bexti', '5,48': 'rori',
};
// OP-IMM funct3 1 with imm[11:5] 0x30, by the rs2 field
const ZBB_UNARY: Record<number, string> = { 0: 'clz', 1: 'ctz', 2: 'cpop', 4: 'sext.b', 5: 'sext.h' };
// OP-IMM funct3 5 with the whole 12-bit immediate fixed
const ZBB_FIXED: Record<number, string> = { 0x287: 'orc.b', 0x698: 'rev8' };
const SYSTEM: Record<number, string> = {
    0x00000073: 'ecall', 0x00100073: 'ebreak', 0x10200073: 'sret',
    0x30200073: 'mret', 0x10500073: 'wfi',
};
const CSR: Record<number, string> = { 1: 'csrrw', 2: 'csrrs', 3: 'csrrc', 5: 'csrrwi', 6: 'csrrsi', 7: 'csrrci' };
const AMO: Record<number, string> = {
    0x00: 'amoadd.w', 0x01: 'amoswap.w', 0x04: 'amoxor.w', 0x08: 'amoor.w', 0x0c: 'amoand.w',
    0x10: 'amomin.w', 0x14: 'amomax.w', 0x18: 'amominu.w', 0x1c: 'amomaxu.w',
};
const AMO_LR = 0x02;
const AMO_SC = 0x03;
// By the aq and rl bits, bits 26..25
const AMO_ORDER = ['', '.rl', '.aq', '.aqrl'];
const FP_FORMATS: Record<number, string> = { 0: 's', 1: 'd' };
// funct3 is the rounding mode of these OP-FP instructions and of the fused ones. 0b101 and 0b110 are reserved.
const FP_ROUNDED = new Set([0x00, 0x01, 0x02, 0x03, 0x08, 0x0b, 0x18, 0x1a]);
const RESERVED_ROUNDING_MODES = new Set([0b101, 0b110]);
const FP_FUSED: Record<number, string> = {
    [OPCODE_MADD]: 'fmadd', [OPCODE_MSUB]: 'fmsub', [OPCODE_NMSUB]: 'fnmsub', [OPCODE_NMADD]: 'fnmadd',
};
const FP_MEMORY: Record<string, string> = {
    [`${OPCODE_LOAD_FP},2`]: 'flw', [`${OPCODE_LOAD_FP},3`]: 'fld',
    [`${OPCODE_STORE_FP},2`]: 'fsw', [`${OPCODE_STORE_FP},3`]: 'fsd',
};
// OP-FP by funct5 when the result and the operands are all floating point
const FP_ARITH: Record<number, string> = { 0x00: 'fadd', 0x01: 'fsub', 0x02: 'fmul', 0x03: 'fdiv' };
const FP_BY_FUNCT3: Record<number, string[]> = {
    0x04: ['fsgnj', 'fsgnjn', 'fsgnjx'],
    0x05: ['fmin', 'fmax'],
    0x14: ['fle', 'flt', 'feq'],
};

function decode32(insn: number): InsnInfo | undefined {
    const opcode = insn & OPCODE_MASK;
    const rd = (insn >>> 7) & 0x1f;
    const funct3 = (insn >>> 12) & 0x7;
    const rs1 = (insn >>> 15) & 0x1f;
    const rs2 = (insn >>> 20) & 0x1f;
    const funct7 = insn >>> 25;
    const iImm = signExtend(insn >>> 20, 12);

    if (opcode === OPCODE_LUI) {
        return make(insn, 'lui', { writes: [rd], rd, imm: insn & 0xfffff000 });
    }
    if (opcode === OPCODE_AUIPC) {
        return make(insn, 'auipc', { writes: [rd], rd, imm: insn & 0xfffff000 });
    }
    if (opcode === OPCODE_JAL) {
        return make(insn, 'jal', { writes: [rd], rd, imm: jImm(insn) });
    }
    if (opcode === OPCODE_JALR) {
        if (funct3) {
            return undefined;
        }
        return make(insn, 'jalr', { reads: [rs1], writes: [rd], rd, rs1, imm: iImm });
    }
    if (opcode === OPCODE_BRANCH) {
        const name = BRANCHES[funct3];
        if (name === undefined) {
            return undefined;
        }
        return make(insn, name, { reads: [rs1, rs2], rs1, rs2, imm: bImm(insn) });
    }
    if (opcode === OPCODE_LOAD) {
        const name = LOADS[funct3];
        if (name === undefined) {
            return undefined;
        }
        return make(insn, name, {
            reads: [rs1], writes: [rd], loaded: [rd], mem: mem(insn, false), rd, rs1, imm: iImm,
        });
    }
    if (opcode === OPCODE_STORE) {
        const name = STORES[funct3];
        if (name === undefined) {
            return undefined;
        }
        const access = mem(insn, true);
        if (access === undefined) {
            return undefined;
        }
        return make(insn, name, { reads: [rs1, rs2], mem: access, rs1, rs2, imm: access.offset });
    }
    if (opcode === OPCODE_LOAD_FP || opcode === OPCODE_STORE_FP) {
        // Other widths are vector loads and stores
        const name = FP_MEMORY[`${opcode},${funct3}`];
        if (name === undefined) {
            return undefined;
        }
        const access = mem(insn, opcode === OPCODE_STORE_FP);
        if (access === undefined) {
            return undefined;
        }
        return make(insn, name, { reads: [rs1], mem: access, rs1, imm: access.offset });
    }
    if (opcode === OPCODE_OP_IMM) {
        return decodeOpImm(insn, rd, funct3, rs1, rs2, iImm);
    }
    if (opcode === OPCODE_OP) {
        let name = OP[`${funct7},${funct3}`];
        if (name === undefined && funct7 === 0x04 && funct3 === 4 && rs2 === 0) {
            return make(insn, 'zext.h', { reads: [rs1], writes: [rd], rd, rs1 });
        }
        if (name === undefined) {
            return undefined;
        }
        return make(insn, name, { reads: [rs1, rs2], writes: [rd], rd, rs1, rs2 });
    }
    if (opcode === OPCODE_MISC_MEM) {
        // The register fields of fence are reserved and ignored by the core
        const name = funct3 === 0 ? 'fence' : funct3 === 1 ? 'fence.i' : undefined;
        return name !== undefined ? make(insn, name) : undefined;
    }
    if (opcode === OPCODE_SYSTEM) {
        return decodeSystem(insn, rd, funct3, rs1);
    }
    if (opcode === OPCODE_AMO) {
        return decodeAmo(insn, rd, funct3, rs1, rs2, funct7);
    }
    const fused = FP_FUSED[opcode];
    if (fused !== undefined) {
        const fmt = FP_FORMATS[funct7 & 0x3];
        if (fmt === undefined || RESERVED_ROUNDING_MODES.has(funct3)) {
            return undefined;
        }
        return make(insn, `${fused}.${fmt}`);
    }
    if (opcode === OPCODE_OP_FP) {
        return decodeOpFp(insn, rd, funct3, rs1, rs2, funct7);
    }
    return undefined;
}

function decodeOpImm(insn: number, rd: number, funct3: number, rs1: number, rs2: number, iImm: number): InsnInfo | undefined {
    const simple = OP_IMM[funct3];
    if (simple !== undefined) {
        return make(insn, simple, { reads: [rs1], writes: [rd], rd, rs1, imm: iImm });
    }
    const imm12 = insn >>> 20;
    let name = funct3 === 5 ? ZBB_FIXED[imm12] : undefined;
    if (name === undefined && funct3 === 1 && imm12 >>> 5 === 0x30) {
        name = ZBB_UNARY[rs2];
    }
    if (name !== undefined) {
        return make(insn, name, { reads: [rs1], writes: [rd], rd, rs1 });
    }
    // On RV32 a shift amount is five bits, so imm[5] set is reserved
    name = SHIFT_IMM[`${funct3},${imm12 >>> 5}`];
    if (name === undefined) {
        return undefined;
    }
    return make(insn, name, { reads: [rs1], writes: [rd], rd, rs1, imm: rs2 });
}

function decodeSystem(insn: number, rd: number, funct3: number, rs1: number): InsnInfo | undefined {
    if (funct3 === 0) {
        const name = SYSTEM[insn];
        return name !== undefined ? make(insn, name) : undefined;
    }
    const name = CSR[funct3];
    if (name === undefined) {
        return undefined;
    }
    const csr = insn >>> 20;
    if (funct3 >= 5) {
        // rs1 holds an immediate
        return make(insn, name, { writes: [rd], rd, imm: rs1, csr });
    }
    return make(insn, name, { reads: [rs1], writes: [rd], rd, rs1, csr });
}

function decodeAmo(insn: number, rd: number, funct3: number, rs1: number, rs2: number, funct7: number): InsnInfo | undefined {
    if (funct3 !== 2) {
        return undefined;
    }
    const funct5 = funct7 >>> 2;
    const order = AMO_ORDER[funct7 & 0x3];
    if (funct5 === AMO_LR) {
        if (rs2) {
            return undefined;
        }
        const access: MemAccess = { base: rs1, offset: 0, width: 4, is_store: false };
        return make(insn, `lr.w${order}`, { reads: [rs1], writes: [rd], loaded: [rd], mem: access, rd, rs1 });
    }
    const access: MemAccess = { base: rs1, offset: 0, width: 4, is_store: true };
    if (funct5 === AMO_SC) {
        // rd receives the success status, not a value from memory
        return make(insn, `sc.w${order}`, { reads: [rs1, rs2], writes: [rd], mem: access, rd, rs1, rs2 });
    }
    const name = AMO[funct5];
    if (name === undefined) {
        return undefined;
    }
    return make(insn, `${name}${order}`, {
        reads: [rs1, rs2], writes: [rd], loaded: [rd], mem: access, rd, rs1, rs2,
    });
}

function decodeOpFp(insn: number, rd: number, funct3: number, rs1: number, rs2: number, funct7: number): InsnInfo | undefined {
    const fmt = FP_FORMATS[funct7 & 0x3];
    if (fmt === undefined) {
        return undefined;
    }
    const funct5 = funct7 >>> 2;
    if (FP_ROUNDED.has(funct5) && RESERVED_ROUNDING_MODES.has(funct3)) {
        return undefined;
    }
    const arith = FP_ARITH[funct5];
    if (arith !== undefined) {
        return make(insn, `${arith}.${fmt}`);
    }
    if (funct5 === 0x0b && rs2 === 0) {
        return make(insn, `fsqrt.${fmt}`);
    }
    if (funct5 === 0x08 && rs2 === 1 - (funct7 & 0x3)) {
        const target = FP_FORMATS[rs2];
        return target !== undefined ? make(insn, `fcvt.${fmt}.${target}`) : undefined;
    }
    const names = FP_BY_FUNCT3[funct5];
    if (names !== undefined) {
        if (funct3 >= names.length) {
            return undefined;
        }
        if (funct5 === 0x14) {
            // Comparisons write an integer register
            return make(insn, `${names[funct3]}.${fmt}`, { writes: [rd], rd });
        }
        return make(insn, `${names[funct3]}.${fmt}`);
    }
    if (funct5 === 0x18 && rs2 < 2) {
        return make(insn, `fcvt.${rs2 ? 'wu' : 'w'}.${fmt}`, { writes: [rd], rd });
    }
    if (funct5 === 0x1a && rs2 < 2) {
        return make(insn, `fcvt.${fmt}.${rs2 ? 'wu' : 'w'}`, { reads: [rs1], rs1 });
    }
    if (funct5 === 0x1c && rs2 === 0) {
        if (funct3 === 1) {
            return make(insn, `fclass.${fmt}`, { writes: [rd], rd });
        }
        if (funct3 === 0 && fmt === 's') {
            return make(insn, 'fmv.x.w', { writes: [rd], rd });
        }
    }
    if (funct5 === 0x1e && funct3 === 0 && rs2 === 0 && fmt === 's') {
        return make(insn, 'fmv.w.x', { reads: [rs1], rs1 });
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// 16-bit encodings
// ---------------------------------------------------------------------------

// Zcmp s-register numbers by the 3-bit sreg field of cm.mva01s and cm.mvsa01
const SREG = S_REGS.slice(0, 8);
// Zcmp s-register numbers by the 3-bit sreg field of cm.mva01s and cm.mvsa01
const ZCMP_STACK_SET = new Set(['cm.push', 'cm.pop', 'cm.popretz', 'cm.popret']);
// The register list that names ra and s0 to s11
const ZCMP_RLIST_ALL = 15;
// cm.push and cm.pop keep sp 16-byte aligned
const ZCMP_STACK_ALIGN = 16;
// Instructions that write a return address
export const LINKS = new Set(['jal', 'jalr', 'c.jal', 'c.jalr', 'cm.jalt']);
const C_ALU = ['c.sub', 'c.xor', 'c.or', 'c.and'];
const ZCB_UNARY: Record<number, string> = { 0: 'c.zext.b', 1: 'c.sext.b', 2: 'c.zext.h', 3: 'c.sext.h', 5: 'c.not' };

function zcmpRegisters(rlist: number): number[] {
    /** Return ra and the s registers a Zcmp register list names. */
    const count = rlist < ZCMP_RLIST_ALL ? rlist - ZCMP_RLIST_MIN : S_REGS.length;
    return [RA, ...S_REGS.slice(0, count)];
}

function zcmpStackAdjust(rlist: number, spimm: number): number {
    /** Return the bytes cm.push and cm.pop move sp by on RV32. */
    const savedBytes = XLEN_BYTES * zcmpRegisters(rlist).length;
    const aligned = Math.ceil(savedBytes / ZCMP_STACK_ALIGN) * ZCMP_STACK_ALIGN;
    return aligned + ZCMP_STACK_ALIGN * spimm;
}

function decode16(insn: number): InsnInfo | undefined {
    if (insn === 0) {
        return unsupported(insn, 'c.unimp');
    }
    const quadrant = insn & QUADRANT_MASK;
    const funct3 = insn >>> 13;
    const rd = (insn >>> 7) & 0x1f;
    const rs2 = (insn >>> 2) & 0x1f;
    const rdp = ((insn >>> 7) & 0x7) + C_REG_BASE;
    const rs2p = ((insn >>> 2) & 0x7) + C_REG_BASE;
    const ciImm = signExtend(((insn >>> 7) & 0x20) | rs2, 6);
    if (quadrant === 0) {
        return decode16Q0(insn, funct3, rdp, rs2p);
    }
    if (quadrant === 1) {
        return decode16Q1(insn, funct3, rd, rdp, rs2p, ciImm);
    }
    return decode16Q2(insn, funct3, rd, rs2, ciImm);
}

function decode16Q0(insn: number, funct3: number, rs1p: number, rp: number): InsnInfo | undefined {
    const access = mem(insn, funct3 >= 5);
    if (funct3 === 0) {
        const imm = (((insn >>> 7) & 0x30) | ((insn >>> 1) & 0x3c0) | ((insn >>> 4) & 0x4) | ((insn >>> 2) & 0x8));
        if (!imm) {
            return undefined;
        }
        return make(insn, 'c.addi4spn', { reads: [SP], writes: [rp], rd: rp, rs1: SP, imm });
    }
    if (funct3 === 4) {
        const form = (insn >>> 10) & 0x7;
        const bit6 = (insn >>> 6) & 0x1;
        if (form === 0 || form === 1) {
            const name = form === 0 ? 'c.lbu' : bit6 ? 'c.lh' : 'c.lhu';
            return make(insn, name, {
                reads: [rs1p], writes: [rp], loaded: [rp], mem: mem(insn, false), rd: rp, rs1: rs1p,
            });
        }
        if (form === 2 || (form === 3 && !bit6)) {
            const name = form === 2 ? 'c.sb' : 'c.sh';
            return make(insn, name, { reads: [rs1p, rp], mem: mem(insn, true), rs1: rs1p, rs2: rp });
        }
        return undefined;
    }
    if (access === undefined) {
        return undefined;
    }
    if (funct3 === 2) {
        return make(insn, 'c.lw', {
            reads: [rs1p], writes: [rp], loaded: [rp], mem: access, rd: rp, rs1: rs1p, imm: access.offset,
        });
    }
    if (funct3 === 6) {
        return make(insn, 'c.sw', { reads: [rs1p, rp], mem: access, rs1: rs1p, rs2: rp, imm: access.offset });
    }
    // c.fld, c.flw, c.fsd, c.fsw
    const name = { 1: 'c.fld', 3: 'c.flw', 5: 'c.fsd', 7: 'c.fsw' }[funct3] as string;
    return make(insn, name, { reads: [rs1p], mem: access, rs1: rs1p, imm: access.offset });
}

function decode16Q1(
    insn: number,
    funct3: number,
    rd: number,
    rdp: number,
    rs2p: number,
    ciImm: number
): InsnInfo | undefined {
    if (funct3 === 0) {
        // rd 0 is c.nop, which objdump prints as c.addi zero,0
        return make(insn, 'c.addi', { reads: [rd], writes: [rd], rd, rs1: rd, imm: ciImm });
    }
    if (funct3 === 1) {
        return make(insn, 'c.jal', { writes: [RA], rd: RA, imm: cjImm(insn) });
    }
    if (funct3 === 5) {
        return make(insn, 'c.j', { imm: cjImm(insn) });
    }
    if (funct3 === 2) {
        return make(insn, 'c.li', { writes: [rd], rd, rs1: 0, imm: ciImm });
    }
    if (funct3 === 3) {
        if (rd === SP) {
            const imm =
                ((insn >>> 3) & 0x200) |
                ((insn >>> 2) & 0x10) |
                ((insn << 1) & 0x40) |
                ((insn << 4) & 0x180) |
                ((insn << 3) & 0x20);
            if (!imm) {
                return undefined;
            }
            return make(insn, 'c.addi16sp', { reads: [SP], writes: [SP], rd: SP, rs1: SP, imm: signExtend(imm, 10) });
        }
        if (!ciImm) {
            return undefined;
        }
        return make(insn, 'c.lui', { writes: [rd], rd, imm: ciImm << 12 });
    }
    if (funct3 === 4) {
        return decode16Q1Alu(insn, rdp, rs2p, ciImm);
    }
    return make(insn, funct3 === 6 ? 'c.beqz' : 'c.bnez', { reads: [rdp], rs1: rdp, imm: cbImm(insn) });
}

function decode16Q1Alu(insn: number, rdp: number, rs2p: number, ciImm: number): InsnInfo | undefined {
    const funct2 = (insn >>> 10) & 0x3;
    if (funct2 < 2) {
        // c.srli and c.srai. RV32 shift amounts are five bits, so bit 12 set is reserved.
        if (insn & 0x1000) {
            return undefined;
        }
        return make(insn, funct2 ? 'c.srai' : 'c.srli', {
            reads: [rdp], writes: [rdp], rd: rdp, rs1: rdp, imm: ciImm & 0x1f,
        });
    }
    if (funct2 === 2) {
        return make(insn, 'c.andi', { reads: [rdp], writes: [rdp], rd: rdp, rs1: rdp, imm: ciImm });
    }
    const op = (insn >>> 5) & 0x3;
    if (!(insn & 0x1000)) {
        return make(insn, C_ALU[op], { reads: [rdp, rs2p], writes: [rdp], rd: rdp, rs1: rdp, rs2: rs2p });
    }
    if (op === 2) {
        return make(insn, 'c.mul', { reads: [rdp, rs2p], writes: [rdp], rd: rdp, rs1: rdp, rs2: rs2p });
    }
    const name = op === 3 ? ZCB_UNARY[(insn >>> 2) & 0x7] : undefined;
    if (name === undefined) {
        return undefined;
    }
    return make(insn, name, { reads: [rdp], writes: [rdp], rd: rdp, rs1: rdp });
}

function decode16Q2(insn: number, funct3: number, rd: number, rs2: number, ciImm: number): InsnInfo | undefined {
    if (funct3 === 0) {
        if (insn & 0x1000) {
            return undefined;
        }
        return make(insn, 'c.slli', { reads: [rd], writes: [rd], rd, rs1: rd, imm: ciImm & 0x1f });
    }
    if (funct3 === 1 || funct3 === 3 || funct3 === 7) {
        // c.fldsp, c.flwsp, c.fswsp
        const name = { 1: 'c.fldsp', 3: 'c.flwsp', 7: 'c.fswsp' }[funct3] as string;
        const access = mem(insn, funct3 === 7);
        if (access === undefined) {
            return undefined;
        }
        return make(insn, name, { reads: [SP], mem: access, rs1: SP, imm: access.offset });
    }
    if (funct3 === 2) {
        if (rd === 0) {
            return undefined;
        }
        const access = mem(insn, false);
        if (access === undefined) {
            return undefined;
        }
        return make(insn, 'c.lwsp', {
            reads: [SP], writes: [rd], loaded: [rd], mem: access, rd, rs1: SP, imm: access.offset,
        });
    }
    if (funct3 === 6) {
        const access = mem(insn, true);
        if (access === undefined) {
            return undefined;
        }
        return make(insn, 'c.swsp', { reads: [SP, rs2], mem: access, rs1: SP, rs2, imm: access.offset });
    }
    if (funct3 === 4) {
        if (!(insn & 0x1000)) {
            if (rs2) {
                return make(insn, 'c.mv', { reads: [rs2], writes: [rd], rd, rs1: 0, rs2 });
            }
            return rd ? make(insn, 'c.jr', { reads: [rd], rs1: rd }) : undefined;
        }
        if (rs2) {
            return make(insn, 'c.add', { reads: [rd, rs2], writes: [rd], rd, rs1: rd, rs2 });
        }
        if (rd) {
            return make(insn, 'c.jalr', { reads: [rd], writes: [RA], rd: RA, rs1: rd });
        }
        return make(insn, 'c.ebreak');
    }
    return decodeZcm(insn);
}

function decodeZcm(insn: number): InsnInfo | undefined {
    /** Zcmp and Zcmt, in the c.fsdsp slot (quadrant 2, funct3 5). */
    const name = zcmMnemonic(insn);
    if (name === undefined) {
        return undefined;
    }
    if (ZCMP_STACK_SET.has(name)) {
        const rlist = (insn >>> 4) & 0xf;
        const saved = zcmpRegisters(rlist);
        const adjust = zcmpStackAdjust(rlist, (insn >>> 2) & 0x3);
        if (name === 'cm.push') {
            return make(insn, name, { reads: [...saved, SP], writes: [SP], rs1: SP, imm: -adjust });
        }
        const writes = name === 'cm.popretz' ? [...saved, SP, A0] : [...saved, SP];
        return make(insn, name, { reads: [SP], writes, loaded: saved, rs1: SP, imm: adjust });
    }
    if (name === 'cm.mvsa01' || name === 'cm.mva01s') {
        const r1s = SREG[(insn >>> 7) & 0x7];
        const r2s = SREG[(insn >>> 2) & 0x7];
        if (name === 'cm.mvsa01') {
            return make(insn, name, { reads: [A0, A1], writes: [r1s, r2s], rs1: r1s, rs2: r2s });
        }
        return make(insn, name, { reads: [r1s, r2s], writes: [A0, A1], rs1: r1s, rs2: r2s });
    }
    // cm.jt and cm.jalt
    const index = (insn >>> 2) & 0xff;
    if (name === 'cm.jt') {
        return make(insn, name, { imm: index });
    }
    return make(insn, name, { writes: [RA], rd: RA, imm: index });
}

// ---------------------------------------------------------------------------
// Forward evaluation
// ---------------------------------------------------------------------------

type ValueFn = (r: number | undefined) => number;
type Operation = (info: InsnInfo, reg: number, pc: number, value: ValueFn) => number;

function signed32(value: number): number {
    return value | 0;
}

function immOf(info: InsnInfo): number {
    if (info.imm === undefined) {
        throw new InsnError(`instruction ${info.mnemonic} has no immediate`);
    }
    return info.imm;
}

function rotateRight(value: number, amount: number): number {
    const amt = amount & SHAMT_MASK;
    if (amt === 0) {
        return value >>> 0;
    }
    return ((value >>> amt) | (value << (XLEN_BITS - amt))) >>> 0;
}

function ones(value: number): number {
    let v = value >>> 0;
    let count = 0;
    while (v) {
        v &= v - 1;
        count++;
    }
    return count;
}

function leadingZeros(value: number): number {
    return Math.clz32(value >>> 0);
}

function trailingZeros(value: number): number {
    const v = value >>> 0;
    if (!v) {
        return XLEN_BITS;
    }
    const low = (v & -v) >>> 0;
    return 31 - Math.clz32(low);
}

function orcB(value: number): number {
    let result = 0;
    for (let shift = 0; shift < 32; shift += 8) {
        if ((value >>> shift) & 0xff) {
            result |= 0xff << shift;
        }
    }
    return result;
}

function rev8(value: number): number {
    const v = value >>> 0;
    return (
        ((v & 0xff) << 24) |
        ((v & 0xff00) << 8) |
        ((v >>> 8) & 0xff00) |
        ((v >>> 24) & 0xff)
    ) >>> 0;
}

function rr(function_: (a: number, b: number) => number): Operation {
    /** Return the operation on the values of rs1 and rs2. */
    return (info, _reg, _pc, value) => function_(value(info.rs1), value(info.rs2));
}

function ri(function_: (a: number, b: number) => number): Operation {
    /** Return the operation on the value of rs1 and the immediate. */
    return (info, _reg, _pc, value) => function_(value(info.rs1), immOf(info));
}

function r(function_: (a: number) => number): Operation {
    /** Return the operation on the value of rs1. */
    return (info, _reg, _pc, value) => function_(value(info.rs1));
}

function link(info: InsnInfo, _reg: number, pc: number, _value: ValueFn): number {
    return pc + info.size;
}

function zcmpStack(info: InsnInfo, reg: number, _pc: number, value: ValueFn): number {
    return reg === A0 ? 0 : value(SP) + immOf(info);
}

function mva01s(info: InsnInfo, reg: number, _pc: number, value: ValueFn): number {
    return value(reg === A0 ? info.rs1 : info.rs2);
}

function mvsa01(info: InsnInfo, reg: number, _pc: number, value: ValueFn): number {
    return value(reg === info.rs1 ? A0 : A1);
}

function add(a: number, b: number): number {
    return a + b;
}

function shl(a: number, b: number): number {
    return (a << (b & SHAMT_MASK)) >>> 0;
}

function shr(a: number, b: number): number {
    return (a >>> 0) >>> (b & SHAMT_MASK);
}

function sar(a: number, b: number): number {
    return signed32(a) >> (b & SHAMT_MASK);
}

function shAdd(shift: number): (a: number, b: number) => number {
    return (a, b) => (a << shift) + b;
}

const EVALUATE = new Map<string, Operation>([
    ['lui', (_info, _reg, _pc, value) => immOf(_info)],
    ['c.lui', (_info, _reg, _pc, value) => immOf(_info)],
    ['auipc', (info, _reg, pc, _value) => pc + immOf(info)],
    ['c.li', ri(add)],
    ['addi', ri(add)],
    ['c.addi', ri(add)],
    ['c.addi16sp', ri(add)],
    ['c.addi4spn', ri(add)],
    ['c.mv', rr(add)],
    ['add', rr(add)],
    ['c.add', rr(add)],
    ['sub', rr((a, b) => a - b)],
    ['c.sub', rr((a, b) => a - b)],
    ['sh1add', rr(shAdd(1))],
    ['sh2add', rr(shAdd(2))],
    ['sh3add', rr(shAdd(3))],
    ['and', rr((a, b) => a & b)],
    ['c.and', rr((a, b) => a & b)],
    ['or', rr((a, b) => a | b)],
    ['c.or', rr((a, b) => a | b)],
    ['xor', rr((a, b) => a ^ b)],
    ['c.xor', rr((a, b) => a ^ b)],
    ['andn', rr((a, b) => a & ~b)],
    ['orn', rr((a, b) => a | ~b)],
    ['xnor', rr((a, b) => ~(a ^ b))],
    ['andi', ri((a, b) => a & b)],
    ['c.andi', ri((a, b) => a & b)],
    ['ori', ri((a, b) => a | b)],
    ['xori', ri((a, b) => a ^ b)],
    ['sll', rr(shl)],
    ['srl', rr(shr)],
    ['sra', rr(sar)],
    ['slli', ri(shl)],
    ['c.slli', ri(shl)],
    ['srli', ri(shr)],
    ['c.srli', ri(shr)],
    ['srai', ri(sar)],
    ['c.srai', ri(sar)],
    ['slt', rr((a, b) => (signed32(a) < signed32(b) ? 1 : 0))],
    ['sltu', rr((a, b) => (a < b ? 1 : 0))],
    ['slti', ri((a, b) => (signed32(a) < b ? 1 : 0))],
    ['sltiu', ri((a, b) => (a < (b >>> 0) ? 1 : 0))],
    ['min', rr((a, b) => (signed32(a) < signed32(b) ? a : b))],
    ['max', rr((a, b) => (signed32(a) > signed32(b) ? a : b))],
    ['minu', rr((a, b) => (a < b ? a : b))],
    ['maxu', rr((a, b) => (a > b ? a : b))],
    ['mul', rr((a, b) => Math.imul(a, b))],
    ['c.mul', rr((a, b) => Math.imul(a, b))],
    ['zext.h', r((a) => a & 0xffff)],
    ['c.zext.h', r((a) => a & 0xffff)],
    ['c.zext.b', r((a) => a & 0xff)],
    ['sext.b', r((a) => signExtend(a, 8))],
    ['c.sext.b', r((a) => signExtend(a, 8))],
    ['sext.h', r((a) => signExtend(a, 16))],
    ['c.sext.h', r((a) => signExtend(a, 16))],
    ['c.not', r((a) => ~a)],
    ['clz', r(leadingZeros)],
    ['ctz', r(trailingZeros)],
    ['cpop', r(ones)],
    ['orc.b', r(orcB)],
    ['rev8', r(rev8)],
    ['rol', rr((a, b) => rotateRight(a, -b))],
    ['ror', rr(rotateRight)],
    ['rori', ri(rotateRight)],
    ['bset', rr((a, b) => a | (1 << (b & SHAMT_MASK)))],
    ['bseti', ri((a, b) => a | (1 << b))],
    ['bclr', rr((a, b) => a & ~(1 << (b & SHAMT_MASK)))],
    ['bclri', ri((a, b) => a & ~(1 << b))],
    ['binv', rr((a, b) => a ^ (1 << (b & SHAMT_MASK)))],
    ['binvi', ri((a, b) => a ^ (1 << b))],
    ['bext', rr((a, b) => (a >>> (b & SHAMT_MASK)) & 1)],
    ['bexti', ri((a, b) => (a >>> b) & 1)],
    ['czero.eqz', rr((a, b) => (b === 0 ? 0 : a))],
    ['czero.nez', rr((a, b) => (b === 0 ? a : 0))],
    ['jal', link],
    ['jalr', link],
    ['c.jal', link],
    ['c.jalr', link],
    ['cm.jalt', link],
    ['cm.push', zcmpStack],
    ['cm.pop', zcmpStack],
    ['cm.popret', zcmpStack],
    ['cm.popretz', zcmpStack],
    ['cm.mva01s', mva01s],
    ['cm.mvsa01', mvsa01],
]);

// ---------------------------------------------------------------------------
// Instruction text
// ---------------------------------------------------------------------------

// Compressed forms objdump and GDB print as the base instruction
const C_BASE: Record<string, string> = {
    'c.addi': 'addi', 'c.addi16sp': 'addi', 'c.addi4spn': 'addi', 'c.li': 'addi', 'c.lui': 'lui',
    'c.add': 'add', 'c.sub': 'sub', 'c.xor': 'xor', 'c.or': 'or', 'c.and': 'and', 'c.mul': 'mul',
    'c.slli': 'slli', 'c.srli': 'srli', 'c.srai': 'srai', 'c.andi': 'andi',
    'c.lw': 'lw', 'c.lwsp': 'lw', 'c.lbu': 'lbu', 'c.lh': 'lh', 'c.lhu': 'lhu',
    'c.sw': 'sw', 'c.swsp': 'sw', 'c.sb': 'sb', 'c.sh': 'sh',
    'c.j': 'jal', 'c.jal': 'jal', 'c.jr': 'jalr', 'c.jalr': 'jalr',
    'c.zext.b': 'zext.b', 'c.sext.b': 'sext.b', 'c.zext.h': 'zext.h', 'c.sext.h': 'sext.h',
};
// The CSRs objdump names. It prints the others, such as the ESP custom ones, as numbers.
const CSR_NAMES: Record<number, string> = {
    0x300: 'mstatus', 0x301: 'misa', 0x304: 'mie', 0x305: 'mtvec', 0x306: 'mcounteren', 0x310: 'mstatush',
    0x340: 'mscratch', 0x341: 'mepc', 0x342: 'mcause', 0x343: 'mtval', 0x344: 'mip',
    0xf11: 'mvendorid', 0xf12: 'marchid', 0xf13: 'mimpid', 0xf14: 'mhartid',
    0xb00: 'mcycle', 0xb02: 'minstret', 0xb80: 'mcycleh', 0xb82: 'minstreth',
    0x7a0: 'tselect', 0x7a1: 'tdata1', 0x7a2: 'tdata2', 0x7a3: 'tdata3', 0x7b0: 'dcsr', 0x7b1: 'dpc',
    0x7b2: 'dscratch0', 0x7b3: 'dscratch1',
};
// The custom CSR ranges of the privileged spec, which objdump never names
const CSR_CUSTOM: Array<[number, number]> = [
    [0x7c0, 0x800], [0xbc0, 0xc00], [0xfc0, 0x1000], [0x800, 0x900], [0xcc0, 0xd00],
];
const CSR_WRITE_ALIASES: Record<string, string> = {
    csrrw: 'csrw', csrrs: 'csrs', csrrc: 'csrc', csrrwi: 'csrwi', csrrsi: 'csrsi', csrrci: 'csrci',
};
const LOAD_NAME_SET = new Set(Object.values(LOADS));
const STORE_NAME_SET = new Set(Object.values(STORES));
const SHIFT_NAME_SET = new Set(['slli', 'srli', 'srai']);
const UNARY_NAME_SET = new Set(['zext.b', 'sext.b', 'zext.h', 'sext.h']);
const OP_IMM_NAME_SET = new Set(['slti', 'sltiu', 'xori', 'ori', 'andi']);
const OP_NAME_SET = new Set([
    'add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and',
    'mul', 'mulh', 'mulhsu', 'mulhu',
]);

export function insnText(info: InsnInfo, pc: number): string | undefined {
    /** Return the instruction at `pc` as objdump prints it with aliases, undefined for the forms not covered. */
    if (!info.supported) {
        return undefined;
    }
    const name = C_BASE[info.mnemonic] ?? info.mnemonic;
    const rd = regOf(info.rd);
    const rs1 = regOf(info.rs1);
    const rs2 = regOf(info.rs2);
    const imm = info.imm;
    if (LOAD_NAME_SET.has(name) && info.mem !== undefined) {
        return `${name} ${rd},${info.mem.offset}(${regOf(info.mem.base)})`;
    }
    if (STORE_NAME_SET.has(name) && info.mem !== undefined) {
        return `${name} ${rs2},${info.mem.offset}(${regOf(info.mem.base)})`;
    }
    if ((name === 'lui' || name === 'auipc') && imm !== undefined) {
        return `${name} ${rd},0x${((imm >> 12) & 0xfffff).toString(16)}`;
    }
    if (name === 'c.mv') {
        return `mv ${rd},${rs2}`;
    }
    if (name === 'addi' && imm !== undefined) {
        if (info.rd === 0 && info.rs1 === 0 && imm === 0) {
            return 'nop';
        }
        if (info.rs1 === 0) {
            return `li ${rd},${imm}`;
        }
        return imm === 0 ? `mv ${rd},${rs1}` : `addi ${rd},${rs1},${imm}`;
    }
    if (OP_IMM_NAME_SET.has(name) && imm !== undefined) {
        const alias =
            name === 'sltiu' && imm === 1 ? 'seqz' :
            name === 'xori' && imm === -1 ? 'not' :
            name === 'andi' && imm === 255 ? 'zext.b' : undefined;
        return alias ? `${alias} ${rd},${rs1}` : `${name} ${rd},${rs1},${imm}`;
    }
    if (SHIFT_NAME_SET.has(name) && imm !== undefined) {
        return `${name} ${rd},${rs1},0x${imm.toString(16)}`;
    }
    if (UNARY_NAME_SET.has(name) || name === 'c.not') {
        return `${name === 'c.not' ? 'not' : name} ${rd},${rs1}`;
    }
    if (OP_NAME_SET.has(name)) {
        return opText(name, info);
    }
    if (name === 'jal' && imm !== undefined) {
        const target = (pc + imm) >>> 0;
        if (info.rd === undefined || info.rd === 0) {
            return `j 0x${target.toString(16)}`;
        }
        return info.rd === RA ? `jal 0x${target.toString(16)}` : `jal ${rd},0x${target.toString(16)}`;
    }
    if (name === 'jalr') {
        return jalrText(info);
    }
    if (info.csr !== undefined) {
        return csrText(name, info);
    }
    return undefined;
}

function regOf(reg: number | undefined): string {
    return regName(reg ?? 0);
}

function opText(name: string, info: InsnInfo): string {
    const rd = regOf(info.rd);
    const rs1 = regOf(info.rs1);
    const rs2 = regOf(info.rs2);
    if (name === 'sub' && !info.rs1) {
        return `neg ${rd},${rs2}`;
    }
    if (name === 'sltu' && !info.rs1) {
        return `snez ${rd},${rs2}`;
    }
    if (name === 'slt' && !info.rs2) {
        return `sltz ${rd},${rs1}`;
    }
    if (name === 'slt' && !info.rs1) {
        return `sgtz ${rd},${rs2}`;
    }
    return `${name} ${rd},${rs1},${rs2}`;
}

function jalrText(info: InsnInfo): string {
    const rs1 = regOf(info.rs1);
    const imm = info.imm ?? 0;
    if (!info.rd) {
        if (info.rs1 === RA && !imm) {
            return 'ret';
        }
        return imm ? `jr ${imm}(${rs1})` : `jr ${rs1}`;
    }
    if (info.rd === RA) {
        return imm ? `jalr ${imm}(${rs1})` : `jalr ${rs1}`;
    }
    return `jalr ${regOf(info.rd)},${imm}(${rs1})`;
}

function csrText(name: string, info: InsnInfo): string | undefined {
    const csr = info.csr;
    if (csr === undefined) {
        return undefined;
    }
    let csrName: string;
    const named = CSR_NAMES[csr];
    if (named !== undefined) {
        csrName = named;
    } else if (CSR_CUSTOM.some(([start, end]) => start <= csr && csr < end)) {
        csrName = `0x${csr.toString(16)}`;
    } else {
        // A standard CSR objdump has a name for that this table lacks, or an alias
        return undefined;
    }
    const source = name.endsWith('i') ? String(info.imm) : regOf(info.rs1);
    if (name === 'csrrs' && !info.rs1) {
        return `csrr ${regOf(info.rd)},${csrName}`;
    }
    if (!info.rd) {
        return `${CSR_WRITE_ALIASES[name] ?? name} ${csrName},${source}`;
    }
    return `${name} ${regOf(info.rd)},${csrName},${source}`;
}
