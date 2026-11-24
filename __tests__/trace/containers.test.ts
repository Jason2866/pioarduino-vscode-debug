import * as path from 'path';
import { loadCapture, espt, coredump, Capture } from '../../src/trace/containers';
import { CHIP_ID_ESP32C5, CHIP_ID_ESP32C6 } from '../../src/trace/snapshot/chip';
import { PacketFormat } from '../../src/trace/snapshot/abi';
import { linearize } from '../../src/trace/decoder/ring';
import { frame } from '../../src/trace/decoder/framing';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'trace');

function fixture(name: string): string {
    return path.join(FIXTURES, name);
}

describe('containers/espt', () => {
    it('sniffs the ESPT magic', () => {
        expect(espt.sniff(Buffer.from('ESPT'))).toBe(true);
        expect(espt.sniff(Buffer.from('NOPE'))).toBe(false);
        expect(espt.sniff(Buffer.alloc(0))).toBe(false);
    });

    it('loads the esp32c5 stop capture', () => {
        const cap = loadCapture(fixture('esp32c5_stop.esptrace'));
        expect(cap.source).toBe('espt');
        expect(cap.target_id).toBe(CHIP_ID_ESP32C5);
        expect(cap.cores.length).toBeGreaterThanOrEqual(1);
        const core = cap.cores[0];
        expect(core.capacity).toBeGreaterThan(0);
        expect(core.head_valid).toBe(true);
        expect(core.packet_format).toBe(PacketFormat.EFFICIENT_TRACE_2_0);
        expect(cap.fifo_emptied).toBeDefined();
    });

    it('loads the esp32c5 panic capture', () => {
        const cap = loadCapture(fixture('esp32c5_panic_stop.esptrace'));
        expect(cap.source).toBe('espt');
        expect(cap.target_id).toBe(CHIP_ID_ESP32C5);
        expect(cap.cores.length).toBeGreaterThanOrEqual(1);
    });

    it('loads the esp32c6 stop capture', () => {
        const cap = loadCapture(fixture('esp32c6_stop.esptrace'));
        expect(cap.source).toBe('espt');
        expect(cap.target_id).toBe(CHIP_ID_ESP32C6);
        expect(cap.cores.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects a truncated ESPT file', () => {
        const data = require('fs').readFileSync(fixture('esp32c5_stop.esptrace'));
        const tmp = path.join(FIXTURES, 'truncated.esptrace');
        require('fs').writeFileSync(tmp, data.subarray(0, data.length - 10));
        try {
            expect(() => loadCapture(tmp)).toThrow(/truncated|END record/);
        } finally {
            require('fs').unlinkSync(tmp);
        }
    });
});

describe('containers/coredump', () => {
    it('sniffs the ELF magic', () => {
        expect(coredump.sniff(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe(true);
        expect(coredump.sniff(Buffer.from('ESPT'))).toBe(false);
    });

    it('loads the esp32c5 coredump', () => {
        const cap = loadCapture(fixture('esp32c5_coredump.elf'));
        expect(cap.source).toBe('coredump');
        expect(cap.target_id).toBe(CHIP_ID_ESP32C5);
        expect(cap.cores.length).toBeGreaterThanOrEqual(1);
        for (const core of cap.cores) {
            expect(core.segment_index).toBeDefined();
            expect(core.capacity).toBe(core.raw.length);
        }
    });

    it('loads the esp32c6 coredump', () => {
        const cap = loadCapture(fixture('esp32c6_coredump.elf'));
        expect(cap.source).toBe('coredump');
        expect(cap.target_id).toBe(CHIP_ID_ESP32C6);
        expect(cap.cores.length).toBeGreaterThanOrEqual(1);
    });
});

describe('decoder ring + framing on real captures', () => {
    const captures: [string, Capture][] = [
        ['esp32c5_stop', loadCapture(fixture('esp32c5_stop.esptrace'))],
        ['esp32c5_panic_stop', loadCapture(fixture('esp32c5_panic_stop.esptrace'))],
        ['esp32c6_stop', loadCapture(fixture('esp32c6_stop.esptrace'))],
        ['esp32c5_coredump', loadCapture(fixture('esp32c5_coredump.elf'))],
        ['esp32c6_coredump', loadCapture(fixture('esp32c6_coredump.elf'))],
    ];

    for (const [name, cap] of captures) {
        it(`linearizes and frames ${name}`, () => {
            for (const core of cap.cores) {
                const ring = linearize(core);
                expect(ring.data.length).toBeGreaterThan(0);
                expect(ring.segments.length).toBeGreaterThanOrEqual(1);
                const result = frame(ring);
                expect(result.frames.length).toBeGreaterThan(0);
                for (const f of result.frames) {
                    expect(f.length).toBeGreaterThanOrEqual(4);
                    expect(f.length).toBeLessThanOrEqual(13);
                    expect(f.payload.length).toBe(f.length - 3);
                }
            }
        });
    }
});
