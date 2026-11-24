// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/cli.py (Apache-2.0): the decode,
// stats, history and profile commands as plain functions returning output lines.

import { DiagnosticAccumulator, TraceDiagnostic } from './analysis/diagnostics';
import { buildHistory, History, isFault } from './analysis/history';
import { FaultWindow, FaultWindowBuilder } from './analysis/origin';
import { buildProfile, mergeProfiles, Profile } from './analysis/profile';
import { StatsAccumulator, StatsSnapshot, mergeStatsSnapshots } from './analysis/stats';
import { TraceCaptureNote } from './ir/capture_note';
import { CodeImage, ElfImage } from './elf/image';
import { LayeredImage } from './elf/layered';
import { SourceResolver } from './elf/resolver';
import { PrefetchedResolver, resolveSourceLines } from './elf/addr2lineResolver';
import { resolveSourceLinesWithGdb } from './elf/gdbResolver';
import { formatDiagnostic, formatEvent, formatNote, formatRawBuffer, GapCoalescer } from './exporters/text';
import { pyJson } from './exporters/_format';
import { formatHistory, historyToDict } from './exporters/history';
import { formatFaultOrigin } from './exporters/origin';
import { formatStats } from './exporters/statsText';
import { formatFolded, profileToSpeedscope } from './exporters/profile';
import { TraceEvent, TraceTrap } from './ir/events';
import { CoreView, Session, UsageError, iterCores, openSession } from './session';
import { RomStatus, resolveRomElf, romElfFileRevision } from './elf/rom';
import * as fs from 'fs';
import * as path from 'path';

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_SHA_MISMATCH = 2;
export const EXIT_CORE_NOT_FOUND = 3;
export const EXIT_DECODE_FAILED = 4;

const DEFAULT_HISTORY_LAST = 40;

export interface CommandOptions {
    /** Application ELF path; required for stats/history/profile. */
    elfPath?: string;
    /** addr2line binary for DWARF line resolution; without it source columns stay empty. */
    addr2linePath?: string;
    /** Optional GDB binary used as an `info line` fallback when addr2line is unavailable or fails. */
    gdbPath?: string;
    core?: number;
    chip?: string;
    forceElf?: boolean;
    requireElf?: boolean;
    romElfPath?: string;
    /**
     * Auto-discovered ROM ELF (e.g. PlatformIO `tool-esp-rom-elfs`). Used only
     * when revision-aware ESP-IDF resolution finds nothing and the file's
     * `_rev<N>` does not exceed the capture's chip revision; never overrides
     * an explicit `romElfPath`.
     */
    romElfPathHint?: string;
    /** decode */
    debug?: boolean;
    last?: number;
    /** stats */
    top?: number;
    perBlock?: boolean;
    mergeCores?: boolean;
    /** history */
    historyLast?: number;
    asJson?: boolean;
    /** profile */
    profileFormat?: 'folded' | 'speedscope';
    mergeProfiles?: boolean;
    /** Suppress the one-line summary the CLI prints to stderr. */
    quiet?: boolean;
    warn?: (message: string) => void;
}

export interface CommandResult {
    /** stdout content, one entry per line. */
    lines: string[];
    /** The one-line summary the CLI prints to stderr, when not quiet. */
    summary?: string;
}

export interface TraceCoreAnalysis {
    coreId: number;
    note: TraceCaptureNote;
    diag: TraceDiagnostic;
    events: TraceEvent[];
    resolver: SourceResolver;
    image: CodeImage | undefined;
    stats: StatsSnapshot;
    history: History;
    profile: Profile;
    origin: FaultWindow;
}

export interface TraceCaptureAnalysis {
    capturePath: string;
    chip: string;
    elfPath?: string;
    romElfPath?: string;
    cores: TraceCoreAnalysis[];
}

interface PreparedCore {
    view: CoreView;
    events: TraceEvent[];
    resolver: SourceResolver;
    diag: TraceDiagnostic;
}

/**
 * A discovered ROM ELF is revision-compatible when its `_rev<N>` is at most
 * the capture's chip revision. `_rev<N>` follows the same major*100+minor
 * encoding as roms.json revisions. Unversioned files are only trusted when
 * the capture revision is unknown (0).
 */
function romElfHintCompatible(hint: string, chipRevision: number, chip: string): boolean {
    const base = path.basename(hint).toLowerCase();
    const chipPrefix = chip.toLowerCase();
    if (!base.startsWith(`${chipPrefix}_`) && !base.startsWith(`${chipPrefix}.`)) {
        return false;
    }
    if (chipRevision <= 0) {
        return true;
    }
    const rev = romElfFileRevision(hint);
    return rev !== undefined && rev <= chipRevision;
}

/** Load the session, select cores and materialize each core's events once. */
function prepareCores(capturePath: string, options: CommandOptions): { session: Session; cores: CoreView[] } {
    const session = openSession(capturePath, {
        elfPath: options.elfPath,
        chip: options.chip,
        forceElf: options.forceElf,
        requireElf: options.requireElf,
        warn: options.warn,
    });
    if (options.requireElf && session.elf === undefined) {
        throw new Error('--elf is required for this command');
    }
    // Mirror upstream _open_rom_elf: an explicit --rom-elf wins, otherwise the
    // ESP-IDF environment is searched and the status is reported either way.
    if (session.elf !== undefined) {
        const revision = session.cap.chip_revision ?? 0;
        if (options.romElfPath !== undefined) {
            session.romElfPath = options.romElfPath;
            session.romElfStatus = fs.existsSync(options.romElfPath) ? RomStatus.PROVIDED : RomStatus.NOT_FOUND;
        } else {
            let [romPath, status] = resolveRomElf(session.chip, revision);
            // Discovered ROM ELFs (e.g. PlatformIO tool-esp-rom-elfs) are only
            // a fallback: they must not bypass the revision-aware ESP-IDF
            // lookup, and their `_rev<N>` must not exceed the capture's chip
            // revision (next-lower semantics, mirroring selectRomRevision).
            if (
                romPath === undefined &&
                options.romElfPathHint !== undefined &&
                romElfHintCompatible(options.romElfPathHint, revision, session.chip)
            ) {
                romPath = options.romElfPathHint;
                status = RomStatus.AUTO;
            }
            session.romElfPath = romPath;
            session.romElfStatus = status;
            if (status === RomStatus.MISSING_ENV) {
                options.warn?.('ROM ELF not searched, IDF_PATH or ESP_ROM_ELF_DIR is not set. Pass romElfPath to use one');
            } else if (status === RomStatus.NOT_FOUND) {
                options.warn?.(`ROM ELF not found for ${romPath ?? `${session.chip} revision ${revision}`}, continuing without it`);
            }
        }
        // Layer the ROM under the app image so ROM-only addresses decode,
        // mirroring upstream's LayeredImage. A bad ROM keeps the app image.
        if (
            session.romElfPath !== undefined &&
            session.image instanceof ElfImage &&
            fs.existsSync(session.romElfPath)
        ) {
            try {
                session.image = new LayeredImage(session.image, new ElfImage(session.romElfPath));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                options.warn?.(`cannot open ROM ELF ${session.romElfPath}: ${message}, continuing without it`);
                session.romElfStatus = RomStatus.INVALID;
            }
        }
    }
    const views = [...iterCores(session, options.core)];
    if (!views.length) {
        const ids = session.cap.cores.map((c) => String(c.core_id)).join(', ') || '(none)';
        throw new Error(`no core matched --core ${options.core}. Present cores ${ids}.`);
    }
    return { session, cores: views };
}

/** Materialize events, resolve source lines and close the diagnostic for one core. */
async function prepareCoreAsync(view: CoreView, options: CommandOptions): Promise<PreparedCore> {
    const events = [...view.events()];
    const resolver = await buildResolver(view, events, options);
    const diagAcc = new DiagnosticAccumulator();
    for (const ev of events) {
        diagAcc.push(ev);
    }
    return { view, events, resolver, diag: diagAcc.close(view.note) };
}

function sessionResolver(view: CoreView): SourceResolver {
    return view.session.resolver ?? new PrefetchedResolver(new Map());
}

/** Collect the PCs worth resolving: every instruction and sync/trap address. */
function eventPcs(events: Iterable<TraceEvent>): number[] {
    const pcs = new Set<number>();
    for (const ev of events) {
        if (ev.event === 'instruction' || ev.event === 'sync') {
            pcs.add(ev.pc);
        } else if (ev.event === 'trap' && ev.epc !== undefined) {
            pcs.add(ev.epc);
        }
    }
    return [...pcs];
}

async function buildResolver(view: CoreView, events: TraceEvent[], options: CommandOptions): Promise<SourceResolver> {
    const session = view.session;
    if (session.elf === undefined) {
        return sessionResolver(view);
    }
    const pcs = eventPcs(events);
    if (options.addr2linePath !== undefined) {
        try {
            return await resolveSourceLines(pcs, options.addr2linePath, session.elf.path);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.warn?.(`addr2line failed (${message}), trying GDB fallback`);
        }
    }
    if (options.gdbPath !== undefined) {
        try {
            return await resolveSourceLinesWithGdb(pcs, options.gdbPath, session.elf.path);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.warn?.(`gdb info line failed (${message}), continuing without source lines`);
        }
    }
    return sessionResolver(view);
}

function summaryLine(cores: PreparedCore[]): string {
    const first = cores[0];
    const cap = first.view.session.cap;
    const captures = new Set(cores.map((c) => c.view.session.cap.source_path)).size;
    const source = captures === 1 ? cap.source_path : `${captures} captures`;
    const ids = [...new Set(cores.map((c) => c.view.core.core_id))].join(',');
    const sum = (pick: (d: TraceDiagnostic) => number) => cores.reduce((acc, c) => acc + pick(c.diag), 0);
    return (
        `esp-riscv-trace: ${source} chip=${first.view.session.chip} cores=[${ids}] ` +
        `instructions=${sum((d) => d.instructions)} syncs=${sum((d) => d.syncs)} ` +
        `traps=${sum((d) => d.traps)} gaps=${sum((d) => d.gaps)}`
    );
}

function finish(cores: PreparedCore[], lines: string[], options: CommandOptions): CommandResult {
    return { lines, summary: options.quiet ? undefined : summaryLine(cores) };
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

export async function decodeCapture(capturePath: string, options: CommandOptions = {}): Promise<CommandResult> {
    const { cores: views } = prepareCores(capturePath, options);
    const prepared: PreparedCore[] = [];
    for (const view of views) {
        prepared.push(await prepareCoreAsync(view, options));
    }
    const lines: string[] = [];
    for (let i = 0; i < prepared.length; i++) {
        const { view, events, resolver, diag } = prepared[i];
        writeHeader(lines, view, 'decode', i === 0, options.debug ?? false);
        const coalescer = new GapCoalescer(
            (event) => formatEvent(event, resolver, view.session.image, options.debug ?? false),
            options.debug ?? false
        );
        let stream: Iterable<TraceEvent> = events;
        if (options.last !== undefined) {
            if (!Number.isInteger(options.last) || options.last < 0) {
                throw new UsageError(`last must be a nonnegative integer, got ${options.last}`);
            }
            stream = lastBeforeFault(lines, stream, options.last);
        }
        for (const ev of stream) {
            for (const line of coalescer.push(ev)) {
                lines.push(line);
            }
        }
        for (const line of coalescer.close()) {
            lines.push(line);
        }
        lines.push(...formatDiagnostic(diag));
    }
    return finish(prepared, lines, options);
}

function writeHeader(lines: string[], view: CoreView, command: string, first: boolean, debug: boolean): void {
    /** Write one core's capture header, with its raw buffer under `debug`. */
    if (!first) {
        lines.push('');
    }
    lines.push(...formatNote(view.note, command));
    if (debug) {
        const core = view.core;
        lines.push(
            ...formatRawBuffer(core.raw, {
                head_offset: core.head_offset,
                head_valid: core.head_valid,
                core_id: core.core_id,
            })
        );
    }
}

function* lastBeforeFault(lines: string[], events: Iterable<TraceEvent>, last: number): Generator<TraceEvent> {
    /** Keep the last `last` instructions up to the first fault and yield the window. */
    const window: TraceEvent[] = [];
    let instructions = 0;
    let dropped = 0;
    let fault: TraceTrap | undefined;
    for (const ev of events) {
        window.push(ev);
        if (ev.event === 'instruction') {
            instructions++;
            while (instructions > last) {
                const removed = window.shift();
                if (removed !== undefined && removed.event === 'instruction') {
                    instructions--;
                    dropped++;
                }
            }
        }
        if (ev.event === 'trap' && isFault(ev)) {
            fault = ev;
            break;
        }
    }
    let ends: string;
    if (fault === undefined) {
        ends = 'end_of_trace';
    } else {
        const epc = fault.epc !== undefined ? `0x${fault.epc.toString(16).padStart(8, '0')}` : 'none';
        ends = `fault  cause=${fault.cause}  epc=${epc}`;
    }
    lines.push(`# window            instructions=${instructions}  omitted=${dropped}  ends_at=${ends}`);
    yield* window;
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

export async function statsCapture(capturePath: string, options: CommandOptions = {}): Promise<CommandResult> {
    const { cores: views } = prepareCores(capturePath, { ...options, requireElf: true });
    const prepared: PreparedCore[] = [];
    const snaps: StatsSnapshot[] = [];
    for (const view of views) {
        const p = await prepareCoreAsync(view, options);
        const acc = new StatsAccumulator(p.view.session.image, p.resolver);
        for (const ev of p.events) {
            acc.push(ev);
        }
        prepared.push(p);
        snaps.push(acc.close());
    }
    const lines: string[] = [];
    const top = options.top ?? 20;
    const perBlock = options.perBlock ?? false;
    const mergeCores = options.mergeCores ?? false;
    const debug = options.debug ?? false;

    if (mergeCores) {
        for (let i = 0; i < prepared.length; i++) {
            writeHeader(lines, prepared[i].view, 'stats', i === 0, debug);
        }
        const merged = mergeStatsSnapshots(snaps);
        const label = `cores=${prepared.map((p) => p.view.core.core_id).join(',')}`;
        lines.push(...formatStats(merged, { top, per_block: perBlock, label }));
        for (const p of prepared) {
            lines.push('', `# core-diagnostic   core=${p.view.core.core_id}`);
            lines.push(...formatDiagnostic(p.diag));
        }
    } else {
        for (let i = 0; i < prepared.length; i++) {
            const p = prepared[i];
            writeHeader(lines, p.view, 'stats', i === 0, debug);
            lines.push(...formatStats(snaps[i], { top, per_block: perBlock, label: `core=${p.view.core.core_id}` }));
            lines.push(...formatDiagnostic(p.diag));
        }
    }
    return finish(prepared, lines, options);
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

export async function historyCapture(capturePath: string, options: CommandOptions = {}): Promise<CommandResult> {
    const { cores: views } = prepareCores(capturePath, { ...options, requireElf: true });
    const prepared: PreparedCore[] = [];
    const histories: History[] = [];
    const last = options.historyLast ?? DEFAULT_HISTORY_LAST;
    for (const view of views) {
        const p = await prepareCoreAsync(view, options);
        prepared.push(p);
        histories.push(buildHistory(p.events, p.view.session.image, { last }));
    }
    const lines: string[] = [];
    if (options.asJson) {
        const coresJson = prepared.map((p, i) => ({
            core: p.view.core.core_id,
            chip: p.view.note.chip,
            source: p.view.note.source,
            elf_sha256_status: String(p.view.note.elf_sha_status),
            summary: {
                instructions: p.diag.instructions,
                syncs: p.diag.syncs,
                traps: p.diag.traps,
                gaps: p.diag.gaps,
            },
            history: historyToDict(histories[i], p.view.session.image, p.resolver),
        }));
        lines.push(JSON.stringify({ command: 'history', cores: coresJson }, null, 2));
    } else {
        for (let i = 0; i < prepared.length; i++) {
            const p = prepared[i];
            writeHeader(lines, p.view, 'history', i === 0, false);
            lines.push(
                ...formatHistory(histories[i], p.view.session.image, p.resolver, {
                    label: `core=${p.view.core.core_id}`,
                })
            );
            lines.push(...formatDiagnostic(p.diag));
        }
    }
    return finish(prepared, lines, options);
}

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

export async function profileCapture(capturePath: string, options: CommandOptions = {}): Promise<CommandResult> {
    const { cores: views } = prepareCores(capturePath, { ...options, requireElf: true });
    const prepared: PreparedCore[] = [];
    const profiles: Profile[] = [];
    for (const view of views) {
        const p = await prepareCoreAsync(view, options);
        prepared.push(p);
        profiles.push(buildProfile(p.events, p.view.session.image));
    }
    const byCore = new Map<number, Profile[]>();
    for (let i = 0; i < prepared.length; i++) {
        const id = prepared[i].view.core.core_id;
        const list = byCore.get(id) ?? [];
        list.push(profiles[i]);
        byCore.set(id, list);
    }
    const merge = options.mergeProfiles ?? false;
    const named: Array<readonly [string | undefined, Profile]> = merge
        ? [[undefined, mergeProfiles([...byCore.values()].flat())]]
        : [...byCore.entries()]
              .sort(([a], [b]) => a - b)
              .map(([coreId, list]) => [`core ${coreId}`, mergeProfiles(list)] as const);

    const lines: string[] = [];
    if ((options.profileFormat ?? 'folded') === 'speedscope') {
        const titled = merge
            ? [[`cores ${[...byCore.keys()].sort((a, b) => a - b).join(',')}`, named[0][1]] as const]
            : [...byCore.entries()]
                  .sort(([a], [b]) => a - b)
                  .map(([coreId, list]) => [`core ${coreId}`, mergeProfiles(list)] as const);
        lines.push(pyJson(profileToSpeedscope(titled, capturePath)));
    } else {
        lines.push(...formatFolded(named));
    }
    return finish(prepared, lines, options);
}

// ---------------------------------------------------------------------------
// origin
// ---------------------------------------------------------------------------

export async function originCapture(capturePath: string, options: CommandOptions = {}): Promise<CommandResult> {
    const { cores: views } = prepareCores(capturePath, { ...options, requireElf: true });
    const prepared: PreparedCore[] = [];
    const lines: string[] = [];
    for (let i = 0; i < views.length; i++) {
        const p = await prepareCoreAsync(views[i], options);
        prepared.push(p);
        const builder = new FaultWindowBuilder(p.view.session.image);
        for (const ev of p.events) {
            builder.push(ev);
        }
        const win = builder.close();
        writeHeader(lines, p.view, 'origin', i === 0, false);
        lines.push(...formatFaultOrigin(win, p.view.session.image, p.resolver, { label: `core=${p.view.core.core_id}` }));
        lines.push(...formatDiagnostic(p.diag));
    }
    return finish(prepared, lines, options);
}

// ---------------------------------------------------------------------------
// structured analysis for UI (TreeView + Webview)
// ---------------------------------------------------------------------------

export async function analyzeCapture(capturePath: string, options: CommandOptions = {}): Promise<TraceCaptureAnalysis> {
    const { session, cores: views } = prepareCores(capturePath, options);
    const last = options.historyLast ?? DEFAULT_HISTORY_LAST;
    const cores: TraceCoreAnalysis[] = [];

    for (const view of views) {
        const p = await prepareCoreAsync(view, options);
        const statsAcc = new StatsAccumulator(p.view.session.image, p.resolver);
        const originBuilder = new FaultWindowBuilder(p.view.session.image);
        for (const ev of p.events) {
            statsAcc.push(ev);
            originBuilder.push(ev);
        }
        cores.push({
            coreId: p.view.core.core_id,
            note: p.view.note,
            diag: p.diag,
            events: p.events,
            resolver: p.resolver,
            image: p.view.session.image,
            stats: statsAcc.close(),
            history: buildHistory(p.events, p.view.session.image, { last }),
            profile: buildProfile(p.events, p.view.session.image),
            origin: originBuilder.close(),
        });
    }

    return {
        capturePath,
        chip: session.chip,
        elfPath: session.elf?.path,
        romElfPath: session.romElfPath,
        cores,
    };
}
