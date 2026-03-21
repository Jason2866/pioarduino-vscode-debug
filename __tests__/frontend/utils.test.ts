import { hexFormat, binaryFormat, extractBits, extractBitsBigInt } from '../../src/utils';

describe('hexFormat', () => {
    test('formats number with default padding and prefix', () => {
        expect(hexFormat(255)).toBe('0x000000ff');
    });

    test('formats number with custom padding', () => {
        expect(hexFormat(255, 4)).toBe('0x00ff');
    });

    test('formats number without prefix', () => {
        expect(hexFormat(255, 4, false)).toBe('00ff');
    });

    test('formats bigint value', () => {
        expect(hexFormat(0xFFn, 4)).toBe('0x00ff');
    });

    test('formats 64-bit bigint value', () => {
        expect(hexFormat(0xFFFFFFFFFFFFFFFFn, 16)).toBe('0xffffffffffffffff');
    });

    test('formats bigint beyond Number.MAX_SAFE_INTEGER', () => {
        expect(hexFormat(0x20000000000000n, 16)).toBe('0x0020000000000000');
    });

    test('formats zero', () => {
        expect(hexFormat(0, 2)).toBe('0x00');
    });

    test('formats bigint zero', () => {
        expect(hexFormat(0n, 2)).toBe('0x00');
    });
});

describe('binaryFormat', () => {
    test('formats number with prefix', () => {
        expect(binaryFormat(5, 8)).toBe('0b00000101');
    });

    test('formats number without prefix', () => {
        expect(binaryFormat(5, 8, false)).toBe('00000101');
    });

    test('formats bigint value', () => {
        expect(binaryFormat(5n, 8)).toBe('0b00000101');
    });

    test('formats 64-bit bigint value', () => {
        const result = binaryFormat(0xFFFFFFFFFFFFFFFFn, 64);
        expect(result).toBe('0b' + '1'.repeat(64));
    });

    test('formats bigint with nibble grouping', () => {
        expect(binaryFormat(0xABn, 8, true, true)).toBe('0b1010 1011');
    });

    test('formats number with nibble grouping', () => {
        expect(binaryFormat(0xFF, 8, true, true)).toBe('0b1111 1111');
    });

    test('nibble grouping with non-multiple-of-4 width pads to nibble boundary', () => {
        expect(binaryFormat(7, 3, true, true)).toBe('0b0111');
    });

    test('formats zero', () => {
        expect(binaryFormat(0, 8)).toBe('0b00000000');
    });

    test('formats bigint zero', () => {
        expect(binaryFormat(0n, 8)).toBe('0b00000000');
    });
});

describe('extractBits (number)', () => {
    test('extracts low byte', () => {
        expect(extractBits(0xABCD, 0, 8)).toBe(0xCD);
    });

    test('extracts high byte', () => {
        expect(extractBits(0xABCD, 8, 8)).toBe(0xAB);
    });

    test('extracts single bit', () => {
        expect(extractBits(0b1010, 1, 1)).toBe(1);
        expect(extractBits(0b1010, 0, 1)).toBe(0);
    });

    test('extracts from offset 0 full width', () => {
        expect(extractBits(0xFF, 0, 8)).toBe(0xFF);
    });

    test('extracts zero field', () => {
        expect(extractBits(0xFF00, 0, 8)).toBe(0);
    });
});

describe('extractBitsBigInt', () => {
    test('extracts low byte from 32-bit value', () => {
        expect(extractBitsBigInt(0xABCDn, 0, 8)).toBe(0xCD);
    });

    test('extracts high byte from 32-bit value', () => {
        expect(extractBitsBigInt(0xABCDn, 8, 8)).toBe(0xAB);
    });

    test('extracts single bit', () => {
        expect(extractBitsBigInt(0b1010n, 3, 1)).toBe(1);
        expect(extractBitsBigInt(0b1010n, 2, 1)).toBe(0);
    });

    test('extracts upper 32 bits of 64-bit value', () => {
        expect(extractBitsBigInt(0x1234567890ABCDEFn, 32, 32)).toBe(0x12345678);
    });

    test('extracts lower 32 bits of 64-bit value', () => {
        expect(extractBitsBigInt(0x1234567890ABCDEFn, 0, 32)).toBe(0x90ABCDEF);
    });

    test('extracts field spanning 32-bit boundary', () => {
        expect(extractBitsBigInt(0xFF00000000n, 28, 12)).toBe(0xFF0);
    });

    test('extracts full 64-bit value as number (up to safe range)', () => {
        // 48-bit value fits in Number safely
        expect(extractBitsBigInt(0xFFFFFFFFFFFFn, 0, 48)).toBe(0xFFFFFFFFFFFF);
    });

    test('extracts from zero value', () => {
        expect(extractBitsBigInt(0n, 0, 32)).toBe(0);
    });

    test('extracts bits at high offset', () => {
        expect(extractBitsBigInt(0x8000000000000000n, 63, 1)).toBe(1);
    });
});
