import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chipArch, detectElfArch, isTraceSupportedChip, KNOWN_CHIPS } from '../../src/trace/chip';

function writeElf(filePath: string, machine: number, elfClass = 1): void {
    const elf = Buffer.alloc(52, 0);
    elf.writeUInt32BE(0x7f454c46, 0);
    elf[4] = elfClass;
    elf[5] = 1;
    elf.writeUInt16LE(machine, 18);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, elf);
}

describe('trace chip helpers', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-chip-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('detects RISC-V and Xtensa ELF architectures', () => {
        const riscv = path.join(tempDir, 'riscv.elf');
        const xtensa = path.join(tempDir, 'xtensa.elf');
        writeElf(riscv, 243);
        writeElf(xtensa, 94);

        expect(detectElfArch(riscv)).toBe('riscv');
        expect(detectElfArch(xtensa)).toBe('xtensa');
        expect(detectElfArch(path.join(tempDir, 'missing.elf'))).toBeUndefined();
    });

    test('maps chip families to architectures', () => {
        expect(chipArch('esp32')).toBe('xtensa');
        expect(chipArch('esp8266')).toBe('xtensa');
        expect(chipArch('esp32c6')).toBe('riscv');
        expect(chipArch('esp32h21')).toBe('riscv');
    });

    test('identifies trace-supported chips', () => {
        expect(isTraceSupportedChip('esp32c6')).toBe(true);
        expect(isTraceSupportedChip('esp32h21')).toBe(true);
        expect(isTraceSupportedChip('esp32')).toBe(false);
        expect(isTraceSupportedChip(undefined)).toBe(false);
    });

    test('keeps known chips sorted longest-first', () => {
        expect(KNOWN_CHIPS.indexOf('esp32s31')).toBeLessThan(KNOWN_CHIPS.indexOf('esp32s3'));
        expect(KNOWN_CHIPS.indexOf('esp32c61')).toBeLessThan(KNOWN_CHIPS.indexOf('esp32c6'));
        expect(KNOWN_CHIPS).toContain('esp32h21');
    });
});
