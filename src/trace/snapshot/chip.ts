// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/snapshot/chip.py (Apache-2.0).

export const CHIP_ID_ESP32 = 0x0000;
export const CHIP_ID_ESP32S2 = 0x0002;
export const CHIP_ID_ESP32C3 = 0x0005;
export const CHIP_ID_ESP32S3 = 0x0009;
export const CHIP_ID_ESP32C2 = 0x000c;
export const CHIP_ID_ESP32C6 = 0x000d;
export const CHIP_ID_ESP32H2 = 0x0010;
export const CHIP_ID_ESP32P4 = 0x0012;
export const CHIP_ID_ESP32C61 = 0x0014;
export const CHIP_ID_ESP32C5 = 0x0017;
export const CHIP_ID_ESP32H21 = 0x0019;
export const CHIP_ID_ESP32H4 = 0x001c;
export const CHIP_ID_ESP32S31 = 0x0020;

export const CHIP_NAME_TO_ID: Record<string, number> = {
    esp32: CHIP_ID_ESP32,
    esp32s2: CHIP_ID_ESP32S2,
    esp32c3: CHIP_ID_ESP32C3,
    esp32s3: CHIP_ID_ESP32S3,
    esp32c2: CHIP_ID_ESP32C2,
    esp32c6: CHIP_ID_ESP32C6,
    esp32h2: CHIP_ID_ESP32H2,
    esp32p4: CHIP_ID_ESP32P4,
    esp32c61: CHIP_ID_ESP32C61,
    esp32c5: CHIP_ID_ESP32C5,
    esp32h21: CHIP_ID_ESP32H21,
    esp32h4: CHIP_ID_ESP32H4,
    esp32s31: CHIP_ID_ESP32S31,
};

export const CHIP_ID_TO_NAME: Record<number, string> = Object.fromEntries(
    Object.entries(CHIP_NAME_TO_ID).map(([name, id]) => [id, name])
);

// Espressif RISC-V chips whose trace encoder we support decoding for.
export const RISCV_TRACE_CHIPS: ReadonlySet<string> = new Set([
    'esp32c5',
    'esp32c6',
    'esp32c61',
    'esp32h2',
    'esp32h21',
    'esp32h4',
    'esp32p4',
    'esp32s31',
]);

/** Return the chip name for a ``target_id``, or undefined when unmapped. */
export function chipNameFromId(targetId: number): string | undefined {
    return CHIP_ID_TO_NAME[targetId];
}

/** Return true when the chip has a supported RISC-V trace encoder. */
export function isRiscvTraceChip(nameOrId: string | number): boolean {
    let name: string | undefined;
    if (typeof nameOrId === 'number') {
        name = CHIP_ID_TO_NAME[nameOrId];
    } else {
        name = nameOrId.trim().toLowerCase();
    }
    return name !== undefined && RISCV_TRACE_CHIPS.has(name);
}
