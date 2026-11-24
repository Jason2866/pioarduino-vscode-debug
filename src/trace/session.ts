// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/session.py (Apache-2.0), reduced to the
// parts that do not need DWARF/source resolution or the capture-note header.

import * as fs from 'fs';
import * as path from 'path';
import * as abi from './snapshot/abi';
import { chipNameFromId, isRiscvTraceChip } from './snapshot/chip';
import { Capture, TraceBuffer, loadCapture } from './containers';
import { TraceError } from './errors';
import { CodeImage, ElfImage, ElfImageError } from './elf/image';
import { LinearizedBuffer, linearize } from './decoder/ring';
import { DecoderProfile, resolveProfile } from './decoder/params';
import { TraceEvent } from './ir/events';
import { decodeEvents } from './decoder/pipeline';
import { ElfShaStatus, TraceCaptureNote, compareElfSha } from './ir/capture_note';
import { SourceResolver } from './elf/resolver';
import { shortSha } from './exporters/_format';

export class UsageError extends TraceError {}

export class ShaMismatch extends TraceError {
    constructor(
        readonly coreId: number,
        readonly snapshotSha: Buffer | undefined,
        readonly elfSha: Buffer | undefined,
        readonly source?: string
    ) {
        const where = source !== undefined ? ` of ${source}` : '';
        super(
            `ELF SHA-256 mismatch for core ${coreId}${where}. ` +
                `snapshot=${shortSha(snapshotSha)} elf=${shortSha(elfSha)}`
        );
    }
}

export type WarnSink = (message: string) => void;

const defaultWarn: WarnSink = (message) => {
    // eslint-disable-next-line no-console
    console.warn(`[esp-riscv-trace] ${message}`);
};

class StallImage implements CodeImage {
    /** Code image used without an ELF: every read returns `C.JR ra`, an uninferable instruction. */
    private static readonly INSN = Buffer.from([0x82, 0x80]);

    read(_vaddr: number, size: number): Buffer {
        const count = Math.ceil(size / 2);
        return Buffer.concat(Array.from({ length: count }, () => StallImage.INSN)).subarray(0, size);
    }

    symbolAt(_vaddr: number): string | undefined {
        return undefined;
    }
}

export interface Session {
    cap: Capture;
    chip: string;
    elf: ElfImage | undefined;
    image: CodeImage;
    resolver: SourceResolver | undefined;
    forceElf: boolean;
    romElfPath?: string;
    romElfStatus?: string;
}

export interface SessionOptions {
    elfPath?: string;
    chip?: string;
    forceElf?: boolean;
    requireElf?: boolean;
    warn?: WarnSink;
}

export class CoreView {
    constructor(
        readonly session: Session,
        readonly core: TraceBuffer,
        readonly profile: DecoderProfile,
        readonly linear: LinearizedBuffer,
        readonly note: TraceCaptureNote
    ) {}

    /** Yield the reconstructed events of this core. */
    events(): Generator<TraceEvent, void, undefined> {
        const addressMode = this.core.address_mode as abi.AddressMode;
        return decodeEvents(this.linear, this.profile, this.session.image, addressMode);
    }
}

function loadCaptureChecked(filePath: string, warn: WarnSink): Capture {
    const cap = loadCapture(filePath);
    if (cap.fifo_emptied === false) {
        warn('the encoder FIFO did not empty at stop, the end of the trace may be missing');
    }
    if (cap.abi_minor > abi.ABI_MINOR) {
        warn(
            `capture uses snapshot ABI ${cap.abi_major}.${cap.abi_minor}, this decoder supports ` +
                `${abi.ABI_MAJOR}.${abi.ABI_MINOR}. Newer fields are ignored, update esp-riscv-trace`
        );
    }
    return cap;
}

function resolveChip(chip: string | undefined, cap: Capture, warn: WarnSink): string {
    const recorded = cap.target_id !== undefined ? chipNameFromId(cap.target_id) : undefined;
    if (chip === undefined) {
        if (recorded === undefined) {
            throw new UsageError(
                'chip is not known. Pass chip or use a container that records target_id.'
            );
        }
        return recorded;
    }
    const name = chip.trim().toLowerCase();
    if (!isRiscvTraceChip(name)) {
        throw new UsageError(`chip ${JSON.stringify(chip)} has no supported trace encoder`);
    }
    if (recorded !== undefined && name !== recorded) {
        warn(`chip ${name} overrides the chip recorded in the capture (${recorded})`);
    }
    return name;
}

/** Check the options, load `capturePath` and its ELF, and return the session. */
export function openSession(capturePath: string, options: SessionOptions = {}): Session {
    const warn = options.warn ?? defaultWarn;
    const resolved = path.resolve(capturePath);
    if (!fs.existsSync(resolved)) {
        throw new UsageError(`capture not found: ${resolved}`);
    }
    if (options.requireElf && options.elfPath === undefined) {
        throw new UsageError('an ELF path is required for this operation');
    }
    if (options.elfPath !== undefined && !fs.existsSync(options.elfPath)) {
        throw new UsageError(`ELF not found: ${options.elfPath}`);
    }

    // Keep the caller's spelling so the capture note's `source` matches upstream
    const cap = loadCaptureChecked(capturePath, warn);
    const chip = resolveChip(options.chip, cap, warn);

    let elf: ElfImage | undefined;
    let image: CodeImage = new StallImage();
    if (options.elfPath !== undefined) {
        try {
            elf = new ElfImage(options.elfPath);
        } catch (error) {
            if (error instanceof ElfImageError) {
                throw new UsageError(error.message);
            }
            throw error;
        }
        image = elf;
    }
    return {
        cap,
        chip,
        elf,
        image,
        resolver: undefined,
        forceElf: options.forceElf ?? false,
    };
}

/** Describe the capture, the core and the ELF check for the output header. */
export function buildCaptureNote(
    session: Session,
    core: TraceBuffer,
    profile: DecoderProfile,
    linear?: LinearizedBuffer
): TraceCaptureNote {
    const capture = session.cap;
    const snapshotSha = capture.app_elf_sha256;
    let elfSha: Buffer | undefined;
    let elfPath: string | undefined;
    if (session.elf !== undefined) {
        elfSha = session.elf.sha256();
        elfPath = session.elf.path;
    }
    // The containers keep only a full digest, so this compares all of it
    const recorded = snapshotSha ?? Buffer.alloc(0);
    const status = compareElfSha(recorded, recorded.length, elfSha);
    const [wrapState, wrapReason] = wrapStateView(core.wrap_state, linear);
    return {
        source: capture.source_path,
        chip: session.chip,
        core_id: core.core_id,
        packet_format: abi.enumName(abi.PacketFormat, profile.packet_format),
        address_mode: abi.enumName(abi.AddressMode, core.address_mode),
        memory_mode: abi.enumName(abi.MemoryMode, core.memory_mode),
        resync_mode: abi.enumName(abi.ResyncMode, core.resync_mode),
        resync_threshold: core.resync_threshold,
        wrap_state: wrapState,
        capacity: core.capacity,
        head_offset: core.head_offset,
        fifo_status_raw: core.fifo_status_raw,
        intr_status_raw: core.intr_status_raw,
        fifo_empty: core.fifo_empty,
        memory_full: core.memory_full,
        fifo_overflow: core.fifo_overflow,
        capture_reason: abi.enumName(abi.CaptureReason, capture.capture_reason),
        owner: abi.enumName(abi.Owner, core.owner),
        target_id: capture.target_id,
        chip_revision: capture.chip_revision,
        snapshot_app_elf_sha256: snapshotSha,
        elf_path: elfPath,
        elf_sha256: elfSha,
        elf_sha_status: status,
        wrap_reason: wrapReason,
        rom_elf_path: session.romElfPath,
        rom_elf_status: session.romElfStatus,
        fifo_emptied: capture.fifo_emptied,
        abi_major: capture.abi_major,
        abi_minor: capture.abi_minor,
    };
}

/** Return the wrap state shown in the header and the reason when it was inferred. */
function wrapStateView(rawWrapState: number, linear: LinearizedBuffer | undefined): [string, string | undefined] {
    const rawName = abi.enumName(abi.WrapState, rawWrapState);
    if (rawWrapState !== abi.WrapState.UNKNOWN || linear === undefined) {
        return [rawName, undefined];
    }
    if (!linear.wrap_state_inferred) {
        return [abi.enumName(abi.WrapState, linear.wrap_state), undefined];
    }
    if (linear.wrap_state === abi.WrapState.WRAPPED) {
        return ['inferred_wrapped', linear.inference_reason];
    }
    if (linear.wrap_state === abi.WrapState.NOT_WRAPPED) {
        return ['inferred_not_wrapped', linear.inference_reason];
    }
    return [rawName, undefined];
}

/** Yield one view per selected core in container order, raising `ShaMismatch` unless forced. */
export function* iterCores(session: Session, coreFilter?: number): Generator<CoreView, void, undefined> {
    for (const core of session.cap.cores) {
        if (coreFilter !== undefined && core.core_id !== coreFilter) {
            continue;
        }
        const profile = resolveProfile(session.chip, core.encoder_params);
        if (core.packet_format !== profile.packet_format) {
            throw new UsageError(
                `core ${core.core_id} declares packet format ` +
                    `${abi.enumName(abi.PacketFormat, core.packet_format)} ` +
                    `but chip ${session.chip} decodes as ` +
                    `${abi.enumName(abi.PacketFormat, profile.packet_format)}`
            );
        }
        const linear = linearize(core);
        const note = buildCaptureNote(session, core, profile, linear);
        if (!session.forceElf && note.elf_sha_status === ElfShaStatus.MISMATCH) {
            throw new ShaMismatch(
                core.core_id,
                note.snapshot_app_elf_sha256,
                note.elf_sha256,
                session.cap.source_path
            );
        }
        yield new CoreView(session, core, profile, linear, note);
    }
}
