import {
    ABI_MAJOR,
    CaptureReason,
    CORE_COUNT_MAX,
    ENCODER_PARAMS_SIZE,
    MAGIC,
    MemoryMode,
    NOTE_NO_SEGMENT,
    NOTE_RECORD_SIZE,
    NOTE_TYPE,
    PacketFormat,
    SNAPSHOT_DESC_SIZE,
    parseCoreDesc,
    parseEncoderParams,
    parseNote,
    parseSnapshotDesc,
} from '../../src/trace/snapshot/abi';
import { CHIP_ID_ESP32C5, chipNameFromId, isRiscvTraceChip } from '../../src/trace/snapshot/chip';

function snapshotDescBytes(overrides: Partial<Record<string, number>> = {}): Buffer {
    const b = Buffer.alloc(SNAPSHOT_DESC_SIZE);
    b.writeUInt32LE(MAGIC, 0);
    b.writeUInt32LE(2, 4); // write_seq (even)
    b.writeUInt32LE(0x3fc00000, 8); // cores_addr
    b.writeUInt32LE(0, 12); // app_elf_sha256_addr
    b.writeUInt32LE(0, 16); // encoder_params_addr
    b.writeUInt16LE(CHIP_ID_ESP32C5, 20); // target_id
    b.writeUInt16LE(0, 22); // chip_revision
    b.writeUInt8(ABI_MAJOR, 24);
    b.writeUInt8(1, 25); // abi_minor
    b.writeUInt8(SNAPSHOT_DESC_SIZE, 26);
    b.writeUInt8(36, 27); // core_desc_size
    b.writeUInt8(1, 28); // core_count
    b.writeUInt8(CaptureReason.EXPLICIT_STOP, 29);
    b.writeUInt8(0, 30); // app_elf_sha256_size
    b.writeUInt8(0, 31); // encoder_params_size
    for (const [key, value] of Object.entries(overrides)) {
        const offset = SNAPSHOT_DESC_FIELD_OFFSETS[key];
        if (offset === undefined) {
            throw new Error(`unknown override ${key}`);
        }
        if (key === 'write_seq' || key === 'cores_addr' || key === 'app_elf_sha256_addr' || key === 'encoder_params_addr') {
            b.writeUInt32LE(value, offset);
        } else if (key === 'target_id' || key === 'chip_revision') {
            b.writeUInt16LE(value, offset);
        } else {
            b.writeUInt8(value, offset);
        }
    }
    return b;
}

const SNAPSHOT_DESC_FIELD_OFFSETS: Record<string, number> = {
    magic: 0,
    write_seq: 4,
    cores_addr: 8,
    app_elf_sha256_addr: 12,
    encoder_params_addr: 16,
    target_id: 20,
    chip_revision: 22,
    abi_major: 24,
    abi_minor: 25,
    snapshot_desc_size: 26,
    core_desc_size: 27,
    core_count: 28,
    capture_reason: 29,
    app_elf_sha256_size: 30,
    encoder_params_size: 31,
};

function coreDescBytes(overrides: Partial<Record<string, number>> = {}): Buffer {
    const b = Buffer.alloc(36);
    const u32: Record<string, number> = {
        buffer_addr: 0x3fc10000,
        capacity: 256,
        head_offset: 128,
        resync_threshold: 0,
        fifo_status_raw: 0,
        intr_status_raw: 0,
    };
    const u8: Record<string, number> = {
        core_id: 0,
        state: 3,
        memory_mode: MemoryMode.LOOP,
        packet_format: PacketFormat.EFFICIENT_TRACE_2_0,
        address_mode: 1,
        resync_mode: 1,
        owner: 0,
        head_valid: 1,
        fifo_empty: 1,
        memory_full: 0,
        fifo_overflow: 0,
        reserved: 0,
    };
    const u32Offsets: Record<string, number> = {
        buffer_addr: 0,
        capacity: 4,
        head_offset: 8,
        resync_threshold: 12,
        fifo_status_raw: 16,
        intr_status_raw: 20,
    };
    const u8Order = [
        'core_id',
        'state',
        'memory_mode',
        'packet_format',
        'address_mode',
        'resync_mode',
        'owner',
        'head_valid',
        'fifo_empty',
        'memory_full',
        'fifo_overflow',
        'reserved',
    ];
    for (const [key, value] of Object.entries(u32)) {
        b.writeUInt32LE(value, u32Offsets[key]);
    }
    u8Order.forEach((key, i) => b.writeUInt8(u8[key], 24 + i));
    for (const [key, value] of Object.entries(overrides)) {
        if (key in u32Offsets) {
            b.writeUInt32LE(value, u32Offsets[key]);
        } else {
            b.writeUInt8(value, 24 + u8Order.indexOf(key));
        }
    }
    return b;
}

describe('snapshot/abi', () => {
    it('parses a valid snapshot descriptor', () => {
        const desc = parseSnapshotDesc(snapshotDescBytes());
        expect(desc.magic).toBe(MAGIC);
        expect(desc.abi_major).toBe(ABI_MAJOR);
        expect(desc.core_count).toBe(1);
        expect(desc.target_id).toBe(CHIP_ID_ESP32C5);
        expect(desc.capture_reason).toBe(CaptureReason.EXPLICIT_STOP);
    });

    it('rejects a bad magic', () => {
        expect(() => parseSnapshotDesc(snapshotDescBytes({ magic: 0 }))).toThrow(/bad magic/);
    });

    it('rejects an odd write_seq', () => {
        expect(() => parseSnapshotDesc(snapshotDescBytes({ write_seq: 3 }))).toThrow(/mid-update/);
    });

    it('rejects an out-of-range core_count', () => {
        expect(() => parseSnapshotDesc(snapshotDescBytes({ core_count: CORE_COUNT_MAX + 1 }))).toThrow(
            /core_count/
        );
        expect(() => parseSnapshotDesc(snapshotDescBytes({ core_count: 0 }))).toThrow(/core_count/);
    });

    it('parses a valid core descriptor', () => {
        const desc = parseCoreDesc(coreDescBytes());
        expect(desc.core_id).toBe(0);
        expect(desc.capacity).toBe(256);
        expect(desc.head_offset).toBe(128);
        expect(desc.head_valid).toBe(1);
        expect(desc.packet_format).toBe(PacketFormat.EFFICIENT_TRACE_2_0);
    });

    it('rejects head_offset beyond capacity', () => {
        expect(() => parseCoreDesc(coreDescBytes({ head_offset: 300 }))).toThrow(/exceeds capacity/);
    });

    it('rejects flag values other than 0 or 1', () => {
        expect(() => parseCoreDesc(coreDescBytes({ head_valid: 2 }))).toThrow(/head_valid/);
    });

    it('parses encoder params', () => {
        const b = Buffer.alloc(ENCODER_PARAMS_SIZE);
        b.writeUInt8(1, 0);
        b.writeUInt8(ENCODER_PARAMS_SIZE, 1);
        const params = parseEncoderParams(b);
        expect(params.params_version).toBe(1);
        expect(params.params_size).toBe(ENCODER_PARAMS_SIZE);
        expect(params.arch_p).toBe(0);
    });

    it('rejects bad encoder params version', () => {
        const b = Buffer.alloc(ENCODER_PARAMS_SIZE);
        b.writeUInt8(2, 0);
        b.writeUInt8(ENCODER_PARAMS_SIZE, 1);
        expect(() => parseEncoderParams(b)).toThrow(/params_version/);
    });

    it('parses a note header and records', () => {
        const body = Buffer.alloc(80 + NOTE_RECORD_SIZE);
        body.writeUInt32LE(MAGIC, 0);
        body.writeUInt32LE(4, 4);
        body.writeUInt16LE(CHIP_ID_ESP32C5, 8);
        body.writeUInt16LE(0, 10);
        body.writeUInt8(ABI_MAJOR, 12);
        body.writeUInt8(1, 13);
        body.writeUInt8(80, 14);
        body.writeUInt8(NOTE_RECORD_SIZE, 15);
        body.writeUInt8(1, 16);
        body.writeUInt8(CaptureReason.PANIC, 17);
        body.writeUInt8(0, 18);
        body.writeUInt8(0, 19);
        const rec = body.subarray(80);
        rec.writeUInt8(0, 0); // core_id
        rec.writeUInt8(3, 1); // state
        rec.writeUInt8(MemoryMode.LOOP, 2);
        rec.writeUInt8(PacketFormat.EFFICIENT_TRACE_2_0, 3);
        rec.writeUInt8(1, 4);
        rec.writeUInt8(1, 5);
        rec.writeUInt8(0, 6);
        rec.writeUInt8(0, 7); // head_valid
        rec.writeUInt8(1, 8); // fifo_empty
        rec.writeUInt8(0, 9);
        rec.writeUInt8(0, 10);
        rec.writeUInt8(0, 11);
        rec.writeUInt32LE(NOTE_NO_SEGMENT, 12);
        const { header, records } = parseNote(body);
        expect(header.core_count).toBe(1);
        expect(header.capture_reason).toBe(CaptureReason.PANIC);
        expect(records).toHaveLength(1);
        expect(records[0].segment_index).toBe(NOTE_NO_SEGMENT);
        expect(records[0].head_valid).toBe(0);
        expect(NOTE_TYPE).toBe(680);
    });
});

describe('snapshot/chip', () => {
    it('maps chip ids to names', () => {
        expect(chipNameFromId(CHIP_ID_ESP32C5)).toBe('esp32c5');
        expect(chipNameFromId(0xffff)).toBeUndefined();
    });

    it('identifies supported trace chips', () => {
        expect(isRiscvTraceChip('esp32c5')).toBe(true);
        expect(isRiscvTraceChip('ESP32-C6')).toBe(false); // names are not normalized for dashes
        expect(isRiscvTraceChip(0x000d)).toBe(true); // esp32c6
        expect(isRiscvTraceChip(0x0005)).toBe(false); // esp32c3 has no trace encoder
        expect(isRiscvTraceChip('esp32c3')).toBe(false);
    });
});
