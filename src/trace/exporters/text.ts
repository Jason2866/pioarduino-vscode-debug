// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/exporters/text.py (Apache-2.0).
// Text exporter for decoded trace events.

import { TraceDiagnostic } from '../analysis/diagnostics';
import { PAYLOAD_MAX_LEN } from '../decoder/framing';
import { CodeImage } from '../elf/image';
import { SourceResolver } from '../elf/resolver';
import { ElfShaStatus, TraceCaptureNote } from '../ir/capture_note';
import {
    InsnClass,
    Provenance,
    TraceBoundary,
    TraceEvent,
    TraceGap,
    TraceInstruction,
    TraceSync,
    TraceTrap,
    TraceWarning,
} from '../ir/events';
import { ABI_MAJOR, ABI_MINOR } from '../snapshot/abi';
import { FUNCTION_COLUMN_WIDTH, marker, oneLine, oneLineQuoted, shortSha } from './_format';

// Debug hex column fits the largest framed payload
const PAYLOAD_HEX_WIDTH = PAYLOAD_MAX_LEN * 3 - 1;

export function formatNote(note: TraceCaptureNote, command = 'decode'): string[] {
    /** Return the header lines to write before the event stream. */
    const lines: string[] = [];
    lines.push(`# esp-riscv-trace ${command}`);
    lines.push(`# source            ${oneLine(note.source)}`);
    lines.push(formatChipLine(note));
    lines.push(`# core              ${note.core_id}  owner=${note.owner}`);
    lines.push(`# packet_format     ${note.packet_format}  address_mode=${note.address_mode}`);
    lines.push(`# memory_mode       ${note.memory_mode}  wrap_state=${note.wrap_state}`);
    lines.push(`# resync            mode=${note.resync_mode}  threshold=${note.resync_threshold}`);
    if (note.wrap_reason !== undefined) {
        lines.push(`#                   wrap_reason=${oneLine(note.wrap_reason)}`);
    }
    lines.push(`# buffer            capacity=${note.capacity}  head_offset=${note.head_offset}`);
    lines.push(
        `# hw_status         fifo=0x${note.fifo_status_raw.toString(16).padStart(8, '0')}  ` +
            `intr=0x${note.intr_status_raw.toString(16).padStart(8, '0')}  ` +
            `empty=${note.fifo_empty ? 'yes' : 'no'}  ` +
            `full=${note.memory_full ? 'yes' : 'no'}  ` +
            `overflow=${note.fifo_overflow ? 'yes' : 'no'}`
    );
    const emptied = note.fifo_emptied === false ? '  fifo_emptied=no' : '';
    lines.push(`# capture           reason=${note.capture_reason}${emptied}`);
    if ((note.abi_minor ?? 0) > ABI_MINOR) {
        lines.push(`# snapshot_abi      ${note.abi_major}.${note.abi_minor}  supported=${ABI_MAJOR}.${ABI_MINOR}`);
    }
    lines.push(`# app_elf_sha256    ${formatShaStatus(note)}`);
    const romLine = formatRomElfLine(note);
    if (romLine !== undefined) {
        lines.push(romLine);
    }
    return lines;
}

export function formatCaptureSet(captures: Array<readonly [TraceCaptureNote, TraceDiagnostic]>, command: string): string[] {
    /** Return the header for the cores of several captures, one `(note, diagnostic)` per core. */
    const first = captures[0][0];
    const lines: string[] = [`# esp-riscv-trace ${command}`, formatChipLine(first)];
    lines.push(`# app_elf_sha256    ${formatShaStatus(first)}`);
    const romLine = formatRomElfLine(first);
    if (romLine !== undefined) {
        lines.push(romLine);
    }
    lines.push(`# captures          ${new Set(captures.map(([note]) => note.source)).size}`);
    for (const [note, diag] of captures) {
        const sha = note.elf_sha_status !== first.elf_sha_status ? `  elf_sha256=${note.elf_sha_status}` : '';
        lines.push(
            `#                   ${oneLine(note.source)}  core=${note.core_id}  instructions=${diag.instructions}  ` +
                `syncs=${diag.syncs}  traps=${diag.traps}  gaps=${diag.gaps}${sha}`
        );
    }
    return lines;
}

export function formatRawBuffer(
    raw: Buffer,
    opts: { head_offset: number; head_valid: boolean; core_id?: number; width?: number }
): string[] {
    /** Return a hex dump of one core's physical encoder buffer. */
    const width = opts.width ?? 16;
    const core = opts.core_id !== undefined ? `core=${opts.core_id}  ` : '';
    const lines = [
        `# raw_buffer       ${core}bytes=${raw.length}  head_offset=${opts.head_offset}  ` +
            `head_valid=${opts.head_valid ? 'yes' : 'no'}`,
    ];
    if (!raw.length) {
        lines.push('#                  (empty)');
        return lines;
    }

    for (let off = 0; off < raw.length; off += width) {
        const chunk = raw.subarray(off, off + width);
        const hexPart = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(width * 3 - 1);
        const asciiPart = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        const atHead =
            opts.head_valid &&
            ((off <= opts.head_offset && opts.head_offset < off + chunk.length) ||
                (opts.head_offset === raw.length && off + chunk.length === raw.length));
        const headMark = atHead ? '  <- head' : '';
        lines.push(`# ${off.toString(16).padStart(8, '0')}  ${hexPart}  |${asciiPart}|${headMark}`);
    }
    return lines;
}

export function formatEvent(
    event: TraceEvent,
    resolver?: SourceResolver,
    image?: CodeImage,
    debug = false
): string {
    /** Render one trace event as a single text line without a newline. */
    let line: string;
    let inferred = false;
    if (event.event === 'instruction') {
        const insn = event as TraceInstruction;
        line = formatInstruction(insn, resolver, image);
        inferred = insn.inferred;
    } else if (event.event === 'sync') {
        line = formatSync(event as TraceSync);
    } else if (event.event === 'trap') {
        line = formatTrap(event as TraceTrap);
    } else if (event.event === 'gap') {
        line = formatGap(event as TraceGap);
    } else if (event.event === 'boundary') {
        line = formatBoundary(event as TraceBoundary);
    } else if (event.event === 'warning') {
        line = formatWarning(event as TraceWarning);
    } else {
        line = `# unknown event type ${(event as TraceEvent).event}`;
    }
    return withPayloadPrefix(line, event.provenance, debug, inferred);
}

export function formatDiagnostic(diag: TraceDiagnostic): string[] {
    /** Return per-core footer lines summarising a `TraceDiagnostic`. */
    const lines: string[] = [];
    lines.push(
        `# summary           instructions=${diag.instructions}  ` +
            `syncs=${diag.syncs}  traps=${diag.traps}  gaps=${diag.gaps}`
    );
    if (diag.top_gap_reasons.length) {
        const parts = diag.top_gap_reasons.map(([r, c]) => `${oneLine(r)}=${c}`);
        lines.push(`#                   top_gap_reasons=${parts.join(', ')}`);
    }
    if (diag.warning_reasons.length) {
        const parts = diag.warning_reasons.map(([r, c]) => `${oneLine(r)}=${c}`);
        lines.push(`#                   warnings=${parts.join(', ')}`);
    }
    if (diag.boundary_kinds.length) {
        const parts = diag.boundary_kinds.map(([r, c]) => `${oneLine(r)}=${c}`);
        lines.push(`#                   boundaries=${parts.join(', ')}`);
    }
    if (diag.repeated_gaps.length) {
        const parts = diag.repeated_gaps.map(([r, d, c]) => `${oneLine(r)} "${oneLineQuoted(d)}" x${c}`);
        lines.push(`#                   repeated_gaps=${parts.join(', ')}`);
    }
    if (diag.root_cause !== undefined) {
        lines.push(`# diagnostic        ${oneLine(diag.root_cause)}`);
        if (diag.hint !== undefined) {
            lines.push(`#                   hint=${oneLine(diag.hint)}`);
        }
    }
    return lines;
}

// ---------------------------------------------------------------------------
// Internal formatters
// ---------------------------------------------------------------------------

function formatChipLine(note: TraceCaptureNote): string {
    const chip = note.chip ?? 'unknown';
    const tid = note.target_id !== undefined ? `0x${note.target_id.toString(16).padStart(4, '0')}` : 'none';
    const rev = note.chip_revision !== undefined ? `0x${note.chip_revision.toString(16).padStart(4, '0')}` : 'none';
    return `# chip              ${chip}  target_id=${tid}  revision=${rev}`;
}

function formatShaStatus(note: TraceCaptureNote): string {
    const status = note.elf_sha_status;
    const snap = shortSha(note.snapshot_app_elf_sha256);
    const elf = shortSha(note.elf_sha256);
    const elfPath = note.elf_path ? oneLine(note.elf_path) : 'none';
    if (status === ElfShaStatus.NO_ELF) {
        return `${status}  snapshot=${snap}`;
    }
    if (status === ElfShaStatus.NO_SNAPSHOT_HASH) {
        return `${status}  elf=${elf}  path=${elfPath}`;
    }
    if (status === ElfShaStatus.MATCH) {
        return `${status}  sha=${elf}  path=${elfPath}`;
    }
    return `${status}  snapshot=${snap}  elf=${elf}  path=${elfPath}`;
}

function formatRomElfLine(note: TraceCaptureNote): string | undefined {
    /** Return the `# rom_elf` header line, or undefined when no ROM lookup ran because there was no `--elf`. */
    const status = note.rom_elf_status;
    if (status === undefined) {
        return undefined;
    }
    const path = note.rom_elf_path ? oneLine(note.rom_elf_path) : 'none';
    return `# rom_elf           ${status}  path=${path}`;
}

function formatPayloadHex(prov: Provenance | undefined, inferred: boolean): string {
    if (inferred) {
        return 'inferred'.padEnd(PAYLOAD_HEX_WIDTH);
    }
    const raw = prov === undefined || !prov.payload ? Buffer.alloc(0) : prov.payload;
    const hexPart = [...raw].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return hexPart.padEnd(PAYLOAD_HEX_WIDTH);
}

function withPayloadPrefix(line: string, provenance: Provenance | undefined, debug: boolean, inferred = false): string {
    if (!debug) {
        return line;
    }
    return `${formatPayloadHex(provenance, inferred)}  ${line}`;
}

function formatProv(prov: Provenance | undefined): string {
    if (prov === undefined) {
        return '';
    }
    if (prov.packet_index < 0) {
        return `[frame seg=${prov.segment_index} off=${prov.stream_offset}]`;
    }
    return `[frame seg=${prov.segment_index} off=${prov.stream_offset} idx=${prov.packet_index}]`;
}

function formatInstruction(event: TraceInstruction, resolver: SourceResolver | undefined, image: CodeImage | undefined): string {
    const pc = `0x${event.pc.toString(16).padStart(8, '0')}`;
    const func = oneLine(lookupFunction(event.pc, image));
    const src = oneLine(lookupSource(event.pc, resolver));
    const funcCol = `${func}()`.padEnd(FUNCTION_COLUMN_WIDTH);
    const prov = formatProv(event.provenance);
    const tail = instructionTail(event);
    let line = src ? `${pc}  ${funcCol}  ${src}` : `${pc}  ${funcCol}`;
    if (prov) {
        line = `${line}  ${prov}`;
    }
    if (tail) {
        line = `${line}  ${tail}`;
    }
    return line;
}

function instructionTail(event: TraceInstruction): string {
    if (event.cls === InsnClass.BRANCH) {
        return event.branch_taken ? '# branch=taken' : '# branch=not_taken';
    }
    const nextPc = event.next_pc !== undefined ? `0x${event.next_pc.toString(16).padStart(8, '0')}` : 'untraced';
    if (event.cls === InsnClass.JUMP) {
        return `# jump next=${nextPc}`;
    }
    if (event.cls === InsnClass.UNINFERABLE) {
        return `# uninferable next=${nextPc}`;
    }
    if (event.cls === InsnClass.TRAP) {
        return `# trap next=${nextPc}`;
    }
    return '';
}

function formatSync(event: TraceSync): string {
    return marker(`sync pc=0x${event.pc.toString(16).padStart(8, '0')} priv=${event.privilege}`, formatProv(event.provenance));
}

function formatTrap(event: TraceTrap): string {
    const asyncFlag = event.interrupt ? 1 : 0;
    const handler = event.handler_pc !== undefined ? `0x${event.handler_pc.toString(16).padStart(8, '0')}` : 'none';
    const epc = event.epc !== undefined ? `0x${event.epc.toString(16).padStart(8, '0')}` : 'none';
    const tval = event.tval !== undefined ? `0x${event.tval.toString(16).padStart(8, '0')}` : 'none';
    const body = `trap cause=${event.cause} async=${asyncFlag} handler=${handler} epc=${epc} tval=${tval}`;
    return marker(body, formatProv(event.provenance));
}

function formatGap(event: TraceGap): string {
    const body = `gap ${oneLine(event.reason)} "${oneLineQuoted(event.detail)}"`;
    return marker(body, formatProv(event.provenance));
}

function formatBoundary(event: TraceBoundary): string {
    const body = `boundary ${oneLine(event.kind)} "${oneLineQuoted(event.detail)}"`;
    return marker(body, formatProv(event.provenance));
}

function formatWarning(event: TraceWarning): string {
    const body = `warning ${oneLine(event.kind)} "${oneLineQuoted(event.detail)}"`;
    return marker(body, formatProv(event.provenance));
}

interface GapRun {
    /** One run of consecutive `TraceGap` events sharing a reason. */
    reason: string;
    first: TraceGap;
    last: TraceGap;
    count: number;
    allHaveIdx: boolean;
    allContiguous: boolean;
    detailCounts: Map<string, number>;
    detailOrder: string[];
}

function newGapRun(event: TraceGap): GapRun {
    return {
        reason: event.reason,
        first: event,
        last: event,
        count: 1,
        allHaveIdx: event.provenance !== undefined && event.provenance.packet_index >= 0,
        allContiguous: true,
        detailCounts: new Map([[event.detail, 1]]),
        detailOrder: [event.detail],
    };
}

function gapRunMatches(run: GapRun, event: TraceGap): boolean {
    return event.reason === run.reason;
}

function gapRunAppend(run: GapRun, event: TraceGap): void {
    const prev = run.last;
    run.last = event;
    run.count++;
    const curProv = event.provenance;
    const prevProv = prev.provenance;
    if (curProv === undefined || curProv.packet_index < 0) {
        run.allHaveIdx = false;
        run.allContiguous = false;
    } else if (prevProv === undefined || prevProv.packet_index < 0) {
        run.allContiguous = false;
    } else if (curProv.packet_index !== prevProv.packet_index + 1) {
        // Packet index is not contiguous.
        run.allContiguous = false;
    }
    if (run.detailCounts.has(event.detail)) {
        run.detailCounts.set(event.detail, (run.detailCounts.get(event.detail) ?? 0) + 1);
    } else {
        run.detailCounts.set(event.detail, 1);
        run.detailOrder.push(event.detail);
    }
}

function gapRunDetails(run: GapRun): Array<readonly [string, number]> {
    return run.detailOrder.map((d) => [d, run.detailCounts.get(d) ?? 0] as const);
}

export class GapCoalescer {
    /** Collapses consecutive same-reason gap runs for cleaner output. */
    private formatNonGap: (event: TraceEvent) => string;
    private debug: boolean;
    private pending: GapRun | undefined;

    constructor(formatNonGap: (event: TraceEvent) => string, debug = false) {
        this.formatNonGap = formatNonGap;
        this.debug = debug;
    }

    *push(event: TraceEvent): Generator<string> {
        // Update state before yielding output lines.
        if (event.event === 'gap') {
            const gap = event as TraceGap;
            if (this.pending !== undefined && gapRunMatches(this.pending, gap)) {
                gapRunAppend(this.pending, gap);
                return;
            }
            let flushed: string | undefined;
            if (this.pending !== undefined) {
                flushed = this.formatRun(this.pending);
            }
            this.pending = newGapRun(gap);
            if (flushed !== undefined) {
                yield flushed;
            }
            return;
        }
        let flushed: string | undefined;
        if (this.pending !== undefined) {
            flushed = this.formatRun(this.pending);
            this.pending = undefined;
        }
        if (flushed !== undefined) {
            yield flushed;
        }
        yield this.formatNonGap(event);
    }

    *close(): Generator<string> {
        if (this.pending === undefined) {
            return;
        }
        const run = this.pending;
        this.pending = undefined;
        yield this.formatRun(run);
    }

    private formatRun(run: GapRun): string {
        return withPayloadPrefix(formatGapRun(run), run.first.provenance, this.debug);
    }
}

function formatGapRun(run: GapRun): string {
    /** Render a coalesced gap run. */
    if (run.count === 1) {
        return formatGap(run.first);
    }
    const reason = oneLine(run.reason);
    const details = gapRunDetails(run);
    let head: string;
    if (details.length === 1) {
        const detail = oneLineQuoted(details[0][0]);
        head = `--- gap ${reason} x${run.count} "${detail}"`;
    } else {
        const parts = details.map(([d, c]) => `"${oneLineQuoted(d)}" x${c}`);
        head = `--- gap ${reason} x${run.count} [${parts.join(', ')}]`;
    }
    const span = formatProvSpan(run.first.provenance, run.last.provenance, run.allHaveIdx, run.allContiguous);
    return span ? `${head} ${span} ---` : `${head} ---`;
}

function formatProvSpan(
    first: Provenance | undefined,
    last: Provenance | undefined,
    allHaveIdx: boolean,
    allContiguous: boolean
): string {
    /** Render the `[frames ...]` suffix that covers a coalesced run. */
    if (first === undefined || last === undefined) {
        return '';
    }
    const seg =
        first.segment_index === last.segment_index
            ? `seg=${first.segment_index}`
            : `seg=${first.segment_index}..${last.segment_index}`;
    const off = `off=${first.stream_offset}..${last.stream_offset}`;
    const sameSegment = first.segment_index === last.segment_index;
    const idx =
        allHaveIdx && sameSegment && allContiguous ? ` idx=${first.packet_index}..${last.packet_index}` : '';
    return `[frames ${seg} ${off}${idx}]`;
}

function lookupFunction(pc: number, image: CodeImage | undefined): string {
    if (image === undefined) {
        return '?';
    }
    try {
        const name = image.symbolAt(pc);
        return name ? name : '?';
    } catch {
        return '?';
    }
}

function lookupSource(pc: number, resolver: SourceResolver | undefined): string {
    if (resolver === undefined) {
        return '';
    }
    let loc;
    try {
        loc = resolver.resolve(pc);
    } catch {
        return '';
    }
    return loc === undefined ? '' : `${loc.file}:${loc.line}`;
}
