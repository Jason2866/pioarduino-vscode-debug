import { TraceBuffer } from '../../src/trace/containers/base';
import { inferWrapState, linearize, SegmentKind, WrapInference } from '../../src/trace/decoder/ring';
import {
    ANCHOR_ZERO_RUN_BYTES,
    frame,
    FramingEventKind,
    HEADER_LEN_MASK,
    HEADER_RESERVED_MASK,
    PACKET_MIN_LEN,
    PREFIX_SIZE,
} from '../../src/trace/decoder/framing';
import * as abi from '../../src/trace/snapshot/abi';
import { profilePcFromRaw } from '../../src/trace/decoder/params';

function makeBuffer(opts: {
    raw: number[];
    capacity?: number;
    headOffset?: number;
    memoryMode?: number;
    wrapState?: number;
    headValid?: boolean;
    fifoOverflow?: boolean;
}): TraceBuffer {
    const capacity = opts.capacity ?? opts.raw.length;
    const raw = Buffer.from(opts.raw);
    if (raw.length !== capacity) {
        throw new Error('test buffer length must equal capacity');
    }
    return {
        core_id: 0,
        raw,
        capacity,
        head_offset: opts.headOffset ?? capacity,
        memory_mode: opts.memoryMode ?? abi.MemoryMode.LOOP,
        wrap_state: opts.wrapState ?? abi.WrapState.UNKNOWN,
        packet_format: abi.PacketFormat.EFFICIENT_TRACE_2_0,
        address_mode: abi.AddressMode.DELTA,
        fifo_status_raw: 0,
        intr_status_raw: 0,
        owner: abi.Owner.FW,
        state: abi.State.STOPPED,
        head_valid: opts.headValid ?? true,
        encoder_params: undefined,
        segment_index: undefined,
        resync_mode: abi.ResyncMode.DISABLED,
        resync_threshold: 0,
        fifo_empty: true,
        memory_full: false,
        fifo_overflow: opts.fifoOverflow ?? false,
    };
}

function packet(index: number, payloadBytes: number): number[] {
    const len = PREFIX_SIZE + payloadBytes;
    return [(len & HEADER_LEN_MASK) | (HEADER_RESERVED_MASK & 0), index & 0xff, (index >> 8) & 0xff, ...new Array(payloadBytes).fill(0x5a)];
}

describe('decoder/ring', () => {
    it('linearizes a LINEAR mode buffer up to head_offset', () => {
        const raw = [1, 2, 3, 4, 5, 6];
        const buf = makeBuffer({ raw, headOffset: 4, memoryMode: abi.MemoryMode.LINEAR });
        const ring = linearize(buf);
        expect(ring.data).toEqual(Buffer.from([1, 2, 3, 4]));
        expect(ring.segments).toHaveLength(1);
        expect(ring.segments[0].kind).toBe(SegmentKind.LINEAR);
        expect(ring.seam).toBeUndefined();
        expect(ring.wrap_state).toBe(abi.WrapState.NOT_WRAPPED);
        expect(ring.inference_reason).toBe(WrapInference.LINEAR);
    });

    it('linearizes a LOOP buffer without wrap', () => {
        const raw = [1, 2, 3, 4, 0, 0, 0, 0];
        const buf = makeBuffer({ raw, headOffset: 4 });
        const ring = linearize(buf);
        expect(ring.data).toEqual(Buffer.from([1, 2, 3, 4]));
        expect(ring.segments[0].kind).toBe(SegmentKind.LOOP_NO_WRAP);
        expect(ring.wrap_state).toBe(abi.WrapState.NOT_WRAPPED);
        expect(ring.wrap_state_inferred).toBe(true);
        expect(ring.inference_reason).toBe(WrapInference.CLEAN_TAIL);
    });

    it('infers wrap from a non-zero tail', () => {
        const raw = [1, 2, 3, 4, 9, 0, 0, 0];
        const buf = makeBuffer({ raw, headOffset: 4 });
        const ring = linearize(buf);
        expect(ring.wrap_state).toBe(abi.WrapState.WRAPPED);
        expect(ring.inference_reason).toBe(WrapInference.NONZERO_TAIL);
        // pre-wrap: raw[4:] then post-wrap: raw[:4]
        expect(ring.data).toEqual(Buffer.from([9, 0, 0, 0, 1, 2, 3, 4]));
        expect(ring.segments).toHaveLength(2);
        expect(ring.segments[0].kind).toBe(SegmentKind.LOOP_PRE_WRAP);
        expect(ring.segments[1].kind).toBe(SegmentKind.LOOP_POST_WRAP);
        expect(ring.seam).toBe(4);
    });

    it('treats head_offset == capacity as not wrapped', () => {
        const raw = [1, 2, 3, 4];
        const buf = makeBuffer({ raw, headOffset: 4 });
        const ring = linearize(buf);
        expect(ring.data).toEqual(Buffer.from([1, 2, 3, 4]));
        expect(ring.inference_reason).toBe(WrapInference.HEAD_AT_END);
    });

    it('handles a fully wrapped aligned buffer', () => {
        const raw = [1, 2, 3, 4];
        const buf = makeBuffer({ raw, headOffset: 0 });
        const ring = linearize(buf);
        expect(ring.data).toEqual(Buffer.from([1, 2, 3, 4]));
        expect(ring.segments[0].kind).toBe(SegmentKind.LOOP_WRAP_ALIGNED);
    });

    it('rejects head_valid clear', () => {
        const buf = makeBuffer({ raw: [1, 2], headValid: false });
        expect(() => linearize(buf)).toThrow(/head_valid/);
    });

    it('rejects unsupported memory_mode', () => {
        const buf = makeBuffer({ raw: [1, 2], memoryMode: abi.MemoryMode.UNKNOWN });
        expect(() => linearize(buf)).toThrow(/memory_mode/);
    });

    it('inferWrapState validates inputs', () => {
        expect(() => inferWrapState(Buffer.from([1]), 5, 4)).toThrow(/head_offset/);
        expect(() => inferWrapState(Buffer.from([1, 2]), 0, 4)).toThrow(/capacity/);
    });
});

describe('decoder/framing', () => {
    function framedRing(payload: number[]): ReturnType<typeof linearize> {
        const buf = makeBuffer({ raw: payload, headOffset: payload.length, memoryMode: abi.MemoryMode.LINEAR });
        return linearize(buf);
    }

    it('frames a clean packet chain', () => {
        // anchor: >=14 zero bytes followed by packets
        const zeros = new Array(ANCHOR_ZERO_RUN_BYTES).fill(0);
        const payload = [...zeros, ...packet(0, 4), ...packet(1, 4), ...packet(2, 4)];
        const result = frame(framedRing(payload));
        expect(result.frames).toHaveLength(3);
        expect(result.frames[0].packet_index).toBe(0);
        expect(result.frames[2].packet_index).toBe(2);
        expect(result.events.some((e) => e.kind === FramingEventKind.ANCHOR_FOUND)).toBe(true);
    });

    it('reports index jumps without dropping frames', () => {
        const zeros = new Array(ANCHOR_ZERO_RUN_BYTES).fill(0);
        const payload = [...zeros, ...packet(0, 4), ...packet(5, 4)];
        const result = frame(framedRing(payload));
        expect(result.frames).toHaveLength(2);
        const jump = result.events.find((e) => e.kind === FramingEventKind.INDEX_JUMP);
        expect(jump).toBeDefined();
        expect(jump!.detail).toContain('missing_packets=4');
    });

    it('reports partial frames at region end', () => {
        const zeros = new Array(ANCHOR_ZERO_RUN_BYTES).fill(0);
        const full = packet(0, 4);
        const partial = [PACKET_MIN_LEN & HEADER_LEN_MASK, 1, 0, 0xaa]; // claims len 4, only header+idx+1 payload? actually len=4 => 1 payload byte
        const payload = [...zeros, ...full, ...partial.slice(0, 3)]; // truncated: only 3 of 4 bytes
        const result = frame(framedRing(payload));
        expect(result.frames).toHaveLength(1);
        expect(result.events.some((e) => e.kind === FramingEventKind.PARTIAL_FRAME)).toBe(true);
    });

    it('reports TRACE_LOST on fifo overflow', () => {
        const zeros = new Array(ANCHOR_ZERO_RUN_BYTES).fill(0);
        const payload = [...zeros, ...packet(0, 4)];
        const buf = makeBuffer({
            raw: payload,
            headOffset: payload.length,
            memoryMode: abi.MemoryMode.LINEAR,
            fifoOverflow: true,
        });
        const result = frame(linearize(buf));
        expect(result.events.some((e) => e.kind === FramingEventKind.TRACE_LOST)).toBe(true);
    });

    it('reports NO_ANCHOR and FRAMING_ERROR for garbage', () => {
        const payload = [0x11, 0x22, 0x33]; // no zeros run, invalid length nibble? 0x11&0x1f=17 > 13
        const result = frame(framedRing(payload));
        expect(result.frames).toHaveLength(0);
        expect(result.events.some((e) => e.kind === FramingEventKind.NO_ANCHOR)).toBe(true);
        expect(result.events.some((e) => e.kind === FramingEventKind.FRAMING_ERROR)).toBe(true);
    });

    it('skips interior zero bytes between packets', () => {
        const zeros = new Array(ANCHOR_ZERO_RUN_BYTES).fill(0);
        const payload = [...zeros, ...packet(0, 4), 0, 0, ...packet(1, 4)];
        const result = frame(framedRing(payload));
        expect(result.frames).toHaveLength(2);
        expect(result.frames[1].packet_index).toBe(1);
    });

    it('wrap boundary produces two segments and a WRAP_BOUNDARY event', () => {
        // head=4 with non-zero tail => wrapped; pre region = raw[4:8], post = raw[0:4]
        const postPacket = packet(0, 1); // len = 3+1 = 4 bytes exactly
        const raw = [...postPacket, 0xaa, 0xbb, 0xcc, 0xdd];
        const buf = makeBuffer({ raw, headOffset: 4 });
        const ring = linearize(buf);
        const result = frame(ring);
        expect(result.events.some((e) => e.kind === FramingEventKind.WRAP_BOUNDARY)).toBe(true);
        expect(ring.segments).toHaveLength(2);
    });
});

describe('decoder/params profilePcFromRaw', () => {
    const profile = (iaddress_lsb: number) => ({
        chip: 'test',
        packet_format: abi.PacketFormat.EFFICIENT_TRACE_2_0,
        iaddress_width: 32,
        iaddress_lsb,
        privilege_width: 1,
        ecause_width: 6,
    });

    it('keeps PCs at or above 0x80000000 unsigned', () => {
        // 0x40000000 << 1 = 0x80000000
        expect(profilePcFromRaw(profile(1), 0x40000000)).toBe(0x80000000);
    });

    it('matches the previous result for small shifts', () => {
        expect(profilePcFromRaw(profile(1), 0x12345678)).toBe(0x2468acf0);
        expect(profilePcFromRaw(profile(2), 0x12345678)).toBe(0x48d159e0);
    });

    it('reduces modulo 2^32 for iaddress_lsb >= 32', () => {
        expect(profilePcFromRaw(profile(32), 0x12345678)).toBe(0);
        expect(profilePcFromRaw(profile(40), 0xdeadbeef)).toBe(0);
    });
});
