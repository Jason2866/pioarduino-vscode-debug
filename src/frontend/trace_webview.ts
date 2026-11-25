import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { iterEntries } from '../trace/analysis/history';
import { RegisterStep } from '../trace/analysis/origin';
import { profileStacks } from '../trace/analysis/profile';
import { UNRESOLVED_FILE } from '../trace/analysis/stats';
import { TraceCaptureAnalysis, TraceCoreAnalysis } from '../trace/commands';
import { decodeAt, insnText } from '../trace/decoder/semantics';
import { TraceEvent } from '../trace/ir/events';

export type TraceExportKind = 'decode' | 'stats' | 'historyJson' | 'historyText' | 'folded' | 'speedscope' | 'origin';

export interface TraceWebviewCallbacks {
    onOpenLocation: (file: string, line: number, elfPath?: string) => void;
    onExport: (kind: TraceExportKind, coreId: number, saveToFile?: boolean) => void;
}

export interface InstructionRow {
    index: number;
    kind: TraceEvent['event'];
    pcText: string;
    detail: string;
    symbol?: string;
    file?: string;
    line?: number;
}

export interface InstructionPageResult {
    page: number;
    pageSize: number;
    totalPages: number;
    totalMatched: number;
    rows: InstructionRow[];
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtAddr(pc: number): string {
    return `0x${(pc >>> 0).toString(16).padStart(8, '0')}`;
}

function eventToRow(ev: TraceEvent, index: number, core: TraceCoreAnalysis): InstructionRow {
    if (ev.event === 'instruction') {
        const sym = core.image?.symbolAt(ev.pc);
        const loc = core.resolver.resolve(ev.pc);
        const decoded = core.image && typeof core.image.read === 'function' ? decodeAt(core.image, ev.pc) : undefined;
        const detail = (decoded ? insnText(decoded, ev.pc) : undefined) ?? `cls=${ev.cls} (${ev.length}B)`;
        return {
            index,
            kind: 'instruction',
            pcText: fmtAddr(ev.pc),
            detail,
            symbol: sym,
            file: loc?.file,
            line: loc?.line,
        };
    }
    if (ev.event === 'sync') {
        const sym = core.image?.symbolAt(ev.pc);
        const loc = core.resolver.resolve(ev.pc);
        return {
            index,
            kind: 'sync',
            pcText: fmtAddr(ev.pc),
            detail: `sync priv=${ev.privilege}`,
            symbol: sym,
            file: loc?.file,
            line: loc?.line,
        };
    }
    if (ev.event === 'trap') {
        const pc = ev.epc ?? ev.handler_pc;
        const sym = pc !== undefined ? core.image?.symbolAt(pc) : undefined;
        const loc = pc !== undefined ? core.resolver.resolve(pc) : undefined;
        return {
            index,
            kind: 'trap',
            pcText: pc !== undefined ? fmtAddr(pc) : '--------',
            detail: `trap cause=${ev.cause}${ev.interrupt ? ' (irq)' : ''}`,
            symbol: sym,
            file: loc?.file,
            line: loc?.line,
        };
    }
    if (ev.event === 'gap') {
        return {
            index,
            kind: 'gap',
            pcText: '--------',
            detail: `gap: ${ev.reason} (${ev.detail})`,
        };
    }
    if (ev.event === 'warning') {
        return {
            index,
            kind: 'warning',
            pcText: '--------',
            detail: `warning: ${ev.kind} (${ev.detail})`,
        };
    }
    return {
        index,
        kind: 'boundary',
        pcText: '--------',
        detail: `boundary: ${ev.kind}`,
    };
}

/** Filter and paginate a core's trace events for the webview Instructions tab. */
export function filterAndPaginateEvents(
    core: TraceCoreAnalysis,
    options: { page: number; pageSize: number; filter?: string; jumpToFault?: boolean }
): InstructionPageResult {
    const pageSize = Math.max(1, Math.min(2000, Math.floor(options.pageSize || 500)));
    const query = (options.filter ?? '').trim().toLowerCase();

    const matched: InstructionRow[] = [];
    let firstFaultMatchIdx = -1;
    for (let i = 0; i < core.events.length; i++) {
        const row = eventToRow(core.events[i], i, core);
        if (query) {
            const hay = `${row.pcText} ${row.kind} ${row.detail} ${row.symbol ?? ''} ${row.file ?? ''}`.toLowerCase();
            if (!hay.includes(query)) {
                continue;
            }
        }
        const isFaultTarget =
            core.origin.fault !== undefined ? core.events[i] === core.origin.fault : row.kind === 'trap';
        if (firstFaultMatchIdx === -1 && isFaultTarget) {
            firstFaultMatchIdx = matched.length;
        }
        matched.push(row);
    }

    const totalMatched = matched.length;
    const totalPages = Math.max(1, Math.ceil(totalMatched / pageSize));
    let page = Math.max(0, Math.min(totalPages - 1, Math.floor(options.page || 0)));
    if (options.jumpToFault && firstFaultMatchIdx !== -1) {
        page = Math.floor(firstFaultMatchIdx / pageSize);
    }

    const start = page * pageSize;
    return {
        page,
        pageSize,
        totalPages,
        totalMatched,
        rows: matched.slice(start, start + pageSize),
    };
}

/** WebviewPanel inspector for ESP32 RISC-V trace captures with clickable source links. */
export class TraceWebviewPanel {
    private panel: vscode.WebviewPanel | undefined;
    private analysis: TraceCaptureAnalysis | undefined;
    private callbacks: TraceWebviewCallbacks | undefined;

    show(
        analysis: TraceCaptureAnalysis,
        callbacks: TraceWebviewCallbacks,
        registers?: ReadonlyMap<number, number>
    ): void {
        this.analysis = analysis;
        this.callbacks = callbacks;

        const title = `ESP32 Trace: ${path.basename(analysis.capturePath)}`;
        if (this.panel) {
            this.panel.title = title;
            this.panel.reveal(vscode.ViewColumn.One);
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'pioarduinoTraceInspector',
                title,
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
            );
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });
            this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
        }

        this.panel.webview.html = this.buildHtml(analysis, registers);
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
    }

    private handleMessage(msg: any): void {
        if (!msg || typeof msg !== 'object' || !this.analysis || !this.callbacks) {
            return;
        }
        if (msg.type === 'openLocation' && typeof msg.file === 'string' && typeof msg.line === 'number') {
            this.callbacks.onOpenLocation(msg.file, msg.line, this.analysis.elfPath);
            return;
        }
        if (msg.type === 'export' && typeof msg.kind === 'string' && typeof msg.coreId === 'number') {
            this.callbacks.onExport(msg.kind as TraceExportKind, msg.coreId, msg.saveToFile === true);
            return;
        }
        if (msg.type === 'requestInstructions' && typeof msg.coreId === 'number') {
            const core = this.analysis.cores.find((c) => c.coreId === msg.coreId) ?? this.analysis.cores[0];
            if (!core) {
                return;
            }
            const result = filterAndPaginateEvents(core, {
                page: typeof msg.page === 'number' ? msg.page : 0,
                pageSize: typeof msg.pageSize === 'number' ? msg.pageSize : 500,
                filter: typeof msg.filter === 'string' ? msg.filter : '',
                jumpToFault: msg.jumpToFault === true,
            });
            void this.panel?.webview.postMessage({ type: 'instructionsPage', coreId: core.coreId, ...result });
        }
    }

    private serializeStep(step: RegisterStep, core: TraceCoreAnalysis): any {
        const loc = step.pc !== undefined ? core.resolver.resolve(step.pc) : undefined;
        return {
            reg: step.reg,
            kind: step.kind,
            valueText: step.value !== undefined ? fmtAddr(step.value) : undefined,
            instruction: step.instruction,
            pcText: step.pc !== undefined ? fmtAddr(step.pc) : undefined,
            file: loc?.file,
            line: loc?.line,
            crossed: step.crossed,
            stop: step.stop,
            detail: step.detail,
            sources: step.sources.map((s) => this.serializeStep(s, core)),
        };
    }

    private buildCorePayload(core: TraceCoreAnalysis, registers?: ReadonlyMap<number, number>) {
        const total = core.stats.total_instructions || 1;
        const stats = [...core.stats.sample_hits.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 100)
            .map(([key, count]) => {
                const [func, file, line] = JSON.parse(key) as [string, string, number];
                return {
                    func,
                    count,
                    pct: ((100 * count) / total).toFixed(2),
                    file: file !== UNRESOLVED_FILE ? file : undefined,
                    line: line > 0 ? line : undefined,
                };
            });

        const history = [...iterEntries(core.history.items)].map((entry) => {
            const sym = entry.pc !== undefined ? core.image?.symbolAt(entry.pc) ?? fmtAddr(entry.pc) : entry.kind;
            const loc = entry.pc !== undefined ? core.resolver.resolve(entry.pc) : undefined;
            return {
                depth: entry.depth,
                kind: entry.kind,
                sym,
                pcText: entry.pc !== undefined ? fmtAddr(entry.pc) : '',
                file: loc?.file,
                line: loc?.line,
            };
        });

        const profileTotal = core.profile.instructions || 1;
        const profile = [...profileStacks(core.profile).entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 80)
            .map(([key, count]) => ({
                stack: (JSON.parse(key) as string[]).join(' ; '),
                count,
                pct: ((100 * count) / profileTotal).toFixed(2),
            }));

        const win = core.origin;
        const fault = win.fault;
        const faultLoc = fault?.epc !== undefined ? core.resolver.resolve(fault.epc) : undefined;
        const faultSym = fault?.epc !== undefined ? core.image?.symbolAt(fault.epc) : undefined;
        const originRoot = fault && registers && registers.size > 0 ? win.origin(registers) : undefined;
        const origin = {
            hasFault: fault !== undefined,
            cause: fault?.cause,
            epcText: fault?.epc !== undefined ? fmtAddr(fault.epc) : 'none',
            tvalText: fault?.tval !== undefined ? fmtAddr(fault.tval) : 'none',
            windowComplete: win.complete,
            faultSym,
            faultFile: faultLoc?.file,
            faultLine: faultLoc?.line,
            calls: win.stackCalls(registers ?? new Map()).map((c) => {
                const loc = core.resolver.resolve(c.pc);
                return {
                    pcText: fmtAddr(c.pc),
                    sym: core.image?.symbolAt(c.pc) ?? fmtAddr(c.pc),
                    spText: fmtAddr(c.sp),
                    file: loc?.file,
                    line: loc?.line,
                };
            }),
            branches: win
                .branches(faultSym !== undefined ? (pc) => core.image?.symbolAt(pc) === faultSym : () => true)
                .map((b) => {
                    const loc = core.resolver.resolve(b.pc);
                    return {
                        pcText: fmtAddr(b.pc),
                        taken: b.taken,
                        file: loc?.file,
                        line: loc?.line,
                    };
                }),
            registerRoot: originRoot ? this.serializeStep(originRoot, core) : undefined,
        };

        return {
            coreId: core.coreId,
            diag: core.diag,
            note: {
                chip: core.note.chip,
                elfShaStatus: core.note.elf_sha_status,
                source: core.note.source,
            },
            firstPage: filterAndPaginateEvents(core, { page: 0, pageSize: 500 }),
            stats,
            history,
            profile,
            origin,
        };
    }

    private buildHtml(analysis: TraceCaptureAnalysis, registers?: ReadonlyMap<number, number>): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const payload = {
            capturePath: analysis.capturePath,
            captureName: path.basename(analysis.capturePath),
            chip: analysis.chip,
            elfPath: analysis.elfPath ?? '(none)',
            romElfPath: analysis.romElfPath ?? '(none)',
            cores: analysis.cores.map((c) => this.buildCorePayload(c, registers)),
        };
        const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>${escapeHtml(path.basename(analysis.capturePath))}</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px 16px; }
  h2 { margin: 0 0 8px 0; font-size: 15px; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
  .tab { background: transparent; color: var(--vscode-foreground); border: none; padding: 6px 12px; cursor: pointer; border-bottom: 2px solid transparent; }
  .tab.active { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  input, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; }
  table { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { position: sticky; top: 0; background: var(--vscode-editor-background); }
  a.src { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .row-trap { background: var(--vscode-inputValidation-errorBackground); }
  .row-gap, .row-warning { background: var(--vscode-inputValidation-warningBackground); }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .card { border: 1px solid var(--vscode-panel-border); padding: 8px 12px; border-radius: 4px; min-width: 110px; }
  .card .num { font-size: 18px; font-weight: 600; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="bar">
    <h2 id="title"></h2>
    <label>Core: <select id="coreSelect"></select></label>
  </div>
  <div class="tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="instructions">Instructions</button>
    <button class="tab" data-tab="history">History</button>
    <button class="tab" data-tab="stats">Stats</button>
    <button class="tab" data-tab="profile">Profile</button>
    <button class="tab" data-tab="origin">Fault Origin</button>
  </div>
  <div id="tab-overview"></div>
  <div id="tab-instructions" class="hidden">
    <div class="bar">
      <input id="insnFilter" placeholder="Filter PC, symbol, mnemonic, gap…" />
      <button id="jumpFaultBtn">Jump to Fault</button>
      <button id="prevPageBtn">Prev</button>
      <span id="pageInfo"></span>
      <button id="nextPageBtn">Next</button>
      <button id="exportDecodeBtn">Open Text</button>
    </div>
    <table><thead><tr><th>#</th><th>PC</th><th>Event</th><th>Symbol</th><th>Source</th></tr></thead><tbody id="insnBody"></tbody></table>
  </div>
  <div id="tab-history" class="hidden">
    <div class="bar"><button id="exportHistTextBtn">Open Text</button><button id="exportHistJsonBtn">Open JSON</button><button id="saveHistJsonBtn">Save JSON…</button></div>
    <table><thead><tr><th>Kind</th><th>Symbol</th><th>PC</th><th>Source</th></tr></thead><tbody id="histBody"></tbody></table>
  </div>
  <div id="tab-stats" class="hidden">
    <div class="bar"><button id="exportStatsBtn">Open Text</button></div>
    <table><thead><tr><th>%</th><th>Count</th><th>Function</th><th>Source</th></tr></thead><tbody id="statsBody"></tbody></table>
  </div>
  <div id="tab-profile" class="hidden">
    <div class="bar"><button id="exportFoldedBtn">Open Folded</button><button id="saveFoldedBtn">Save Folded…</button><button id="exportSpeedscopeBtn">Open Speedscope JSON</button><button id="saveSpeedscopeBtn">Save Speedscope…</button></div>
    <table><thead><tr><th>%</th><th>Count</th><th>Stack</th></tr></thead><tbody id="profileBody"></tbody></table>
  </div>
  <div id="tab-origin" class="hidden">
    <div class="bar"><button id="exportOriginBtn">Open Text</button></div>
    <div id="originBody"></div>
  </div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const data = ${safeJson};
let activeCoreId = data.cores[0]?.coreId ?? 0;
let currentPage = 0;

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function linkHtml(file, line) {
  if (!file || !line) return '';
  const base = file.split(/[\\\\/]/).pop();
  return '<a class="src" data-file="' + esc(file) + '" data-line="' + line + '">' + esc(base + ':' + line) + '</a>';
}
function activeCore() {
  return data.cores.find(c => c.coreId === activeCoreId) || data.cores[0];
}
document.body.addEventListener('click', (e) => {
  const a = e.target.closest('a.src');
  if (a) {
    vscode.postMessage({ type: 'openLocation', file: a.dataset.file, line: Number(a.dataset.line) });
  }
});
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const name = btn.dataset.tab;
    ['overview','instructions','history','stats','profile','origin'].forEach(t => {
      document.getElementById('tab-' + t).classList.toggle('hidden', t !== name);
    });
  });
});

document.getElementById('title').textContent = data.captureName + ' (' + data.chip + ')';
const sel = document.getElementById('coreSelect');
data.cores.forEach(c => {
  const opt = document.createElement('option');
  opt.value = String(c.coreId);
  opt.textContent = 'Core ' + c.coreId;
  sel.appendChild(opt);
});
sel.addEventListener('change', () => { activeCoreId = Number(sel.value); currentPage = 0; renderAll(); });

function renderOverview(c) {
  const d = c.diag;
  document.getElementById('tab-overview').innerHTML =
    '<div class="cards">' +
    '<div class="card"><div class="num">' + d.instructions + '</div><div>Instructions</div></div>' +
    '<div class="card"><div class="num">' + d.syncs + '</div><div>Syncs</div></div>' +
    '<div class="card"><div class="num">' + d.traps + '</div><div>Traps</div></div>' +
    '<div class="card"><div class="num">' + d.gaps + '</div><div>Gaps</div></div>' +
    '<div class="card"><div class="num">' + d.warnings + '</div><div>Warnings</div></div>' +
    '</div>' +
    '<p><b>Capture:</b> ' + esc(data.capturePath) + '</p>' +
    '<p><b>ELF:</b> ' + esc(data.elfPath) + ' (SHA: ' + esc(c.note.elfShaStatus) + ')</p>' +
    '<p><b>ROM ELF:</b> ' + esc(data.romElfPath) + '</p>';
}
function renderInstructions(pageData) {
  currentPage = pageData.page;
  document.getElementById('pageInfo').textContent = 'Page ' + (pageData.page + 1) + ' / ' + pageData.totalPages + ' (' + pageData.totalMatched + ' rows)';
  document.getElementById('insnBody').innerHTML = pageData.rows.map(r =>
    '<tr class="row-' + esc(r.kind) + '"><td>' + r.index + '</td><td>' + esc(r.pcText) + '</td><td>' + esc(r.detail) + '</td><td>' + esc(r.symbol || '') + '</td><td>' + linkHtml(r.file, r.line) + '</td></tr>'
  ).join('');
}
function renderHistory(c) {
  document.getElementById('histBody').innerHTML = c.history.map(h =>
    '<tr><td>' + esc(h.kind) + '</td><td style="padding-left:' + (8 + Math.min(h.depth, 12) * 14) + 'px">' + esc(h.sym) + '</td><td>' + esc(h.pcText) + '</td><td>' + linkHtml(h.file, h.line) + '</td></tr>'
  ).join('');
}
function renderStats(c) {
  document.getElementById('statsBody').innerHTML = c.stats.map(s =>
    '<tr><td>' + s.pct + '%</td><td>' + s.count + '</td><td>' + esc(s.func) + '</td><td>' + linkHtml(s.file, s.line) + '</td></tr>'
  ).join('');
}
function renderProfile(c) {
  document.getElementById('profileBody').innerHTML = c.profile.map(p =>
    '<tr><td>' + p.pct + '%</td><td>' + p.count + '</td><td>' + esc(p.stack) + '</td></tr>'
  ).join('');
}
function renderStepHtml(s) {
  let meta = 'r' + s.reg + ' ' + esc(s.kind);
  if (s.valueText) meta += ' val=' + esc(s.valueText);
  if (s.instruction) meta += ' "' + esc(s.instruction) + '"';
  if (s.pcText) meta += ' at ' + esc(s.pcText);
  if (s.stop) meta += ' stop=' + esc(s.stop);
  const loc = linkHtml(s.file, s.line);
  const kids = (s.sources || []).map(renderStepHtml).join('');
  return '<li>' + meta + (loc ? ' ' + loc : '') + (kids ? '<ul>' + kids + '</ul>' : '') + '</li>';
}
function renderOrigin(c) {
  const o = c.origin;
  if (!o.hasFault) {
    document.getElementById('originBody').innerHTML = '<p>No fault trap found in capture.</p>';
    return;
  }
  const calls = o.calls.map(x => '<li>' + esc(x.sym) + ' (' + esc(x.pcText) + ') ' + linkHtml(x.file, x.line) + '</li>').join('');
  const branches = o.branches.map(b => '<li>' + esc(b.pcText) + ' ' + (b.taken ? 'taken' : 'not taken') + ' ' + linkHtml(b.file, b.line) + '</li>').join('');
  const regHtml = o.registerRoot ? '<h3>Register Provenance</h3><ul>' + renderStepHtml(o.registerRoot) + '</ul>' : '';
  document.getElementById('originBody').innerHTML =
    '<p><b>Fault:</b> cause=' + o.cause + ' epc=' + esc(o.epcText) + ' ' + esc(o.faultSym || '') + ' ' + linkHtml(o.faultFile, o.faultLine) + ' tval=' + esc(o.tvalText) + ' complete=' + o.windowComplete + '</p>' +
    '<h3>Unreturned Calls (' + o.calls.length + ')</h3><ul>' + (calls || '<li>(none)</li>') + '</ul>' +
    '<h3>Recent Branches (' + o.branches.length + ')</h3><ul>' + (branches || '<li>(none)</li>') + '</ul>' +
    regHtml;
}
function renderAll() {
  const c = activeCore();
  if (!c) return;
  renderOverview(c);
  renderInstructions(c.firstPage);
  renderHistory(c);
  renderStats(c);
  renderProfile(c);
  renderOrigin(c);
}
function reqPage(page, jumpToFault) {
  vscode.postMessage({ type: 'requestInstructions', coreId: activeCoreId, page, pageSize: 500, filter: document.getElementById('insnFilter').value, jumpToFault });
}
document.getElementById('prevPageBtn').addEventListener('click', () => reqPage(Math.max(0, currentPage - 1), false));
document.getElementById('nextPageBtn').addEventListener('click', () => reqPage(currentPage + 1, false));
document.getElementById('jumpFaultBtn').addEventListener('click', () => reqPage(0, true));
document.getElementById('insnFilter').addEventListener('input', () => reqPage(0, false));
document.getElementById('exportDecodeBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', kind: 'decode', coreId: activeCoreId }));
document.getElementById('exportHistTextBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', kind: 'historyText', coreId: activeCoreId }));
document.getElementById('exportHistJsonBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', kind: 'historyJson', coreId: activeCoreId }));
document.getElementById('saveHistJsonBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', kind: 'historyJson', coreId: activeCoreId, saveToFile: true }));
document.getElementById('exportStatsBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', kind: 'stats', coreId: activeCoreId }));
document.getElementById('exportFoldedBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', kind: 'folded', coreId: activeCoreId }));
document.getElementById('saveFoldedBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', kind: 'folded', coreId: activeCoreId, saveToFile: true }));
document.getElementById('exportSpeedscopeBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', kind: 'speedscope', coreId: activeCoreId }));
document.getElementById('saveSpeedscopeBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', kind: 'speedscope', coreId: activeCoreId, saveToFile: true }));
document.getElementById('exportOriginBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', kind: 'origin', coreId: activeCoreId }));

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'instructionsPage' && msg.coreId === activeCoreId) {
    renderInstructions(msg);
  }
});
renderAll();
</script>
</body>
</html>`;
    }
}
