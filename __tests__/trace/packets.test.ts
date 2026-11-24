import * as path from 'path';
import { loadCapture } from '../../src/trace/containers';
import { linearize } from '../../src/trace/decoder/ring';
import { frame, Frame } from '../../src/trace/decoder/framing';
import { defaultProfile, resolveProfile, DecoderProfile } from '../../src/trace/decoder/params';
import { parsePacket, Packet, PacketParseError, BitReader, branchMapWidth } from '../../src/trace/decoder/packets';
import { parseEt20 } from '../../src/trace/decoder/packetsEt20';
import { parsePt10 } from '../../src/trace/decoder/packetsPt10';
import * as abi from '../../src/trace/snapshot/abi';
import { chipNameFromId } from '../../src/trace/snapshot/chip';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'trace');

function parserFor(profile: DecoderProfile) {
    return profile.packet_format === abi.PacketFormat.EFFICIENT_TRACE_2_0 ? parseEt20 : parsePt10;
}

describe('decoder/packets BitReader', () => {
    it('reads LSB-first fields', () => {
        const reader = new BitReader(Buffer.from([0b10110011, 0b01010101]));
        expect(reader.read(2)).toBe(0b11);
        expect(reader.read(3)).toBe(0b100);
        expect(reader.read(8)).toBe(0b10101101);
        expect(reader.remaining()).toBe(3);
    });

    it('rejects reads past the end', () => {
        const reader = new BitReader(Buffer.from([0]));
        expect(() => reader.read(9)).toThrow(PacketParseError);
    });

    it('handles payloads wider than 53 bits', () => {
        const reader = new BitReader(Buffer.alloc(10, 0xff));
        expect(reader.totalBits).toBe(80);
        expect(reader.read(32)).toBe(0xffffffff);
        expect(reader.read(32)).toBe(0xffffffff);
        expect(reader.read(16)).toBe(0xffff);
    });

    it('computes branch map widths', () => {
        expect(branchMapWidth(1)).toBe(1);
        expect(branchMapWidth(2)).toBe(3);
        expect(branchMapWidth(3)).toBe(3);
        expect(branchMapWidth(4)).toBe(7);
        expect(branchMapWidth(31)).toBe(31);
        expect(() => branchMapWidth(0)).toThrow(PacketParseError);
        expect(() => branchMapWidth(32)).toThrow(PacketParseError);
    });
});

describe('packet parsing on real captures', () => {
    const cases: [string, string][] = [
        ['esp32c5_stop.esptrace', 'esp32c5'],
        ['esp32c5_panic_stop.esptrace', 'esp32c5'],
        ['esp32c6_stop.esptrace', 'esp32c6'],
        ['esp32c5_coredump.elf', 'esp32c5'],
        ['esp32c6_coredump.elf', 'esp32c6'],
    ];

    for (const [file, chip] of cases) {
        it(`parses packets from ${file}`, () => {
            const cap = loadCapture(path.join(FIXTURES, file));
            const profile = defaultProfile(chip);
            const parser = parserFor(profile);
            let parsed = 0;
            let errors = 0;
            const kinds = new Set<string>();
            for (const core of cap.cores) {
                const effectiveProfile = resolveProfile(chip, core.encoder_params);
                const effectiveParser = parserFor(effectiveProfile);
                const ring = linearize(core);
                const result = frame(ring);
                for (const f of result.frames) {
                    try {
                        const pkt = effectiveParser(f, effectiveProfile);
                        kinds.add(pkt.kind);
                        parsed++;
                    } catch (error) {
                        if (!(error instanceof PacketParseError)) {
                            throw error;
                        }
                        errors++;
                    }
                }
            }
            // Every real capture should produce mostly decodable packets.
            expect(parsed).toBeGreaterThan(0);
            expect(errors).toBeLessThan(parsed);
        });
    }
});

describe('packet format dispatch', () => {
    it('uses ET2.0 for esp32c5 and PT1.0 for esp32c6', () => {
        expect(defaultProfile('esp32c5').packet_format).toBe(abi.PacketFormat.EFFICIENT_TRACE_2_0);
        expect(defaultProfile('esp32c6').packet_format).toBe(abi.PacketFormat.PROCESSOR_TRACE_1_0);
    });

    it('parses a format-0 packet', () => {
        const f: Frame = {
            segment_index: 0,
            stream_offset: 0,
            length: 4,
            packet_index: 0,
            payload: Buffer.from([0x00, 0x00, 0x00]),
        };
        const pkt = parsePacket(f, defaultProfile('esp32c5'), {
            trap: () => {
                throw new Error('unreachable');
            },
            support: () => {
                throw new Error('unreachable');
            },
            f2: () => {
                throw new Error('unreachable');
            },
            f1_with_addr: () => {
                throw new Error('unreachable');
            },
        });
        expect(pkt.kind).toBe('format0');
    });

    it('chip names resolve from target ids', () => {
        expect(chipNameFromId(0x17)).toBe('esp32c5');
        expect(chipNameFromId(0x0d)).toBe('esp32c6');
    });
});
