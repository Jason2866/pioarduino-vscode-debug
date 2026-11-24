// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Parity tests: the TypeScript port must reproduce the upstream
// esp-riscv-trace CLI output byte for byte on the shared fixtures.

import * as fs from 'fs';
import * as path from 'path';
import {
    decodeCapture,
    historyCapture,
    profileCapture,
    statsCapture,
} from '../../src/trace/commands';
import { findPioAddr2linePath, getPioPackagesDir } from '../../src/trace/pioToolchain';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'trace');
const GOLDEN = path.join(FIXTURES, 'golden');

function rel(...parts: string[]): string {
    // Commands record the path as given; keep the repo-relative spelling the
    // goldens were generated with.
    return path.relative(process.cwd(), path.join(FIXTURES, ...parts));
}

function golden(name: string): string {
    return fs.readFileSync(path.join(GOLDEN, name), 'utf-8');
}

function normalize(output: string): string {
    // Containers store the resolved absolute path; the goldens were generated
    // with the repo-relative spelling.
    return output.split(FIXTURES).join('__tests__/fixtures/trace');
}

function addr2linePath(): string | undefined {
    return findPioAddr2linePath(getPioPackagesDir(), 'riscv');
}

const hasAddr2line = addr2linePath() !== undefined;

describe('trace commands parity with upstream esp-riscv-trace', () => {
    jest.setTimeout(120_000);

    test('decode --last 50 on esp32c5 stop', async () => {
        const result = await decodeCapture(rel('esp32c5_stop.esptrace'), {
            elfPath: rel('esp32c5.elf'),
            addr2linePath: addr2linePath(),
            last: 50,
            quiet: true,
            warn: () => undefined,
        });
        expect(normalize(result.lines.join('\n') + '\n')).toBe(golden('decode_c5_last50.txt'));
    });

    test('decode full esp32c6 panic trace', async () => {
        const result = await decodeCapture(rel('esp32c6_panic_stop.esptrace'), {
            elfPath: rel('esp32c6.elf'),
            addr2linePath: addr2linePath(),
            quiet: true,
            warn: () => undefined,
        });
        expect(normalize(result.lines.join('\n') + '\n')).toBe(golden('decode_c6_panic.txt'));
    });

    test('stats on esp32c5 stop', async () => {
        const result = await statsCapture(rel('esp32c5_stop.esptrace'), {
            elfPath: rel('esp32c5.elf'),
            addr2linePath: addr2linePath(),
            quiet: true,
            warn: () => undefined,
        });
        expect(normalize(result.lines.join('\n') + '\n')).toBe(golden('stats_c5.txt'));
    });

    test('stats --per-block on esp32c6 panic', async () => {
        const result = await statsCapture(rel('esp32c6_panic_stop.esptrace'), {
            elfPath: rel('esp32c6.elf'),
            addr2linePath: addr2linePath(),
            perBlock: true,
            quiet: true,
            warn: () => undefined,
        });
        expect(normalize(result.lines.join('\n') + '\n')).toBe(golden('stats_c6_panic_blocks.txt'));
    });

    test('history text on esp32c5 panic', async () => {
        const result = await historyCapture(rel('esp32c5_panic_stop.esptrace'), {
            elfPath: rel('esp32c5.elf'),
            addr2linePath: addr2linePath(),
            quiet: true,
            warn: () => undefined,
        });
        expect(normalize(result.lines.join('\n') + '\n')).toBe(golden('history_c5_panic.txt'));
    });

    test('history --json on esp32c6 stop', async () => {
        const result = await historyCapture(rel('esp32c6_stop.esptrace'), {
            elfPath: rel('esp32c6.elf'),
            addr2linePath: addr2linePath(),
            asJson: true,
            quiet: true,
            warn: () => undefined,
        });
        expect(normalize(result.lines.join('\n') + '\n')).toBe(golden('history_c6_stop.json'));
    });

    test('profile folded on esp32c5 panic', async () => {
        const result = await profileCapture(rel('esp32c5_panic_stop.esptrace'), {
            elfPath: rel('esp32c5.elf'),
            addr2linePath: addr2linePath(),
            quiet: true,
            warn: () => undefined,
        });
        expect(normalize(result.lines.join('\n') + '\n')).toBe(golden('profile_c5_panic_folded.txt'));
    });

    test('profile speedscope on esp32c6 panic', async () => {
        const result = await profileCapture(rel('esp32c6_panic_stop.esptrace'), {
            elfPath: rel('esp32c6.elf'),
            profileFormat: 'speedscope',
            quiet: true,
            warn: () => undefined,
        });
        expect(normalize(result.lines.join('\n') + '\n')).toBe(golden('profile_c6_panic_speedscope.json'));
    });
});
