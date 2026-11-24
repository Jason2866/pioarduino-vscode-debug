// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/pipeline.py (Apache-2.0).

import * as abi from '../snapshot/abi';
import { CodeImage } from '../elf/image';
import { TraceEvent } from '../ir/events';
import { Frame, FramingEvent, FramingEventKind, FramingResult, frame } from './framing';
import { Packet, PacketParseError } from './packets';
import { parseEt20 } from './packetsEt20';
import { parsePt10 } from './packetsPt10';
import { DecoderProfile } from './params';
import { InputEvent, reconstruct } from './reconstruct';
import { LinearizedBuffer } from './ring';

export type PacketParser = (frame: Frame, profile: DecoderProfile) => Packet;

/**
 * Frame, parse and reconstruct ``linear`` with the parser for ``profile.packet_format``.
 */
export function* decodeEvents(
    linear: LinearizedBuffer,
    profile: DecoderProfile,
    image: CodeImage,
    addressMode: abi.AddressMode
): Generator<TraceEvent, void, undefined> {
    const parser: PacketParser =
        profile.packet_format === abi.PacketFormat.EFFICIENT_TRACE_2_0 ? parseEt20 : parsePt10;
    const stream = interleave(frame(linear), parser, profile);
    yield* reconstruct(stream, image, profile, addressMode);
}

/**
 * Yield framing events and parsed packets in stream order.
 *
 * A framed packet whose payload cannot be decoded becomes a framing event,
 * so reconstruction state is reset.
 */
export function* interleave(
    result: FramingResult,
    parser: PacketParser,
    profile: DecoderProfile
): Generator<InputEvent, void, undefined> {
    const frameIter = result.frames[Symbol.iterator]();
    let fut = frameIter.next();
    for (const evt of result.events) {
        while (
            !fut.done &&
            (fut.value.segment_index < evt.segment_index ||
                (fut.value.segment_index === evt.segment_index &&
                    fut.value.stream_offset < evt.stream_offset))
        ) {
            yield parseOrError(fut.value, parser, profile);
            fut = frameIter.next();
        }
        yield evt;
    }
    while (!fut.done) {
        yield parseOrError(fut.value, parser, profile);
        fut = frameIter.next();
    }
}

function parseOrError(frame: Frame, parser: PacketParser, profile: DecoderProfile): InputEvent {
    try {
        return parser(frame, profile);
    } catch (exc) {
        if (exc instanceof PacketParseError) {
            return {
                kind: FramingEventKind.PACKET_ERROR,
                segment_index: frame.segment_index,
                stream_offset: frame.stream_offset,
                detail: `cannot decode packet payload: ${exc.message}`,
                span: frame.length,
                packet_index: frame.packet_index,
                payload: frame.payload,
            } as FramingEvent;
        }
        throw exc;
    }
}
