// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/elf/rom.py (Apache-2.0) and
// esp_pylib.rom (Apache-2.0): ROM ELF auto-detection via IDF_PATH/ESP_ROM_ELF_DIR.

import * as fs from 'fs';
import * as path from 'path';

export enum RomStatus {
    PROVIDED = 'provided',
    AUTO = 'auto-detected',
    NOT_FOUND = 'not-found',
    MISSING_ENV = 'missing-env',
    INVALID = 'invalid',
}

function getIdfPath(env: NodeJS.ProcessEnv = process.env): string {
    return env.IDF_PATH ?? '';
}

function getRomElfDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.ESP_ROM_ELF_DIR ?? '';
}

function romsJsonPaths(idfPath: string): string[] {
    /** Both possible `roms.json` locations under `IDF_PATH`. */
    return [
        path.join(idfPath, 'components', 'esp_rom', 'roms.json'),
        path.join(idfPath, 'tools', 'idf_py_actions', 'roms.json'),
    ];
}

function loadTargetRoms(target: string, idfPath: string): Array<Record<string, unknown>> {
    /** Load `roms.json` revision entries for `target`. */
    for (const romsJsonPath of romsJsonPaths(idfPath)) {
        let data: unknown;
        try {
            data = JSON.parse(fs.readFileSync(romsJsonPath, 'utf-8'));
        } catch {
            continue;
        }
        if (typeof data !== 'object' || data === null) {
            continue;
        }
        const candidate = (data as Record<string, unknown>)[target];
        if (!Array.isArray(candidate) || candidate.length === 0) {
            continue;
        }
        return candidate as Array<Record<string, unknown>>;
    }
    return [];
}

function selectRomRevision(targetRoms: Array<Record<string, unknown>>, chipRev: number): number | undefined {
    /** Select an exact or next-lower ROM revision. `chipRev` is `major * 100 + minor`. */
    const candidateRevs: number[] = [];
    for (const rom of targetRoms) {
        const rev = rom.rev;
        if (typeof rev === 'number' && Number.isInteger(rev) && rev <= chipRev) {
            candidateRevs.push(rev);
        }
    }
    return candidateRevs.length ? Math.max(...candidateRevs) : undefined;
}

export function getRomElfPath(target: string, chipRev: number, env: NodeJS.ProcessEnv = process.env): string | undefined {
    /** Resolve the ROM ELF path for `target` and `chipRev` in the ESP-IDF environment. */
    const romElfDir = getRomElfDir(env);
    const idfPath = getIdfPath(env);
    if (!idfPath || !romElfDir) {
        return undefined;
    }
    const selectedRev = selectRomRevision(loadTargetRoms(target, idfPath), chipRev);
    if (selectedRev === undefined) {
        return undefined;
    }
    return path.join(romElfDir, `${target}_rev${selectedRev}_rom.elf`);
}

export function resolveRomElf(
    chip: string,
    chipRevision: number,
    env: NodeJS.ProcessEnv = process.env
): [string | undefined, RomStatus] {
    /** Find the ROM ELF for `chip` and `chipRevision` in the ESP-IDF environment. */
    if (!getIdfPath(env) || !getRomElfDir(env)) {
        return [undefined, RomStatus.MISSING_ENV];
    }
    const resolved = getRomElfPath(chip, chipRevision, env);
    if (resolved === undefined || !fs.existsSync(resolved)) {
        return [undefined, RomStatus.NOT_FOUND];
    }
    return [resolved, RomStatus.AUTO];
}
