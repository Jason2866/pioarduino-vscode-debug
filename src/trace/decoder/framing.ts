// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/framing.py (Apache-2.0).

import { LinearizedBuffer, Segment, sliceSegment } from './ring';

export const HEADER_SIZE = 1;
export const INDEX_SIZE = 2;
export const PREFIX_SIZE = HEADER_SIZE + INDEX_SIZE;
export const PACKET_MIN_LEN = 4;
export const PACKET_MAX_LEN = 13;
export const PAYLOAD_MAX_LEN = PACKET_MAX_LEN - PREFIX_SIZE;
export const ANCHOR_ZERO_RUN_BYTES = 14;
export const INDEX_MASK = 0xffff;
export const HEADER_LEN_MASK = 0x1f;
export const HEADER_RESERVED_MASK = 0xe0;

export enum FramingEventKind {
    ANCHOR_FOUND = 'anchor_found',
    NO_ANCHOR = 'no_anchor',
    PRE_ANCHOR_SKIP = 'pre_anchor_skip',
    ALIGNMENT_LOST = 'alignment_lost',
    INDEX_JUMP = 'index_jump',
    FRAMING_ERROR = 'framing_error',
    PARTIAL_FRAME = 'partial_frame',
    PACKET_ERROR = 'packet_error',
    WRAP_BOUNDARY = 'wrap_boundary',
    TRACE_LOST = 'trace_lost',
}

const EVENT_ORDER: Record<FramingEventKind, number> = {
    [FramingEventKind.TRACE_LOST]: 0,
    [FramingEventKind.ANCHOR_FOUND]: 2,
    [FramingEventKind.WRAP_BOUNDARY]: 3,
    [FramingEventKind.NO_ANCHOR]: 4,
    [FramingEventKind.ALIGNMENT_LOST]: 5,
    [FramingEventKind.PRE_ANCHOR_SKIP]: 5,
    [FramingEventKind.INDEX_JUMP]: 6,
    [FramingEventKind.PARTIAL_FRAME]: 7,
    [FramingEventKind.PACKET_ERROR]: 7,
    [FramingEventKind.FRAMING_ERROR]: 7,
};

export interface Frame {
    segment_index: number;
    stream_offset: number;
    length: number;
    packet_index: number;
    payload: Buffer;
}

export interface FramingEvent {
    kind: FramingEventKind;
    segment_index: number;
    stream_offset: number;
    detail: string;
    span: number;
    packet_index: number;
    payload: Buffer | undefined;
}

export interface FramingResult {
    frames: Frame[];
    events: FramingEvent[];
    ring: LinearizedBuffer;
}

function makeEvent(
    kind: FramingEventKind,
    segmentIndex: number,
    streamOffset: number,
    detail: string,
    span = 0,
    packetIndex = -1,
    payload?: Buffer
): FramingEvent {
    return { kind, segment_index: segmentIndex, stream_offset: streamOffset, detail, span, packet_index: packetIndex, payload };
}

/**
 * Walk the linearized stream and return frames plus structural events.
 *
 * Physical wrap is reported separately from an execution gap. Each
 * physical region is framed independently because ESP trace memory does
 * not guarantee that a packet continues across the physical wrap.
 */
export function frame(ring: LinearizedBuffer): FramingResult {
    const frames: Frame[] = [];
    const events: FramingEvent[] = [];

    if (ring.original.fifo_overflow) {
        events.push(
            makeEvent(
                FramingEventKind.TRACE_LOST,
                0,
                0,
                'hardware reported encoder FIFO overflow'
            )
        );
    }

    if (ring.seam !== undefined) {
        events.push(
            makeEvent(
                FramingEventKind.WRAP_BOUNDARY,
                1,
                ring.seam,
                'circular trace memory wraps here'
            )
        );
    }

    let previousIndex: number | undefined;
    let previousEndedCleanly = false;
    ring.segments.forEach((seg, segIdx) => {
        const result = walkSegment(
            segIdx,
            seg,
            sliceSegment(ring, seg),
            frames,
            events,
            previousEndedCleanly ? previousIndex : undefined,
            segIdx > 0 && !previousEndedCleanly
        );
        previousIndex = result.previousIndex;
        previousEndedCleanly = result.endedCleanly;
    });

    events.sort((a, b) => {
        if (a.stream_offset !== b.stream_offset) {
            return a.stream_offset - b.stream_offset;
        }
        return (EVENT_ORDER[a.kind] ?? 9) - (EVENT_ORDER[b.kind] ?? 9);
    });
    return { frames, events, ring };
}

function walkSegment(
    segIdx: number,
    seg: Segment,
    data: Buffer,
    framesOut: Frame[],
    eventsOut: FramingEvent[],
    previousIndex: number | undefined,
    recoveringFromGap: boolean
): { previousIndex: number | undefined; endedCleanly: boolean } {
    const found = findAnchor(data);
    if (found === undefined) {
        eventsOut.push(
            makeEvent(
                FramingEventKind.NO_ANCHOR,
                segIdx,
                seg.start,
                'no anchor found in this physical region',
                seg.length
            )
        );
    }

    // Prefer a fully validated chain starting at the physical region boundary.
    // This is what permits a clean wrap to remain continuous even when the new
    // region contains no anchor. A single plausible header is not sufficient.
    let off: number;
    if (isCompleteFrameChain(data)) {
        off = 0;
    } else if (found !== undefined) {
        const [anchor, tagStart] = found;
        off = anchor;
        if (tagStart !== 0 && !recoveringFromGap) {
            eventsOut.push(
                makeEvent(
                    FramingEventKind.ALIGNMENT_LOST,
                    segIdx,
                    seg.start,
                    `cannot reconstruct ${tagStart} bytes before the first verified packet boundary`,
                    tagStart
                )
            );
            previousIndex = undefined;
        }
    } else if (!recoveringFromGap) {
        eventsOut.push(
            makeEvent(
                FramingEventKind.FRAMING_ERROR,
                segIdx,
                seg.start,
                'cannot establish packet alignment in physical region',
                seg.length
            )
        );
        return { previousIndex: undefined, endedCleanly: false };
    } else {
        // The preceding physical region already reported the discontinuity.
        // Do not count the other fragment of that same boundary break as a
        // second execution gap.
        return { previousIndex: undefined, endedCleanly: false };
    }

    if (found !== undefined) {
        const [anchor, tagStart] = found;
        eventsOut.push(
            makeEvent(
                FramingEventKind.ANCHOR_FOUND,
                segIdx,
                seg.start + anchor,
                `clean packet boundary after ${anchor - tagStart}-byte anchor tag`,
                anchor - tagStart
            )
        );
    }

    const end = data.length;
    while (off < end) {
        if (data[off] === 0) {
            off = skipZeros(data, off);
            continue;
        }

        const header = data[off];
        const plen = header & HEADER_LEN_MASK;
        const reserved = header & HEADER_RESERVED_MASK;

        if (plen < PACKET_MIN_LEN || plen > PACKET_MAX_LEN) {
            eventsOut.push(
                makeEvent(
                    FramingEventKind.FRAMING_ERROR,
                    segIdx,
                    seg.start + off,
                    `invalid packet length ${plen} (expected ${PACKET_MIN_LEN}..${PACKET_MAX_LEN})`,
                    end - off
                )
            );
            return { previousIndex: undefined, endedCleanly: false };
        }
        if (off + plen > end) {
            eventsOut.push(
                makeEvent(
                    FramingEventKind.PARTIAL_FRAME,
                    segIdx,
                    seg.start + off,
                    `frame cannot be reconstructed (${end - off} of ${plen} bytes at physical-region end)`,
                    end - off
                )
            );
            return { previousIndex: undefined, endedCleanly: false };
        }
        if (reserved !== 0) {
            eventsOut.push(
                makeEvent(
                    FramingEventKind.FRAMING_ERROR,
                    segIdx,
                    seg.start + off,
                    `reserved bits set in header 0x${header.toString(16).padStart(2, '0')}`,
                    end - off
                )
            );
            return { previousIndex: undefined, endedCleanly: false };
        }

        const packetIndex = data[off + 1] | (data[off + 2] << 8);
        const payload = Buffer.from(data.subarray(off + PREFIX_SIZE, off + plen));

        if (previousIndex !== undefined) {
            const expected = (previousIndex + 1) & INDEX_MASK;
            if (packetIndex !== expected) {
                const forwardGap = (packetIndex - expected) & INDEX_MASK;
                eventsOut.push(
                    makeEvent(
                        FramingEventKind.INDEX_JUMP,
                        segIdx,
                        seg.start + off,
                        `packet index jump. prev=${previousIndex} got=${packetIndex} expected=${expected} missing_packets=${forwardGap}`
                    )
                );
            }
        }
        previousIndex = packetIndex;

        framesOut.push({
            segment_index: segIdx,
            stream_offset: seg.start + off,
            length: plen,
            packet_index: packetIndex,
            payload,
        });
        off += plen;
    }
    return { previousIndex, endedCleanly: true };
}

function skipZeros(data: Buffer, off: number): number {
    const end = data.length;
    while (off < end && data[off] === 0) {
        off += 1;
    }
    return off;
}

function isCompleteFrameChain(data: Buffer): boolean {
    const end = data.length;
    let off = 0;
    while (off < end) {
        if (data[off] === 0) {
            off = skipZeros(data, off);
            continue;
        }
        const plen = data[off] & HEADER_LEN_MASK;
        const reserved = data[off] & HEADER_RESERVED_MASK;
        if (reserved !== 0 || plen < PACKET_MIN_LEN || plen > PACKET_MAX_LEN || off + plen > end) {
            return false;
        }
        off += plen;
    }
    return true;
}

function findAnchor(data: Buffer): [number, number] | undefined {
    const end = data.length;
    let off = 0;
    while (off < end) {
        if (data[off] !== 0) {
            off += 1;
            continue;
        }
        const tagStart = off;
        off = skipZeros(data, off);
        const zeroRun = off - tagStart;
        if (zeroRun >= ANCHOR_ZERO_RUN_BYTES) {
            if (off >= end) {
                return undefined;
            }
            return [off, tagStart];
        }
    }
    return undefined;
}

