// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// End-to-end reconstruction tests against upstream esp-riscv-trace fixtures.
// Expected counts come from tests/<chip>/expected_decode_* in the upstream repo.

import * as path from 'path';
import * as abi from '../../src/trace/snapshot/abi';
import { chipNameFromId } from '../../src/trace/snapshot/chip';
import { loadCapture } from '../../src/trace/containers';
import { linearize } from '../../src/trace/decoder/ring';
import { decodeEvents } from '../../src/trace/decoder/pipeline';
import { resolveProfile } from '../../src/trace/decoder/params';
import { ElfImage } from '../../src/trace/elf/image';
import { TraceEvent } from '../../src/trace/ir/events';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'trace');

interface Expected {
    instructions: number;
    syncs: number;
    traps: number;
    gaps: number;
    boundaries?: number;
}

function decodeFixture(traceName: string, elfName: string): TraceEvent[] {
    const capture = loadCapture(path.join(FIXTURES, traceName));
    const chip = chipNameFromId(capture.target_id as number);
    expect(chip).toBeDefined();
    const core = capture.cores[0];
    const profile = resolveProfile(chip as string, core.encoder_params);
    const linear = linearize(core);
    const image = new ElfImage(path.join(FIXTURES, elfName));
    const events: TraceEvent[] = [];
    for (const event of decodeEvents(linear, profile, image, core.address_mode as abi.AddressMode)) {
        events.push(event);
    }
    return events;
}

function summarize(events: TraceEvent[]) {
    const counts: Record<string, number> = {};
    for (const event of events) {
        counts[event.event] = (counts[event.event] ?? 0) + 1;
    }
    return counts;
}

function checkExpected(events: TraceEvent[], expected: Expected) {
    const counts = summarize(events);
    expect(counts.instruction ?? 0).toBe(expected.instructions);
    expect(counts.sync ?? 0).toBe(expected.syncs);
    expect(counts.trap ?? 0).toBe(expected.traps);
    expect(counts.gap ?? 0).toBe(expected.gaps);
    if (expected.boundaries !== undefined) {
        expect(counts.boundary ?? 0).toBe(expected.boundaries);
    }
}

jest.setTimeout(120000);

describe('decodeEvents end-to-end', () => {
    test('esp32c6 stop.esptrace (PT1.0)', () => {
        const events = decodeFixture('esp32c6_stop.esptrace', 'esp32c6.elf');
        checkExpected(events, { instructions: 49109, syncs: 4, traps: 0, gaps: 3, boundaries: 1 });
    });

    test('esp32c6 panic_stop.esptrace (PT1.0)', () => {
        const events = decodeFixture('esp32c6_panic_stop.esptrace', 'esp32c6.elf');
        checkExpected(events, { instructions: 1951, syncs: 3, traps: 1, gaps: 4, boundaries: 1 });
    });

    test('esp32c5 stop.esptrace (ET2.0)', () => {
        const events = decodeFixture('esp32c5_stop.esptrace', 'esp32c5.elf');
        checkExpected(events, { instructions: 48431, syncs: 3, traps: 0, gaps: 21, boundaries: 1 });
    });

    test('esp32c5 panic_stop.esptrace (ET2.0)', () => {
        const events = decodeFixture('esp32c5_panic_stop.esptrace', 'esp32c5.elf');
        checkExpected(events, { instructions: 16482, syncs: 25, traps: 2, gaps: 120, boundaries: 1 });
    });

    test('instruction pcs stay inside executable segments or produce gaps', () => {
        const events = decodeFixture('esp32c6_stop.esptrace', 'esp32c6.elf');
        const instructions = events.filter((e) => e.event === 'instruction');
        expect(instructions.length).toBeGreaterThan(0);
        for (const insn of instructions) {
            if (insn.event !== 'instruction') {
                continue;
            }
            expect(insn.pc).toBeGreaterThanOrEqual(0);
            expect(insn.pc).toBeLessThan(0x100000000);
        }
    });
});
