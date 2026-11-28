// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0

import * as path from 'path';
import { openSession, iterCores, UsageError } from '../../src/trace/session';
import { TraceEvent } from '../../src/trace/ir/events';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'trace');

jest.setTimeout(120000);

function collectEvents(traceName: string, elfName?: string, coreFilter?: number): TraceEvent[] {
    const session = openSession(path.join(FIXTURES, traceName), {
        elfPath: elfName ? path.join(FIXTURES, elfName) : undefined,
        warn: () => undefined,
    });
    const events: TraceEvent[] = [];
    for (const view of iterCores(session, coreFilter)) {
        for (const event of view.events()) {
            events.push(event);
        }
    }
    return events;
}

describe('session', () => {
    test('openSession resolves chip from target_id and decodes with the app ELF', () => {
        const events = collectEvents('esp32c6_stop.esptrace', 'esp32c6.elf');
        const counts: Record<string, number> = {};
        for (const event of events) {
            counts[event.event] = (counts[event.event] ?? 0) + 1;
        }
        expect(counts.instruction).toBe(49109);
        expect(counts.sync).toBe(4);
        expect(counts.gap).toBe(3);
    });

    test('decodes without an ELF using the stall image', () => {
        const events = collectEvents('esp32c6_stop.esptrace');
        // Every fetch returns c.jr ra (uninferable), so the walker only advances on packet addresses
        expect(events.length).toBeGreaterThan(0);
        expect(events.some((e) => e.event === 'sync')).toBe(true);
    });

    test('core filter selects a single core', () => {
        const all = collectEvents('esp32c6_stop.esptrace', 'esp32c6.elf');
        const core0 = collectEvents('esp32c6_stop.esptrace', 'esp32c6.elf', 0);
        expect(core0.length).toBe(all.length);
    });

    test('rejects a missing capture', () => {
        expect(() => openSession(path.join(FIXTURES, 'does-not-exist.esptrace'))).toThrow(UsageError);
    });

    test('rejects a missing ELF', () => {
        expect(() =>
            openSession(path.join(FIXTURES, 'esp32c6_stop.esptrace'), {
                elfPath: path.join(FIXTURES, 'missing.elf'),
            })
        ).toThrow(UsageError);
    });

    test('rejects an unsupported chip override', () => {
        expect(() =>
            openSession(path.join(FIXTURES, 'esp32c6_stop.esptrace'), { chip: 'esp32' })
        ).toThrow(UsageError);
    });
});
