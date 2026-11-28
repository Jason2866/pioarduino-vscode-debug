import { InsnClass, LinkKind } from '../../src/trace/ir/events';
import { decodeInsn } from '../../src/trace/decoder/instruction';
import { insnLength, InsnError, regName, signExtend } from '../../src/trace/decoder/encoding';

function insn32(v: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    return b;
}

function insn16(v: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v, 0);
    return b;
}

describe('decoder/encoding', () => {
    it('computes instruction length', () => {
        expect(insnLength(0x0001)).toBe(2); // quadrant 0
        expect(insnLength(0x0002)).toBe(2); // quadrant 1
        expect(insnLength(0x0003)).toBe(4); // quadrant 2 -> wait, quadrant bits are 1..0; 0b11 = 32-bit
    });

    it('rejects encodings wider than 32 bits', () => {
        expect(() => insnLength(0x003f)).toThrow(InsnError);
        expect(() => insnLength(0x007f)).toThrow(InsnError);
    });

    it('sign-extends immediates', () => {
        expect(signExtend(0xfff, 12)).toBe(-1);
        expect(signExtend(0x7ff, 12)).toBe(2047);
        expect(signExtend(0x1fffff, 21)).toBe(-1);
        expect(signExtend(0xfffff, 21)).toBe(1048575);
    });

    it('names registers', () => {
        expect(regName(0)).toBe('zero');
        expect(regName(1)).toBe('ra');
        expect(regName(10)).toBe('a0');
        expect(regName(8)).toBe('s0');
    });
});

describe('decoder/instruction', () => {
    it('decodes ecall as TRAP', () => {
        const d = decodeInsn(0x1000, insn32(0x00000073));
        expect(d.cls).toBe(InsnClass.TRAP);
        expect(d.length).toBe(4);
    });

    it('decodes mret/sret as trap returns', () => {
        const mret = decodeInsn(0x1000, insn32(0x30200073));
        expect(mret.cls).toBe(InsnClass.UNINFERABLE);
        expect(mret.link).toBe(LinkKind.TRAP_RETURN);
        const sret = decodeInsn(0x1000, insn32(0x10200073));
        expect(sret.link).toBe(LinkKind.TRAP_RETURN);
    });

    it('decodes jal x0 as a plain JUMP', () => {
        const d = decodeInsn(0x1000, insn32(0x0080006f)); // jal x0, +8
        expect(d.cls).toBe(InsnClass.JUMP);
        expect(d.direct_target).toBe(0x1008);
        expect(d.link).toBe(LinkKind.JUMP);
    });

    it('decodes jal ra as a CALL', () => {
        const d = decodeInsn(0x1000, insn32(0x008000ef)); // jal ra, +8
        expect(d.cls).toBe(InsnClass.JUMP);
        expect(d.link).toBe(LinkKind.CALL);
    });

    it('decodes beq as a BRANCH with direct target', () => {
        const d = decodeInsn(0x1000, insn32(0x00000263)); // beq x0, x0, +4
        expect(d.cls).toBe(InsnClass.BRANCH);
        expect(d.direct_target).toBe(0x1004);
    });

    it('decodes jalr ra as RETURN', () => {
        // jalr x0, 0(ra): opcode 0x67, funct3 0, rs1=1, rd=0, imm=0
        const insn = 0x00008067;
        const d = decodeInsn(0x1000, insn32(insn));
        expect(d.cls).toBe(InsnClass.UNINFERABLE);
        expect(d.link).toBe(LinkKind.RETURN);
    });

    it('decodes non-control RV32I as NONE', () => {
        const d = decodeInsn(0x1000, insn32(0x00000013)); // nop (addi x0,x0,0)
        expect(d.cls).toBe(InsnClass.NONE);
        expect(d.length).toBe(4);
    });

    it('decodes c.j as JUMP and c.jal as CALL', () => {
        // c.j: quadrant 1, funct3=101. imm=0 -> target=pc
        const cj = 0b101 << 13 | 0b01; // funct3=5, quadrant=1
        const d1 = decodeInsn(0x2000, insn16(cj));
        expect(d1.cls).toBe(InsnClass.JUMP);
        expect(d1.length).toBe(2);
        expect(d1.link).toBe(LinkKind.JUMP);

        // c.jal: funct3=001, quadrant 1
        const cjal = 0b001 << 13 | 0b01;
        const d2 = decodeInsn(0x2000, insn16(cjal));
        expect(d2.cls).toBe(InsnClass.JUMP);
        expect(d2.link).toBe(LinkKind.CALL);
    });

    it('decodes c.beqz as BRANCH', () => {
        // funct3=110, quadrant 1
        const insn = 0b110 << 13 | 0b01;
        const d = decodeInsn(0x2000, insn16(insn));
        expect(d.cls).toBe(InsnClass.BRANCH);
        expect(d.length).toBe(2);
    });

    it('decodes c.jr ra as RETURN', () => {
        const insn = 0x8082; // funct4=8, rs1=ra, rs2=0, quadrant 2
        const d = decodeInsn(0x2000, insn16(insn));
        expect(d.cls).toBe(InsnClass.UNINFERABLE);
        expect(d.link).toBe(LinkKind.RETURN);
    });

    it('decodes c.jalr a0 as CALL', () => {
        const insn = 0x9502; // funct4=9, rs1=a0, rs2=0, quadrant 2
        const d = decodeInsn(0x2000, insn16(insn));
        expect(d.cls).toBe(InsnClass.UNINFERABLE);
        expect(d.link).toBe(LinkKind.CALL);
    });

    it('decodes c.ebreak as TRAP', () => {
        // c.ebreak = 0x9002 (funct4=9, rs1=0, rs2=0, quadrant 2)
        const d = decodeInsn(0x2000, insn16(0x9002));
        expect(d.cls).toBe(InsnClass.TRAP);
    });

    it('decodes cm.jt as UNINFERABLE JUMP', () => {
        const insn = 0xa002; // funct3=5, form=0, index=0
        const d = decodeInsn(0x2000, insn16(insn));
        expect(d.cls).toBe(InsnClass.UNINFERABLE);
        expect(d.link).toBe(LinkKind.JUMP);
    });

    it('decodes cm.popret as RETURN', () => {
        // funct3=5 prefix plus bits12..8 = 0b11110, rlist>=4
        const insn = 0xa000 | (0b11110 << 8) | (0b0100 << 4) | 0b10;
        const d = decodeInsn(0x2000, insn16(insn));
        expect(d.cls).toBe(InsnClass.UNINFERABLE);
        expect(d.link).toBe(LinkKind.RETURN);
    });

    it('rejects truncated instructions', () => {
        expect(() => decodeInsn(0x1000, Buffer.alloc(1))).toThrow(InsnError);
        // a 32-bit quadrant halfword with only 2 bytes needs 4
        expect(() => decodeInsn(0x1000, insn16(0x0003))).toThrow(InsnError);
        expect(() => decodeInsn(0x1000, Buffer.from([0x6f, 0x00]))).toThrow(InsnError);
    });
});
