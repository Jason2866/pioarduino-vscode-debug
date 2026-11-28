import * as fs from 'fs';

export type ChipArch = 'xtensa' | 'riscv';

/**
 * Xtensa chips — ESP32, ESP32-S2, ESP32-S3 and ESP8266 are the only non-RISC-V
 * ESP targets. Trace decoding is only supported on RISC-V targets.
 */
export const XTENSA_CHIPS = ['esp32', 'esp32s2', 'esp32s3', 'esp8266'] as const;

const XTENSA_SET: ReadonlySet<string> = new Set(XTENSA_CHIPS);

/**
 * Chip / IDF target names used to detect the chip from board or MCU strings.
 * Sorted longest-first so 'esp32s31' matches before 'esp32s3' and 'esp32c61'
 * before 'esp32c6'.
 */
export const KNOWN_CHIPS: readonly string[] = [
    'esp32c2',
    'esp32c3',
    'esp32c5',
    'esp32c6',
    'esp32c61',
    'esp32h2',
    'esp32h21',
    'esp32h4',
    'esp32p4',
    'esp32s31',
    ...XTENSA_CHIPS,
].sort((a, b) => b.length - a.length);

/** Chips supported by the Espressif RISC-V trace decoder. */
export const TRACE_SUPPORTED_CHIPS: ReadonlySet<string> = new Set([
    'esp32c5',
    'esp32c6',
    'esp32c61',
    'esp32h2',
    'esp32h21',
    'esp32h4',
    'esp32p4',
    'esp32s31',
]);

/** Architecture family for a chip / IDF target name. */
export function chipArch(chip: string): ChipArch {
    // Normalize like isTraceSupportedChip: 'ESP32-S3' is Xtensa too.
    return XTENSA_SET.has(normalizeChipName(chip)) ? 'xtensa' : 'riscv';
}

export function normalizeChipName(chip: string): string {
    return chip.toLowerCase().replace(/[-_]/g, '');
}

/** Returns true when the normalized chip name is supported by trace decoding. */
export function isTraceSupportedChip(chip: string | undefined): boolean {
    if (!chip) {
        return false;
    }
    const normalized = normalizeChipName(chip);
    return TRACE_SUPPORTED_CHIPS.has(normalized);
}

const ELF_MACHINE_XTENSA = 94;
const ELF_MACHINE_RISCV = 243;

/**
 * Detect the architecture family from an ELF file's e_machine header field.
 * The header is re-read on every call so firmware rebuilds do not see stale
 * results.
 */
export function detectElfArch(elfPath: string): ChipArch | undefined {
    let arch: ChipArch | undefined;
    try {
        const fd = fs.openSync(elfPath, 'r');
        try {
            const buf = Buffer.alloc(20);
            if (
                fs.readSync(fd, buf, 0, 20, 0) === 20 &&
                buf.readUInt32BE(0) === 0x7f454c46 // \x7fELF
            ) {
                if (buf[5] === 1 || buf[5] === 2) {
                    const machine =
                        buf[5] === 2 ? buf.readUInt16BE(18) : buf.readUInt16LE(18);
                    if (machine === ELF_MACHINE_XTENSA) {
                        arch = 'xtensa';
                    } else if (machine === ELF_MACHINE_RISCV) {
                        arch = 'riscv';
                    }
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        // unreadable or non-ELF file
    }
    return arch;
}
