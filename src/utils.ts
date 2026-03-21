/**
 * Formats a number as a zero-padded hexadecimal string.
 */
export function hexFormat(value: number, padding: number = 8, includePrefix: boolean = true): string {
/**
 * Formats a number as a zero-padded hexadecimal string.
 */
    let result = value.toString(16);
    while (result.length < padding) {
        result = '0' + result;
    }
    return includePrefix ? '0x' + result : result;
}

/**
 * Formats a number as a binary string, with optional nibble grouping.
 */
export function binaryFormat(
    value: number,
    padding: number = 0,
    includePrefix: boolean = true,
    groupByNibble: boolean = false
): string {
/**
 * Formats a number as a binary string, with optional nibble grouping.
 */
    let result = Math.trunc(value).toString(2);
    while (result.length < padding) {
        result = '0' + result;
    }

    if (groupByNibble) {
        const extraZeros = (4 - (result.length % 4)) % 4;
        for (let i = 0; i < extraZeros; i++) {
            result = '0' + result;
        }
        const groups = result.match(/[01]{4}/g);
        result = groups.join(' ');
    }

    return includePrefix ? '0b' + result : result;
}

/**
 * Creates a bitmask covering the specified bit range.
 */
export function createMask(offset: number, width: number): number {
/**
 * Creates a bitmask covering the specified bit range.
 * Note: Only exact for masks that fit within Number.MAX_SAFE_INTEGER (53 bits).
 */
    let mask = 0;
    const end = offset + width - 1;
    for (let i = offset; i <= end; i++) {
        mask += Math.pow(2, i);
    }
    return mask;
}

/**
 * Extracts a bit field from a value.
 */
export function extractBits(value: number, offset: number, width: number): number {
/**
 * Extracts a bit field from a value using arithmetic (supports >32-bit values).
 */
    return Math.floor(value / Math.pow(2, offset)) % Math.pow(2, width);
}

/**
 * Parses a URL query string into a key-value map.
 */
export function parseQuery(queryString: string): { [key: string]: string } {
/**
 * Parses a URL query string into a key-value map.
 */
    const params: { [key: string]: string } = {};
    const pairs = (queryString[0] === '?' ? queryString.substr(1) : queryString).split('&');
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
/**
 * Encodes a function name and source file into a disassembly:// URI.
 */
    let uri = 'disassembly:///';
    if (file) {
        uri += `${file}:`;
    }
    uri += `${name}.dbgasm?func=${name}&file=${file || ''}`;
    return uri;
}
