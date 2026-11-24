import * as path from 'path';
import { formatNote } from '../../src/trace/exporters/note';
import { parseElfCoreFile } from '../../src/trace/elf/core';
import * as abi from '../../src/trace/snapshot/abi';
import { NoteHeader, NoteRecord } from '../../src/trace/snapshot/abi';

const FIXTURE = path.join(__dirname, '../fixtures/trace/esp32s31_coredump.elf');

function makeHeader(overrides: Partial<NoteHeader> = {}): NoteHeader {
    return {
        magic: 0,
        abi_major: 1,
        abi_minor: 0,
        note_header_size: 0,
        note_record_size: 0,
        core_count: 1,
        capture_reason: abi.CaptureReason.PANIC,
        write_seq: 0,
        target_id: 0x20,
        chip_revision: 0,
        app_elf_sha256_size: 0,
        app_elf_sha256: Buffer.alloc(0),
        encoder_params_size: 0,
        encoder_params: undefined,
        ...overrides,
    };
}

function makeRecord(overrides: Partial<NoteRecord> = {}): NoteRecord {
    return {
        core_id: 0,
        state: 0,
        segment_index: 3,
        segment_vaddr: 0x2f0116dc,
        segment_size: 0x1000,
        capacity: 0x1000,
        head_offset: 0xb30,
        memory_mode: abi.MemoryMode.LOOP,
        packet_format: abi.PacketFormat.EFFICIENT_TRACE_2_0,
        address_mode: abi.AddressMode.DELTA,
        resync_mode: abi.ResyncMode.PACKET,
        owner: 0,
        head_valid: 1,
        fifo_empty: 1,
        memory_full: 0,
        fifo_overflow: 0,
        resync_threshold: 128,
        fifo_status_raw: 1,
        intr_status_raw: 0,
        ...overrides,
    };
}

describe('formatNote', () => {
    test('describes header, sha256, and a full segment record', () => {
        const sha = Buffer.from('04a6a7ec10b0c0146d34f1a1a476e020203113f61bd46ed24360c03e70d9f5a9', 'hex');
        const lines = formatNote(
            makeHeader({ app_elf_sha256_size: 32, app_elf_sha256: sha }),
            [makeRecord()]
        );
        expect(lines).toEqual([
            'ABI 1.0, reason PANIC, cores 1',
            'Target 0x0020, chip revision v0.0',
            `App ELF SHA256: ${sha.toString('hex')}`,
            'Core 0: memory LOOP, format ET20, address DELTA',
            '  resync PACKET, threshold 128',
            '  buffer 0x2f0116dc, capacity 0x1000, head 0xb30, segment 3',
            '  hw fifo 0x00000001, intr 0x00000000, empty yes, full no, overflow no',
        ]);
    });

    test('omits the sha line when the hash is all zero', () => {
        const lines = formatNote(makeHeader(), [makeRecord()]);
        expect(lines.some((l) => l.startsWith('App ELF SHA256'))).toBe(false);
    });

    test('no segment prints "no buffer"', () => {
        const lines = formatNote(makeHeader(), [
            makeRecord({ segment_index: abi.NOTE_NO_SEGMENT, head_valid: 0 }),
        ]);
        expect(lines).toContain('  no buffer');
        expect(lines).toContain('  quality: HEAD_INVALID');
    });

    test('invalid head prints "invalid"', () => {
        const lines = formatNote(makeHeader(), [makeRecord({ head_valid: 0 })]);
        expect(lines).toContain('  buffer 0x2f0116dc, capacity 0x1000, head invalid, segment 3');
        expect(lines).toContain('  quality: HEAD_INVALID');
    });

    test('quality flags report memory full, fifo overflow and non-empty fifo', () => {
        const lines = formatNote(makeHeader(), [
            makeRecord({ memory_full: 1, fifo_overflow: 1, fifo_empty: 0 }),
        ]);
        expect(lines).toContain('  hw fifo 0x00000001, intr 0x00000000, empty no, full yes, overflow yes');
        expect(lines).toContain('  quality: MEMORY_FULL, FIFO_OVERFLOW, FIFO_NOT_EMPTY');
    });

    test('unknown enum values fall back to the numeric name', () => {
        const lines = formatNote(makeHeader({ capture_reason: 99, target_id: 0x1234, chip_revision: 105 }), [
            makeRecord({ packet_format: 999, memory_mode: 77, address_mode: 88, resync_mode: 66 }),
        ]);
        expect(lines[0]).toBe('ABI 1.0, reason 99, cores 1');
        expect(lines[1]).toBe('Target 0x1234, chip revision v1.5');
        expect(lines[2]).toBe('Core 0: memory 77, format 999, address 88');
        expect(lines[3]).toBe('  resync 66, threshold 128');
    });

    test('PT10 format name', () => {
        const lines = formatNote(makeHeader(), [
            makeRecord({ packet_format: abi.PacketFormat.PROCESSOR_TRACE_1_0 }),
        ]);
        expect(lines[2]).toContain('format PT10');
    });

    test('real esp32s31 coredump note formats cleanly', () => {
        const elf = parseElfCoreFile(require('fs').readFileSync(FIXTURE));
        const note = elf.notes.find((n) => n.name === abi.NOTE_NAME && n.type === abi.NOTE_TYPE);
        expect(note).toBeDefined();
        const { header, records } = abi.parseNote(note!.desc);
        const lines = formatNote(header, records);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines[0]).toMatch(/^ABI \d+\.\d+, reason \w+, cores \d+$/);
        expect(lines[1]).toMatch(/^Target 0x[0-9a-f]+, chip revision v\d+\.\d+$/);
        for (const record of records) {
            expect(lines.some((l) => l.startsWith(`Core ${record.core_id}:`))).toBe(true);
        }
    });
});
