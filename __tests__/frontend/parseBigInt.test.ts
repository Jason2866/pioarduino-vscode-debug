import { parseBigInt } from '../../src/utils';

describe('parseBigInt', () => {
    test('parses hex string', () => {
        expect(parseBigInt('0xFF')).toBe(255n);
    });

    test('parses hex string case-insensitive', () => {
        expect(parseBigInt('0XAb')).toBe(0xABn);
    });

    test('parses 64-bit hex string without precision loss', () => {
        expect(parseBigInt('0xFFFFFFFFFFFFFFFF')).toBe(0xFFFFFFFFFFFFFFFFn);
    });

    test('parses hex value beyond Number.MAX_SAFE_INTEGER exactly', () => {
        expect(parseBigInt('0x20000000000001')).toBe(0x20000000000001n);
    });

    test('parses binary string', () => {
        expect(parseBigInt('0b1010')).toBe(10n);
    });

    test('parses binary string case-insensitive', () => {
        expect(parseBigInt('0B1100')).toBe(12n);
    });

    test('parses 64-bit binary string', () => {
        const bin64 = '0b' + '1'.repeat(64);
        expect(parseBigInt(bin64)).toBe(0xFFFFFFFFFFFFFFFFn);
    });

    test('parses decimal string', () => {
        expect(parseBigInt('12345')).toBe(12345n);
    });

    test('parses large decimal string', () => {
        expect(parseBigInt('18446744073709551615')).toBe(0xFFFFFFFFFFFFFFFFn);
    });

    test('parses hash-prefix binary', () => {
        expect(parseBigInt('#1010')).toBe(10n);
    });

    test('parses zero', () => {
        expect(parseBigInt('0')).toBe(0n);
    });

    test('parses 0x0', () => {
        expect(parseBigInt('0x0')).toBe(0n);
    });

    test('returns undefined for invalid input', () => {
        expect(parseBigInt('hello')).toBeUndefined();
    });

    test('returns undefined for empty string', () => {
        expect(parseBigInt('')).toBeUndefined();
    });

    test('returns undefined for mixed invalid format', () => {
        expect(parseBigInt('0xGG')).toBeUndefined();
    });
});
