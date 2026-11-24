// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/decoder/reconstruct.py (Apache-2.0).

import { CodeImage, CodeReadError } from '../elf/image';
import {
    InsnClass,
    Provenance,
    TraceEvent,
    TraceGap,
    TraceInstruction,
    TraceTrap,
} from '../ir/events';
import * as abi from '../snapshot/abi';
import { Frame, FramingEvent, FramingEventKind } from './framing';
import { decodeInsn, DecodedInsn } from './instruction';
import { insnLength } from './encoding';
import {
    Format1NoAddrPacket,
    Format1WithAddrPacket,
    Format2Packet,
    Packet,
    SupportPacket,
    SyncPacket,
    TrapPacket,
    QUAL_STATUS_ENDED_NTR,
    QUAL_STATUS_ENDED_REP,
} from './packets';
import { DecoderProfile } from './params';

export type InputEvent = Packet | FramingEvent;

export enum GapReason {
    FRAMING_ERROR = 'framing_error',
    ALIGNMENT_LOST = 'alignment_lost',
    PACKET_ERROR = 'packet_error',
    PARTIAL_FRAME = 'partial_frame',
    INDEX_JUMP = 'packet_index_jump',
    UNEXPECTED_F0 = 'unexpected_format_0',
    UNEXPECTED_CONTEXT = 'unexpected_context_packet',
    UNEXPECTED_PACKET = 'unexpected_packet',
    TRACE_DISABLED = 'trace_disabled',
    // The encoder filter stopped tracing, the core runs code outside the traced range until the next sync
    UNTRACED = 'untraced',
    TRACE_LOST = 'trace_lost',
    PC_OUT_OF_IMAGE = 'pc_out_of_image',
    DECODE_ERROR = 'decode_error',
    NO_PC = 'walker_not_anchored',
    INFINITE_LOOP = 'infinite_loop',
    // The core went to a reported address without a traced jump, as when a debugger sets the pc
    UNEXPLAINED_JUMP = 'unexplained_jump',
}

const FRAMING_GAPS: Partial<Record<FramingEventKind, GapReason>> = {
    [FramingEventKind.ALIGNMENT_LOST]: GapReason.ALIGNMENT_LOST,
    [FramingEventKind.PRE_ANCHOR_SKIP]: GapReason.ALIGNMENT_LOST,
    [FramingEventKind.INDEX_JUMP]: GapReason.INDEX_JUMP,
    [FramingEventKind.FRAMING_ERROR]: GapReason.FRAMING_ERROR,
    [FramingEventKind.PARTIAL_FRAME]: GapReason.PARTIAL_FRAME,
    [FramingEventKind.PACKET_ERROR]: GapReason.PACKET_ERROR,
    [FramingEventKind.TRACE_LOST]: GapReason.TRACE_LOST,
};

// RISC-V mcause value for an illegal instruction exception
const ECAUSE_ILLEGAL_INSTRUCTION = 2;

// PCs are 32 bits wide; use arithmetic (not bitwise &) so addresses >= 0x80000000 stay unsigned
const PC_MOD = 0x100000000;

function provFromFrame(frame: Frame): Provenance {
    return {
        segment_index: frame.segment_index,
        stream_offset: frame.stream_offset,
        packet_index: frame.packet_index,
        payload: frame.payload,
    };
}

function provFromFramingEvent(event: FramingEvent): Provenance {
    return {
        segment_index: event.segment_index,
        stream_offset: event.stream_offset,
        packet_index: event.packet_index,
        payload: event.payload,
    };
}

function isFramingEvent(event: InputEvent): event is FramingEvent {
    return 'detail' in event;
}

/** Walk ``events`` and yield the recovered trace event stream. */
export function* reconstruct(
    events: Iterable<InputEvent>,
    image: CodeImage,
    profile: DecoderProfile,
    addressMode: abi.AddressMode
): Generator<TraceEvent, void, undefined> {
    const walker = new Walker(image, profile, addressMode);
    for (const event of events) {
        yield* walker.feed(event);
    }
    yield* walker.finish();
}

// Cap instructions followed from one packet to terminate on infinite loops.
const WALK_INSN_LIMIT = 1_000_000;

interface Report {
    pc: number;
    // Position of that instruction in the held instructions, their count when it was not walked
    index: number;
    // Reached without crossing an uninferable discontinuity
    first_occurrence: boolean;
}

interface Parked {
    pc: number;
    provenance: Provenance | undefined;
}

interface DeferredGap {
    pc: number;
    reason: GapReason;
    detail: string;
}

class Walker {
    private pc: number | undefined;
    private lastReportedPc: number | undefined;
    private branchQueue: number[] = [];
    private pendingAddress: number | undefined;
    private inferredReportedPc: number | undefined;
    private replayAddress: number | undefined;
    private stopAfterReportedPc: number | undefined;
    private ambiguousReportedPc: number | undefined;
    private pausedAtReportedPc = false;
    private traceEnabled = true;
    private held: TraceInstruction[] = [];
    private report: Report | undefined;
    private updisconTarget: number | undefined;
    private parked: Parked | undefined;
    private deferredGap: DeferredGap | undefined;
    private spinPc: number | undefined;
    private heldMarkers: TraceEvent[] = [];
    private readonly addrMod: number;
    private configuredMode: abi.AddressMode;
    private effectiveMode: abi.AddressMode;

    constructor(
        private readonly image: CodeImage,
        private readonly profile: DecoderProfile,
        addressMode: abi.AddressMode
    ) {
        // PT 1.0 has no address-mode selector, only full-address encoding.
        this.configuredMode =
            profile.packet_format === abi.PacketFormat.PROCESSOR_TRACE_1_0 ? abi.AddressMode.FULL : addressMode;
        this.effectiveMode = this.configuredMode;
        this.addrMod = 2 ** profile.iaddress_width;
    }

    *finish(): Generator<TraceEvent, void, undefined> {
        yield* this.settle();
    }

    *feed(event: InputEvent): Generator<TraceEvent, void, undefined> {
        if (isFramingEvent(event)) {
            yield* this.feedFraming(event);
            return;
        }
        yield* this.feedPacket(event);
    }

    // ------------------------------------------------------------------
    // Framing event dispatch
    // ------------------------------------------------------------------

    private *feedFraming(event: FramingEvent): Generator<TraceEvent, void, undefined> {
        const kind = event.kind;
        if (kind === FramingEventKind.ANCHOR_FOUND) {
            return;
        }
        const prov = provFromFramingEvent(event);
        if (kind === FramingEventKind.WRAP_BOUNDARY) {
            yield* this.marker({ event: 'boundary', kind: 'wrap', detail: event.detail, provenance: prov });
            return;
        }
        if (kind === FramingEventKind.NO_ANCHOR) {
            yield* this.marker({ event: 'warning', kind: 'no_anchor', detail: event.detail, provenance: prov });
            return;
        }
        yield* this.settle();
        const reason = FRAMING_GAPS[kind];
        if (reason !== undefined) {
            yield this.gap(reason, event.detail, prov);
            return;
        }
        // Unknown framing kinds cannot advance the walker safely
        yield this.gap(GapReason.FRAMING_ERROR, `unknown framing event kind ${JSON.stringify(kind)}`, prov);
    }

    // ------------------------------------------------------------------
    // Packet dispatch
    // ------------------------------------------------------------------

    private *feedPacket(pkt: Packet): Generator<TraceEvent, void, undefined> {
        const prov = provFromFrame(pkt.frame);
        switch (pkt.kind) {
            case 'sync':
                yield* this.onSync(pkt, prov);
                return;
            case 'trap':
                yield* this.onTrap(pkt, prov);
                return;
            case 'support':
                yield* this.onSupport(pkt, prov);
                return;
            case 'format1_with_addr':
                yield* this.onFormat1WithAddr(pkt, prov);
                return;
            case 'format1_no_addr':
                yield* this.onFormat1NoAddr(pkt, prov);
                return;
            case 'format2':
                yield* this.onFormat2(pkt, prov);
                return;
        }
        yield* this.settle();
        if (pkt.kind === 'context') {
            // Context packets are not used on supported chips
            yield this.gap(GapReason.UNEXPECTED_CONTEXT, 'context packet not enabled on this chip', prov);
            return;
        }
        if (pkt.kind === 'format0') {
            // Format 0 packets are not used on supported chips
            yield this.gap(GapReason.UNEXPECTED_F0, 'format 0 packet not enabled on this chip', prov);
            return;
        }
        yield this.gap(GapReason.UNEXPECTED_PACKET, `unknown packet type ${(pkt as Packet).kind}`, prov);
    }

    // ------------------------------------------------------------------
    // Per-packet handlers
    // ------------------------------------------------------------------

    private *onSync(pkt: SyncPacket, prov: Provenance): Generator<TraceEvent, void, undefined> {
        yield* this.rewindToReport();
        yield* this.settle();
        // The sync address is the target of an uninferable jump the walker is waiting at
        const waiting = this.waitingUninferable();
        if (waiting !== undefined) {
            const [waitPc, waitInsn] = waiting;
            yield {
                event: 'instruction',
                pc: waitPc,
                length: waitInsn.length,
                cls: InsnClass.UNINFERABLE,
                branch_taken: undefined,
                next_pc: pkt.pc,
                provenance: prov,
                link: waitInsn.link,
                inferred: false,
            };
        }
        this.traceEnabled = true;
        yield { event: 'sync', pc: pkt.pc, privilege: pkt.privilege, provenance: prov };
        yield* this.resumeAt(pkt.pc, pkt.branch, prov);
    }

    private *onTrap(pkt: TrapPacket, prov: Provenance): Generator<TraceEvent, void, undefined> {
        // Walk as far as possible before handling the trap packet.
        if (this.inferredReportedPc === undefined && !this.pausedAtReportedPc) {
            yield* this.walk(prov);
        } else {
            this.inferredReportedPc = undefined;
            this.pausedAtReportedPc = false;
        }
        const exception = pkt.interrupt === 0;
        const epc = yield* this.resolveTrap(exception);
        this.spinPc = undefined;
        const isPt10 = this.profile.packet_format === abi.PacketFormat.PROCESSOR_TRACE_1_0;
        let handlerPc: number | undefined;
        let interruptedPc: number | undefined;
        if (isPt10) {
            handlerPc = pkt.address_pc;
            // PT 1.0 tval carries the faulting PC on illegal instruction exceptions
            if (exception && pkt.ecause === ECAUSE_ILLEGAL_INSTRUCTION && pkt.tval !== undefined) {
                interruptedPc = pkt.tval % this.addrMod;
            } else {
                interruptedPc = undefined;
            }
        } else if (pkt.thaddr === 1) {
            handlerPc = pkt.address_pc;
            interruptedPc = undefined;
        } else {
            handlerPc = undefined;
            interruptedPc = pkt.address_pc;
        }
        let finalEpc = epc;
        if (interruptedPc !== undefined) {
            if (isPt10 && epc !== undefined && epc !== interruptedPc) {
                yield {
                    event: 'warning',
                    kind: 'epc_mismatch',
                    detail: `reconstructed epc 0x${epc.toString(16).padStart(8, '0')}, tval reports 0x${interruptedPc.toString(16).padStart(8, '0')}`,
                    provenance: prov,
                };
            }
            finalEpc = interruptedPc;
        }
        const anchor = handlerPc !== undefined ? handlerPc : interruptedPc;
        if (anchor !== undefined) {
            this.lastReportedPc = anchor;
        }
        // ecall and ebreak are reported as retired instructions that trap
        if (exception && finalEpc !== undefined) {
            let trapInsn: DecodedInsn | undefined;
            try {
                trapInsn = decodeInsn(finalEpc, this.fetch(finalEpc));
            } catch {
                trapInsn = undefined;
            }
            if (trapInsn !== undefined && trapInsn.cls === InsnClass.TRAP) {
                yield {
                    event: 'instruction',
                    pc: finalEpc,
                    length: trapInsn.length,
                    cls: trapInsn.cls,
                    branch_taken: undefined,
                    next_pc: anchor !== undefined ? anchor : finalEpc,
                    provenance: prov,
                    inferred: false,
                    link: trapInsn.link,
                };
            }
        }
        const trapEvent: TraceTrap = {
            event: 'trap',
            cause: pkt.ecause,
            interrupt: Boolean(pkt.interrupt),
            handler_pc: handlerPc,
            interrupted_pc: interruptedPc,
            tval: pkt.tval,
            provenance: prov,
            epc: finalEpc,
        };
        yield trapEvent;
        if (handlerPc === undefined) {
            // Without a handler address the walker waits for a sync
            this.pc = undefined;
            this.branchQueue = [];
            this.clearReportedAddressState();
            return;
        }
        yield* this.resumeAt(handlerPc, pkt.branch, prov);
    }

    private *onSupport(pkt: SupportPacket, prov: Provenance): Generator<TraceEvent, void, undefined> {
        // A Format 3 packet normally confirms that an ambiguously reached
        // address was an inferred report boundary.
        if (pkt.qual_status !== QUAL_STATUS_ENDED_NTR) {
            yield* this.rewindToReport();
        }
        yield* this.settle();
        if (this.pausedAtReportedPc) {
            this.pausedAtReportedPc = false;
        } else if (this.inferredReportedPc !== undefined) {
            if (pkt.qual_status === QUAL_STATUS_ENDED_NTR) {
                this.replayAddress = this.inferredReportedPc;
                this.inferredReportedPc = undefined;
                yield* this.walk(prov);
            } else {
                this.inferredReportedPc = undefined;
            }
        } else {
            yield* this.walk(prov);
        }
        if (pkt.enable === 0) {
            yield* this.settle();
            this.traceEnabled = false;
            yield this.gap(GapReason.TRACE_DISABLED, `encoder reported disable (qual_status=${pkt.qual_status})`, prov);
            return;
        }
        if (pkt.qual_status === QUAL_STATUS_ENDED_REP || pkt.qual_status === QUAL_STATUS_ENDED_NTR) {
            yield* this.endQualifiedRun(pkt.qual_status, prov);
        }
        // ET 2.0 Support packets can update full address mode.
        this.traceEnabled = true;
        if (
            this.profile.packet_format === abi.PacketFormat.EFFICIENT_TRACE_2_0 &&
            pkt.full_address_mode !== undefined
        ) {
            this.effectiveMode = pkt.full_address_mode ? abi.AddressMode.FULL : abi.AddressMode.DELTA;
        }
    }

    private *endQualifiedRun(qualStatus: number, prov: Provenance): Generator<TraceEvent, void, undefined> {
        yield* this.settle();
        if (this.pc === undefined) {
            return;
        }
        const waiting = this.waitingUninferable();
        if (waiting === undefined) {
            yield this.gap(
                GapReason.UNTRACED,
                `the encoder stopped tracing before 0x${this.pc.toString(16).padStart(8, '0')} (qual_status=${qualStatus})`,
                prov
            );
            return;
        }
        const [waitPc, waitInsn] = waiting;
        yield {
            event: 'instruction',
            pc: waitPc,
            length: waitInsn.length,
            cls: InsnClass.UNINFERABLE,
            branch_taken: undefined,
            next_pc: undefined,
            provenance: prov,
            inferred: false,
            link: waitInsn.link,
        };
        yield this.gap(
            GapReason.UNTRACED,
            `the jump at 0x${waitPc.toString(16).padStart(8, '0')} leaves the traced range (qual_status=${qualStatus})`,
            prov
        );
    }

    private *onFormat1WithAddr(
        pkt: Format1WithAddrPacket,
        prov: Provenance
    ): Generator<TraceEvent, void, undefined> {
        if (pkt.branches) {
            yield* this.settle();
        }
        this.enqueueBranches(pkt.branch_map, pkt.branches);
        const accepted = yield* this.acceptReportedAddress(
            pkt.raw_address,
            pkt.address_width_bits,
            pkt.notify,
            pkt.updiscon,
            'format 1 with address',
            prov
        );
        if (!accepted) {
            return;
        }
        yield* this.walk(prov);
    }

    private *onFormat1NoAddr(pkt: Format1NoAddrPacket, prov: Provenance): Generator<TraceEvent, void, undefined> {
        yield* this.settle();
        this.pausedAtReportedPc = false;
        this.resumeInferredReport();
        // branches == 0 indicates a full 31-bit branch map.
        this.enqueueBranches(pkt.branch_map, 31);
        yield* this.walk(prov);
    }

    private *onFormat2(pkt: Format2Packet, prov: Provenance): Generator<TraceEvent, void, undefined> {
        const accepted = yield* this.acceptReportedAddress(
            pkt.raw_address,
            pkt.address_width_bits,
            pkt.notify,
            pkt.updiscon,
            'format 2',
            prov
        );
        if (!accepted) {
            return;
        }
        yield* this.walk(prov);
    }

    // ------------------------------------------------------------------
    // Walker core
    // ------------------------------------------------------------------

    private *walk(prov: Provenance | undefined): Generator<TraceEvent, void, undefined> {
        let walked = 0;
        while (this.pc !== undefined && this.traceEnabled && this.deferredGap === undefined) {
            const pc = this.pc;
            if (pc === this.spinPc) {
                return;
            }
            const reachedAmbiguousReport = this.ambiguousReportedPc === pc && this.pendingAddress !== undefined;
            const speculative = this.speculating();
            walked += 1;
            if (walked > WALK_INSN_LIMIT) {
                yield* this.flushGap(GapReason.INFINITE_LOOP, `walked ${walked - 1} instructions from one packet at 0x${pc.toString(16).padStart(8, '0')}`);
                return;
            }
            let insn: DecodedInsn;
            try {
                insn = decodeInsn(pc, this.fetch(pc));
            } catch (error) {
                if (error instanceof CodeReadError) {
                    yield* this.fetchFailed(pc, GapReason.PC_OUT_OF_IMAGE, `pc=0x${pc.toString(16).padStart(8, '0')}: ${error.message}`, speculative);
                    return;
                }
                yield* this.fetchFailed(pc, GapReason.DECODE_ERROR, `pc=0x${pc.toString(16).padStart(8, '0')}: ${error instanceof Error ? error.message : String(error)}`, speculative);
                return;
            }

            const cls = insn.cls;
            if (cls === InsnClass.NONE) {
                const nextPc = (pc + insn.length) % PC_MOD;
                yield* this.output(
                    {
                        event: 'instruction',
                        pc,
                        length: insn.length,
                        cls,
                        branch_taken: undefined,
                        next_pc: nextPc,
                        provenance: prov,
                        inferred: true,
                        link: insn.link,
                    },
                    speculative,
                    reachedAmbiguousReport
                );
                this.pc = nextPc;
                if (this.finishReportedInstruction(pc, reachedAmbiguousReport)) {
                    return;
                }
                continue;
            }

            if (cls === InsnClass.JUMP) {
                const target = insn.direct_target;
                if (target === undefined) {
                    yield* this.flushGap(GapReason.DECODE_ERROR, `direct jump at 0x${pc.toString(16).padStart(8, '0')} has no target`);
                    return;
                }
                yield* this.output(
                    {
                        event: 'instruction',
                        pc,
                        length: insn.length,
                        cls,
                        branch_taken: undefined,
                        next_pc: target,
                        provenance: prov,
                        inferred: true,
                        link: insn.link,
                    },
                    speculative,
                    reachedAmbiguousReport
                );
                if (this.finishReportedInstruction(pc, reachedAmbiguousReport)) {
                    this.pc = target;
                    return;
                }
                if (target === pc) {
                    // Direct jump to itself, such as a panic spin loop.
                    this.spinPc = pc;
                    return;
                }
                this.pc = target;
                continue;
            }

            if (cls === InsnClass.BRANCH) {
                if (this.branchQueue.length === 0) {
                    const reported = this.pendingAddress;
                    if (reported === undefined || reported === pc || this.replayAddress !== undefined) {
                        // Wait for the next packet with branch decisions.
                        return;
                    }
                    if (yield* this.jumpToUnreachable(pc, reported, prov)) {
                        continue;
                    }
                    return;
                }
                const bit = this.branchQueue.shift() as number;
                const taken = bit === 0;
                let nextPc: number;
                if (taken) {
                    const target = insn.direct_target;
                    if (target === undefined) {
                        yield* this.flushGap(GapReason.DECODE_ERROR, `taken branch at 0x${pc.toString(16).padStart(8, '0')} has no target`);
                        return;
                    }
                    nextPc = target;
                } else {
                    nextPc = (pc + insn.length) % PC_MOD;
                }
                yield* this.output(
                    {
                        event: 'instruction',
                        pc,
                        length: insn.length,
                        cls,
                        branch_taken: taken,
                        next_pc: nextPc,
                        provenance: prov,
                        inferred: false,
                        link: insn.link,
                    },
                    speculative,
                    reachedAmbiguousReport
                );
                this.pc = nextPc;
                if (this.finishReportedInstruction(pc, reachedAmbiguousReport)) {
                    return;
                }
                continue;
            }

            if (cls === InsnClass.UNINFERABLE) {
                if (reachedAmbiguousReport) {
                    // This instruction is the reported boundary.
                    this.report = { pc, index: this.held.length, first_occurrence: true };
                    this.markInferredReport(pc);
                    return;
                }
                let park = false;
                let reported = false;
                let target: number;
                if (this.replayAddress !== undefined) {
                    target = this.replayAddress;
                    this.replayAddress = undefined;
                } else if (this.pendingAddress !== undefined) {
                    target = this.pendingAddress;
                    this.pendingAddress = undefined;
                    reported = this.ambiguousReportedPc !== undefined;
                    this.ambiguousReportedPc = undefined;
                    park = target === this.updisconTarget;
                } else {
                    // Wait for the next packet with target address.
                    return;
                }
                yield* this.output(
                    {
                        event: 'instruction',
                        pc,
                        length: insn.length,
                        cls,
                        branch_taken: undefined,
                        next_pc: target,
                        provenance: prov,
                        inferred: false,
                        link: insn.link,
                    },
                    speculative,
                    false
                );
                this.pc = target;
                if (park) {
                    this.updisconTarget = undefined;
                    this.stopAfterReportedPc = undefined;
                    this.parked = { pc: target, provenance: prov };
                    this.pausedAtReportedPc = true;
                    return;
                }
                if (reported) {
                    this.report = { pc: target, index: this.held.length, first_occurrence: false };
                }
                if (this.finishReportedInstruction(pc, false)) {
                    return;
                }
                continue;
            }

            // Wait for the trap packet to resolve target PC.
            return;
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private *jumpToUnreachable(
        pc: number,
        target: number,
        prov: Provenance | undefined
    ): Generator<TraceEvent, boolean, undefined> {
        // A packet decides every branch before the address it reports, so the branch at ``pc`` without
        // a decision did not execute. The core went to ``target`` another way.
        const park = target === this.updisconTarget;
        const reported = this.ambiguousReportedPc !== undefined;
        yield* this.releaseHeld();
        yield* this.releaseMarkers();
        yield this.gap(
            GapReason.UNEXPLAINED_JUMP,
            `the core went to the reported 0x${target.toString(16).padStart(8, '0')} before the branch at 0x${pc.toString(16).padStart(8, '0')}, without a traced jump`,
            prov
        );
        this.pc = target;
        this.lastReportedPc = target;
        if (park) {
            this.parked = { pc: target, provenance: prov };
            this.pausedAtReportedPc = true;
            return false;
        }
        if (reported) {
            this.report = { pc: target, index: this.held.length, first_occurrence: false };
        }
        return true;
    }

    private enqueueBranches(branchMap: number, count: number): void {
        for (let i = 0; i < count; i++) {
            this.branchQueue.push((branchMap >> i) & 1);
        }
    }

    private speculating(): boolean {
        return (
            this.pendingAddress === undefined &&
            this.replayAddress === undefined &&
            this.stopAfterReportedPc === undefined &&
            this.branchQueue.length === 0
        );
    }

    private *output(
        insn: TraceInstruction,
        speculative: boolean,
        report: boolean
    ): Generator<TraceEvent, void, undefined> {
        if (report) {
            this.held.push(insn);
            this.report = { pc: insn.pc, index: this.held.length - 1, first_occurrence: true };
        } else if (speculative || this.held.length > 0) {
            this.held.push(insn);
        } else {
            yield insn;
        }
    }

    private *marker(event: TraceEvent): Generator<TraceEvent, void, undefined> {
        if (this.held.length > 0 || this.heldMarkers.length > 0 || this.parked !== undefined || this.deferredGap !== undefined) {
            this.heldMarkers.push(event);
        } else {
            yield event;
        }
    }

    private *releaseHeld(): Generator<TraceEvent, void, undefined> {
        const held = this.held;
        this.held = [];
        yield* held;
    }

    private *releaseMarkers(): Generator<TraceEvent, void, undefined> {
        const markers = this.heldMarkers;
        this.heldMarkers = [];
        yield* markers;
    }

    private *fetchFailed(
        pc: number,
        reason: GapReason,
        detail: string,
        speculative: boolean
    ): Generator<TraceEvent, void, undefined> {
        if (speculative) {
            this.deferredGap = { pc, reason, detail };
            return;
        }
        yield* this.flushGap(reason, detail);
    }

    private *flushGap(reason: GapReason, detail: string): Generator<TraceEvent, void, undefined> {
        yield* this.releaseHeld();
        yield* this.releaseMarkers();
        yield this.gap(reason, detail, undefined);
    }

    private captureReport(pc: number): boolean {
        if (
            this.pc === undefined ||
            this.pausedAtReportedPc ||
            this.inferredReportedPc !== undefined ||
            !this.speculating()
        ) {
            return false;
        }
        const index = this.held.findIndex((insn) => insn.pc === pc);
        let resolvedIndex = index;
        if (resolvedIndex === -1) {
            const deferred = this.deferredGap;
            if (deferred === undefined || deferred.pc !== pc) {
                return false;
            }
            resolvedIndex = this.held.length;
        }
        this.report = { pc, index: resolvedIndex, first_occurrence: true };
        this.inferredReportedPc = pc;
        return true;
    }

    private *settle(): Generator<TraceEvent, void, undefined> {
        // Retire what the walker held for the previous packet, which no trap interrupted.
        this.report = undefined;
        yield* this.releaseHeld();
        const parked = this.parked;
        if (parked !== undefined) {
            this.parked = undefined;
            this.stopAfterReportedPc = parked.pc;
            this.pausedAtReportedPc = false;
            yield* this.walk(parked.provenance);
        }
        const deferred = this.deferredGap;
        if (deferred !== undefined) {
            this.deferredGap = undefined;
            yield this.gap(deferred.reason, deferred.detail, undefined);
        }
        yield* this.releaseMarkers();
    }

    private *rewindToReport(): Generator<TraceEvent, void, undefined> {
        const report = this.report;
        if (report === undefined || !report.first_occurrence || report.index >= this.held.length) {
            return;
        }
        const kept = this.held.slice(0, report.index + 1);
        this.held = [];
        this.report = undefined;
        this.deferredGap = undefined;
        this.pc = kept[kept.length - 1].next_pc;
        yield* kept;
    }

    private *resolveTrap(exception: boolean): Generator<TraceEvent, number | undefined, undefined> {
        const held = this.held;
        const report = this.report;
        const parked = this.parked;
        const deferred = this.deferredGap;
        this.held = [];
        this.report = undefined;
        this.parked = undefined;
        this.deferredGap = undefined;
        let epc: number | undefined;
        let reachedDeferred = true;
        let keep: number;
        if (report !== undefined) {
            if (exception) {
                keep = report.index;
                epc = report.pc;
                reachedDeferred = false;
            } else if (report.index < held.length) {
                keep = report.index + 1;
                epc = held[report.index].next_pc;
                reachedDeferred = false;
            } else {
                keep = held.length;
                epc = undefined;
            }
        } else if (parked !== undefined) {
            keep = held.length;
            epc = parked.pc;
        } else {
            keep = held.length;
            epc = this.pc;
        }
        yield* held.slice(0, keep);
        if (deferred !== undefined && reachedDeferred) {
            yield this.gap(deferred.reason, deferred.detail, undefined);
            epc = undefined;
        }
        yield* this.releaseMarkers();
        return epc;
    }

    private *acceptReportedAddress(
        rawAddress: number,
        widthBits: number,
        notify: number,
        updiscon: number,
        packetName: string,
        prov: Provenance
    ): Generator<TraceEvent, boolean, undefined> {
        // ``notify`` is encoded relative to the transmitted address MSB;
        // ``updiscon`` is encoded relative to ``notify``.
        let resolved = this.resolveAddress(rawAddress, widthBits);
        if (resolved !== undefined) {
            const addressMsb = (rawAddress >> (widthBits - 1)) & 1;
            const plain = notify === addressMsb && updiscon === notify;
            if (plain && this.captureReport(resolved)) {
                this.lastReportedPc = resolved;
                return true;
            }
        }
        yield* this.settle();
        // Settling can end in a gap that drops the delta anchor
        resolved = this.resolveAddress(rawAddress, widthBits);
        if (resolved === undefined) {
            yield this.gap(GapReason.NO_PC, `${packetName} before first sync, cannot anchor`, prov);
            return false;
        }

        // A following non-Format-3 packet resolves the previous ambiguous
        // occurrence in favor of an updiscon target.
        this.pausedAtReportedPc = false;
        this.resumeInferredReport();

        const addressMsb = (rawAddress >> (widthBits - 1)) & 1;
        const isNotification = notify !== addressMsb;
        const endsBeforeFormat3 = updiscon !== notify;

        this.pendingAddress = undefined;
        this.stopAfterReportedPc = undefined;
        this.ambiguousReportedPc = undefined;
        this.updisconTarget = undefined;

        if (isNotification) {
            this.stopAfterReportedPc = resolved;
        } else {
            this.pendingAddress = resolved;
            if (endsBeforeFormat3) {
                this.stopAfterReportedPc = resolved;
                this.updisconTarget = resolved;
            } else {
                this.ambiguousReportedPc = resolved;
            }
        }

        this.lastReportedPc = resolved;
        return true;
    }

    private finishReportedInstruction(pc: number, reachedAmbiguousReport: boolean): boolean {
        if (this.stopAfterReportedPc === pc) {
            this.stopAfterReportedPc = undefined;
            this.ambiguousReportedPc = undefined;
            this.updisconTarget = undefined;
            this.pausedAtReportedPc = true;
            return true;
        }
        if (reachedAmbiguousReport) {
            this.markInferredReport(pc);
            return true;
        }
        return false;
    }

    private markInferredReport(pc: number): void {
        this.pendingAddress = undefined;
        this.ambiguousReportedPc = undefined;
        this.inferredReportedPc = pc;
    }

    private resumeInferredReport(): void {
        if (this.inferredReportedPc !== undefined) {
            this.replayAddress = this.inferredReportedPc;
            this.inferredReportedPc = undefined;
        }
    }

    private resolveAddress(rawAddress: number, widthBits: number): number | undefined {
        if (this.effectiveMode === abi.AddressMode.FULL) {
            return (rawAddress * 2 ** this.profile.iaddress_lsb) % this.addrMod;
        }
        if (this.lastReportedPc === undefined) {
            return undefined;
        }
        if (widthBits <= 0) {
            return this.lastReportedPc;
        }
        const signBit = 2 ** (widthBits - 1);
        const signed = rawAddress >= signBit ? rawAddress - 2 ** widthBits : rawAddress;
        const deltaBytes = signed * 2 ** this.profile.iaddress_lsb;
        return (((this.lastReportedPc + deltaBytes) % this.addrMod) + this.addrMod) % this.addrMod;
    }

    private *resumeAt(pc: number, branch: number, prov: Provenance): Generator<TraceEvent, void, undefined> {
        this.pc = pc;
        this.spinPc = undefined;
        this.lastReportedPc = pc;
        this.branchQueue = [];
        this.clearReportedAddressState();
        let insn: DecodedInsn | undefined;
        try {
            insn = decodeInsn(pc, this.fetch(pc));
        } catch {
            insn = undefined;
        }
        if (insn !== undefined && insn.cls === InsnClass.BRANCH) {
            this.branchQueue.push(branch);
        }
        yield* this.walk(prov);
    }

    private waitingUninferable(): [number, DecodedInsn] | undefined {
        if (this.pc === undefined || !this.traceEnabled || this.pausedAtReportedPc) {
            return undefined;
        }
        let insn: DecodedInsn;
        try {
            insn = decodeInsn(this.pc, this.fetch(this.pc));
        } catch {
            return undefined;
        }
        if (insn.cls !== InsnClass.UNINFERABLE) {
            return undefined;
        }
        return [this.pc, insn];
    }

    private fetch(pc: number): Buffer {
        const firstHw = this.image.read(pc, 2);
        if (insnLength(firstHw[0] | (firstHw[1] << 8)) === 2) {
            return firstHw;
        }
        return this.image.read(pc, 4);
    }

    private gap(reason: GapReason, detail: string, prov: Provenance | undefined): TraceGap {
        this.resetForGap();
        return { event: 'gap', reason, detail, provenance: prov };
    }

    private resetForGap(): void {
        this.pc = undefined;
        this.spinPc = undefined;
        this.lastReportedPc = undefined;
        this.branchQueue = [];
        this.clearReportedAddressState();
    }

    private clearReportedAddressState(): void {
        this.pendingAddress = undefined;
        this.inferredReportedPc = undefined;
        this.replayAddress = undefined;
        this.stopAfterReportedPc = undefined;
        this.ambiguousReportedPc = undefined;
        this.pausedAtReportedPc = false;
        this.report = undefined;
        this.parked = undefined;
        this.updisconTarget = undefined;
        this.deferredGap = undefined;
    }
}

