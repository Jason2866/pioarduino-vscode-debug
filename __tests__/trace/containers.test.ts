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

    describe('error paths', () => {
        const fs = require('fs');
        const os = require('os');

        function mutatedEspt(mutate: (data: Buffer) => void): string {
            const data = Buffer.from(fs.readFileSync(fixture('esp32c5_stop.esptrace')));
            mutate(data);
            const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'espt-')), 'cap.esptrace');
            fs.writeFileSync(tmp, data);
            return tmp;
        }

        function recordOffsets(data: Buffer): Array<{ off: number; type: number; end: number }> {
            const hdrSize = data.readUInt16LE(6);
            const records: Array<{ off: number; type: number; end: number }> = [];
            let off = hdrSize;
            while (off + 8 <= data.length) {
                const type = data.readUInt8(off);
                const len = data.readUInt32LE(off + 4);
                records.push({ off, type, end: off + 8 + len });
                off += 8 + len;
            }
            return records;
        }

        it('rejects a bad magic', () => {
            const tmp = mutatedEspt((d) => d.write('XXXX', 0, 'latin1'));
            expect(() => espt.load(tmp)).toThrow(/does not start with the ESPT magic/);
        });

        it('rejects an unsupported version', () => {
            const tmp = mutatedEspt((d) => d.writeUInt16LE(2, 4));
            expect(() => espt.load(tmp)).toThrow(/ESPT version 2/);
        });

        it('rejects an invalid header size', () => {
            const tmp = mutatedEspt((d) => d.writeUInt16LE(4, 6));
            expect(() => espt.load(tmp)).toThrow(/invalid ESPT header size/);
        });

        it('rejects an unknown record type', () => {
            const tmp = mutatedEspt((d) => {
                const recs = recordOffsets(d);
                d.writeUInt8(99, recs[0].off);
            });
            expect(() => espt.load(tmp)).toThrow(/unknown record type 99/);
        });

        it('rejects data after the END record', () => {
            const data = Buffer.from(fs.readFileSync(fixture('esp32c5_stop.esptrace')));
            const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'espt-')), 'cap.esptrace');
            fs.writeFileSync(tmp, Buffer.concat([data, Buffer.alloc(16)]));
            expect(() => espt.load(tmp)).toThrow(/data after the END record/);
        });

        it('rejects a truncated record header', () => {
            const data = fs.readFileSync(fixture('esp32c5_stop.esptrace'));
            const hdrSize = data.readUInt16LE(6);
            const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'espt-')), 'cap.esptrace');
            fs.writeFileSync(tmp, data.subarray(0, hdrSize + 4));
            expect(() => espt.load(tmp)).toThrow(/truncated in a record header/);
        });

        it('rejects a truncated record payload', () => {
            const data = fs.readFileSync(fixture('esp32c5_stop.esptrace'));
            const recs = recordOffsets(data);
            const first = recs[0];
            const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'espt-')), 'cap.esptrace');
            fs.writeFileSync(tmp, data.subarray(0, first.end - 1));
            expect(() => espt.load(tmp)).toThrow(/truncated|no END record/);
        });

        it('rejects a missing END record', () => {
            const data = fs.readFileSync(fixture('esp32c5_stop.esptrace'));
            const recs = recordOffsets(data);
            const end = recs.find((r) => r.type === 3)!;
            const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'espt-')), 'cap.esptrace');
            fs.writeFileSync(tmp, data.subarray(0, end.off));
            expect(() => espt.load(tmp)).toThrow(/no END record/);
        });

        it('rejects an END record with the wrong payload size', () => {
            const tmp = mutatedEspt((d) => {
                const recs = recordOffsets(d);
                const end = recs.find((r) => r.type === 3)!;
                d.writeUInt32LE(0, end.off + 4);
            });
            expect(() => espt.load(tmp)).toThrow(/END record has 0 bytes/);
        });

        it('rejects an unknown END status', () => {
            const tmp = mutatedEspt((d) => {
                const recs = recordOffsets(d);
                const end = recs.find((r) => r.type === 3)!;
                d.writeUInt32LE(99, end.off + 8);
            });
            expect(() => espt.load(tmp)).toThrow(/capture ended with status 99/);
        });
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

    describe('error paths', () => {
        const fs = require('fs');
        const os = require('os');

        function mutatedCoredump(mutate: (data: Buffer) => void): string {
            const data = Buffer.from(fs.readFileSync(fixture('esp32c5_coredump.elf')));
            mutate(data);
            const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coredump-')), 'cap.elf');
            fs.writeFileSync(tmp, data);
            return tmp;
        }

        it('rejects a non-ELF file', () => {
            const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coredump-')), 'cap.bin');
            fs.writeFileSync(tmp, 'not an elf');
            expect(() => coredump.load(tmp)).toThrow(/not a valid ELF/);
        });

        it('rejects an ELF that is not a core file', () => {
            // e_type at offset 16 (u16); ET_CORE is 4, patch to ET_EXEC (2)
            const tmp = mutatedCoredump((d) => d.writeUInt16LE(2, 16));
            expect(() => coredump.load(tmp)).toThrow(/is not a core file/);
        });

        it('rejects a core file without the ESP_RISCV_TRACE note', () => {
            const tmp = mutatedCoredump((d) => {
                const name = Buffer.from('ESP_RISCV_TRACE', 'latin1');
                const idx = d.indexOf(name);
                expect(idx).toBeGreaterThanOrEqual(0);
                d.write('XXXXXXXXXXXXXXX', idx, 'latin1');
            });
            expect(() => coredump.load(tmp)).toThrow(/no ESP_RISCV_TRACE note/);
        });
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
