/**
 * Formats a number as a zero-padded hexadecimal string.
 */
export function hexFormat(value: number | bigint, padding: number = 8, includePrefix: boolean = true): string {
    let result = value.toString(16);
    while (result.length < padding) {
        result = '0' + result;
    }
    return includePrefix ? '0x' + result : result;
}

/**
 * Formats a number as a binary string, with optional nibble grouping.
 * 
 * Note: This function accepts negative values and will produce negative binary strings
 * (e.g., -1 becomes "-1" in binary). For unsigned/register display, ensure input is non-negative.
 * Values wider than the padding will show all bits (no truncation).
 * 
 * @param value - Number or bigint to format
 * @param padding - Minimum width (pads with leading zeros)
 * @param includePrefix - Whether to include "0b" prefix
 * @param groupByNibble - Whether to group bits by 4 (nibbles)
 */
export function binaryFormat(
    value: number | bigint,
    padding: number = 0,
    includePrefix: boolean = true,
    groupByNibble: boolean = false
): string {
    let result = typeof value === 'bigint' ? value.toString(2) : Math.trunc(value).toString(2);
    while (result.length < padding) {
        result = '0' + result;
    }

    if (groupByNibble) {
        const extraZeros = (4 - (result.length % 4)) % 4;
        for (let i = 0; i < extraZeros; i++) {
            result = '0' + result;
        }
        const groups = result.match(/[01]{4}/g) || [];
        result = groups.join(' ');
    }

    return includePrefix ? '0b' + result : result;
}

/**
 * Extracts a bit field from a value using arithmetic (supports >32-bit values).
 * Note: This function expects non-negative integer inputs. Negative values,
 * non-integer values, or invalid offset/width will produce incorrect results.
 * For values requiring >53-bit precision, use extractBitsBigInt instead.
 */
export function extractBits(value: number, offset: number, width: number): number {
    if (value < 0 || !Number.isInteger(value)) {
        throw new Error('extractBits: value must be a non-negative integer');
    }
    if (offset < 0 || !Number.isInteger(offset)) {
        throw new Error('extractBits: offset must be a non-negative integer');
    }
    if (width < 0 || !Number.isInteger(width)) {
        throw new Error('extractBits: width must be a non-negative integer');
    }
    return Math.floor(value / Math.pow(2, offset)) % Math.pow(2, width);
}

/**
 * Extracts a bit field from a bigint value.
 * Returns bigint to preserve precision for fields >53 bits.
 */
export function extractBitsBigInt(value: bigint, offset: number, width: number): bigint {
    if (typeof value !== 'bigint') {
        throw new Error('extractBitsBigInt: value must be a bigint');
    }
    if (value < 0n) {
        throw new Error('extractBitsBigInt: value must be non-negative');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('extractBitsBigInt: offset must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(width) || width < 0) {
        throw new Error('extractBitsBigInt: width must be a non-negative safe integer');
    }
    const shifted = value >> BigInt(offset);
    const mask = (1n << BigInt(width)) - 1n;
    return shifted & mask;
}

/**
 * Parses a string as a bigint, supporting hex (0x), binary (0b), decimal, and hash-binary (#) prefixes.
 */
export function parseBigInt(value: string): bigint | undefined {
    if (/^0b([01]+)$/i.test(value)) {
        return BigInt('0b' + value.substring(2));
    }
    if (/^0x([0-9a-f]+)$/i.test(value)) {
        return BigInt('0x' + value.substring(2));
    }
    if (/^[0-9]+$/i.test(value)) {
        return BigInt(value);
    }
    if (/^#[0-1]+$/i.test(value)) {
        return BigInt('0b' + value.substring(1));
    }
    return undefined;
}

/**
 * Parses a URL query string into a key-value map.
 */
export function parseQuery(queryString: string): { [key: string]: string } {
    const params: { [key: string]: string } = {};
    const pairs = (queryString[0] === '?' ? queryString.substring(1) : queryString).split('&');
    for (const pair of pairs) {
        const parts = pair.split('=');
        params[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
    }
    return params;
}

/**
 * Encodes a function name and source file into a disassembly:// URI.
 */
export function encodeDisassembly(name: string, file: string): string {
    let uri = 'disassembly:///';
    if (file) {
        uri += `${file}:`;
    }
    uri += `${name}.dbgasm?func=${name}&file=${file || ''}`;
    return uri;
}
