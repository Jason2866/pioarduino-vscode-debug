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
        const groups = result.match(/[01]{4}/g);
        result = groups.join(' ');
    }

    return includePrefix ? '0b' + result : result;
}

/**
 * Extracts a bit field from a value using arithmetic (supports >32-bit values).
 */
export function extractBits(value: number, offset: number, width: number): number {
    return Math.floor(value / Math.pow(2, offset)) % Math.pow(2, width);
}

/**
 * Extracts a bit field from a bigint value.
 */
export function extractBitsBigInt(value: bigint, offset: number, width: number): number {
    const shifted = value >> BigInt(offset);
    const mask = (1n << BigInt(width)) - 1n;
    return Number(shifted & mask);
}

/**
 * Parses a URL query string into a key-value map.
 */
export function parseQuery(queryString: string): { [key: string]: string } {
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
    let uri = 'disassembly:///';
    if (file) {
        uri += `${file}:`;
    }
    uri += `${name}.dbgasm?func=${name}&file=${file || ''}`;
    return uri;
}
