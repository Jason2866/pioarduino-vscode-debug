// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/ring.py (Apache-2.0).

import { TraceBuffer } from '../containers/base';
import { RingError } from '../errors';
import * as abi from '../snapshot/abi';

export { RingError };

export enum SegmentKind {
    LINEAR = 'linear',
    LOOP_NO_WRAP = 'loop_no_wrap',
    LOOP_WRAP_ALIGNED = 'loop_wrap_aligned',
    LOOP_PRE_WRAP = 'loop_pre_wrap',
    LOOP_POST_WRAP = 'loop_post_wrap',
}

export enum WrapInference {
    LINEAR = 'linear_mode',
    EXPLICIT = 'explicit',
    NONZERO_TAIL = 'nonzero_tail',
    CLEAN_TAIL = 'zero_tail_clean',
    HEAD_AT_END = 'head_at_capacity',
}

export interface Segment {
    /** Offset of this segment in the linearized stream. */
    start: number;
    length: number;
    /** Offset of this segment in the original physical buffer. */
    source_start: number;
    kind: SegmentKind;
}

export interface LinearizedBuffer {
    core_id: number;
    data: Buffer;
    segments: Segment[];
    /** Seam offset between the two physical regions, or undefined for single-segment layouts. */
    seam: number | undefined;
    wrap_state: number;
    wrap_state_inferred: boolean;
    inference_reason: string;
    original: TraceBuffer;
}

export function linearizedSegmentEnd(seg: Segment): number {
    return seg.start + seg.length;
}

export function validateLinearizedBuffer(ring: LinearizedBuffer): void {
    if (ring.wrap_state === abi.WrapState.UNKNOWN) {
        throw new RingError('linearized wrap_state must be resolved, not UNKNOWN');
    }
    if (ring.segments.length === 0) {
        throw new RingError('linearized buffer must have at least one segment');
    }
    const total = ring.segments.reduce((sum, s) => sum + s.length, 0);
    if (total !== ring.data.length) {
        throw new RingError(`segment lengths ${total} do not match data length ${ring.data.length}`);
    }
    let cursor = 0;
    const capacity = ring.original.capacity;
    ring.segments.forEach((s, i) => {
        if (s.length < 0) {
            throw new RingError(`segment ${i} has negative length ${s.length}`);
        }
        if (s.start !== cursor) {
            throw new RingError(`segment ${i} start ${s.start} does not follow the previous end ${cursor}`);
        }
        if (s.source_start < 0 || s.source_start + s.length > capacity) {
            throw new RingError(
                `segment ${i} source range [${s.source_start}, ${s.source_start + s.length}) outside physical buffer [0, ${capacity})`
            );
        }
        const sourceBytes = ring.original.raw.subarray(s.source_start, s.source_start + s.length);
        const dataBytes = ring.data.subarray(s.start, s.start + s.length);
        if (!dataBytes.equals(sourceBytes)) {
            throw new RingError(
                `segment ${i} data does not match physical bytes at [${s.source_start}, ${s.source_start + s.length})`
            );
        }
        cursor = s.start + s.length;
    });
    if (ring.segments.length === 2) {
        if (ring.seam === undefined) {
            throw new RingError('two-segment layout requires a seam offset');
        }
        if (ring.seam !== ring.segments[0].start + ring.segments[0].length) {
            throw new RingError(`seam ${ring.seam} must equal first segment end ${ring.segments[0].start + ring.segments[0].length}`);
        }
    } else if (ring.segments.length === 1) {
        if (ring.seam !== undefined) {
            throw new RingError(`single-segment layout must not have a seam (got ${ring.seam})`);
        }
    } else {
        throw new RingError(`unexpected segment count ${ring.segments.length}, expected 1 or 2`);
    }
}

export function sliceSegment(ring: LinearizedBuffer, seg: Segment): Buffer {
    return ring.data.subarray(seg.start, seg.start + seg.length);
}

/** Mirror ``buffer_has_wrapped``. Return ``(wrap_state, reason)``. */
export function inferWrapState(raw: Buffer, headOffset: number, capacity: number): { wrapState: number; reason: string } {
    if (headOffset < 0 || headOffset > capacity) {
        throw new RingError(`head_offset ${headOffset} outside [0, ${capacity}]`);
    }
    if (raw.length !== capacity) {
        throw new RingError(`buffer length ${raw.length} does not match capacity ${capacity}`);
    }
    if (headOffset >= capacity) {
        return { wrapState: abi.WrapState.NOT_WRAPPED, reason: WrapInference.HEAD_AT_END };
    }
    const tail = raw.subarray(headOffset, capacity);
    if (tail.some((byte) => byte !== 0)) {
        return { wrapState: abi.WrapState.WRAPPED, reason: WrapInference.NONZERO_TAIL };
    }
    return { wrapState: abi.WrapState.NOT_WRAPPED, reason: WrapInference.CLEAN_TAIL };
}

/** Return the chronological bytes and segment layout for one buffer. */
export function linearize(buf: TraceBuffer): LinearizedBuffer {
    if (!buf.head_valid) {
        throw new RingError(`core ${buf.core_id} has head_valid clear, head_offset is a placeholder`);
    }

    const memoryMode = buf.memory_mode;
    if (memoryMode !== abi.MemoryMode.LINEAR && memoryMode !== abi.MemoryMode.LOOP) {
        throw new RingError(`core ${buf.core_id} has unsupported memory_mode ${memoryMode}`);
    }

    const { wrapState, reason, inferred } = resolveWrapState(buf);

    const make = (data: Buffer, segments: Segment[], seam?: number): LinearizedBuffer => {
        const ring: LinearizedBuffer = {
            core_id: buf.core_id,
            data,
            segments,
            seam,
            wrap_state: wrapState,
            wrap_state_inferred: inferred,
            inference_reason: reason,
            original: buf,
        };
        validateLinearizedBuffer(ring);
        return ring;
    };

    const head = buf.head_offset;
    const capacity = buf.capacity;
    if (memoryMode === abi.MemoryMode.LINEAR) {
        return make(buf.raw.subarray(0, head), [
            { start: 0, length: head, source_start: 0, kind: SegmentKind.LINEAR },
        ]);
    }
    if (wrapState === abi.WrapState.NOT_WRAPPED) {
        return make(buf.raw.subarray(0, head), [
            { start: 0, length: head, source_start: 0, kind: SegmentKind.LOOP_NO_WRAP },
        ]);
    }
    if (head === 0 || head === capacity) {
        return make(Buffer.from(buf.raw), [
            { start: 0, length: capacity, source_start: 0, kind: SegmentKind.LOOP_WRAP_ALIGNED },
        ]);
    }

    const preLen = capacity - head;
    const pre: Segment = { start: 0, length: preLen, source_start: head, kind: SegmentKind.LOOP_PRE_WRAP };
    const post: Segment = { start: preLen, length: head, source_start: 0, kind: SegmentKind.LOOP_POST_WRAP };
    return make(Buffer.concat([buf.raw.subarray(head), buf.raw.subarray(0, head)]), [pre, post], preLen);
}

const VALID_WRAP_STATES = [abi.WrapState.UNKNOWN, abi.WrapState.NOT_WRAPPED, abi.WrapState.WRAPPED];

function resolveWrapState(buf: TraceBuffer): { wrapState: number; reason: string; inferred: boolean } {
    if (!VALID_WRAP_STATES.includes(buf.wrap_state)) {
        throw new RingError(`core ${buf.core_id} has unrecognized wrap_state ${buf.wrap_state}`);
    }
    if (buf.memory_mode === abi.MemoryMode.LINEAR) {
        return { wrapState: abi.WrapState.NOT_WRAPPED, reason: WrapInference.LINEAR, inferred: false };
    }
    if (buf.wrap_state === abi.WrapState.WRAPPED) {
        return { wrapState: abi.WrapState.WRAPPED, reason: WrapInference.EXPLICIT, inferred: false };
    }
    if (buf.wrap_state === abi.WrapState.NOT_WRAPPED) {
        return { wrapState: abi.WrapState.NOT_WRAPPED, reason: WrapInference.EXPLICIT, inferred: false };
    }
    const { wrapState, reason } = inferWrapState(buf.raw, buf.head_offset, buf.capacity);
    return { wrapState, reason, inferred: true };
}
