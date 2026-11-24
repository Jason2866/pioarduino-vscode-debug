import * as path from 'path';
import * as vscode from 'vscode';
import { iterEntries } from '../trace/analysis/history';
import { UNRESOLVED_FILE } from '../trace/analysis/stats';
import { TraceCaptureAnalysis, TraceCoreAnalysis } from '../trace/commands';
import { isSyntheticSourcePath } from '../trace/elf/locationPath';

export type TraceTreeNodeKind =
    | 'actions'
    | 'action'
    | 'capture'
    | 'core'
    | 'diagnostics'
    | 'faultGroup'
    | 'hotspots'
    | 'history'
    | 'leaf';

export class TraceTreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly kind: TraceTreeNodeKind,
        public readonly core?: TraceCoreAnalysis,
        public readonly children?: TraceTreeItem[]
    ) {
        super(label, collapsibleState);
        this.contextValue = kind;
    }
}

function fmtAddr(pc: number): string {
    return `0x${(pc >>> 0).toString(16).padStart(8, '0')}`;
}

function makeLocationCommand(
    file: string,
    line: number,
    elfPath?: string
): vscode.Command | undefined {
    if (!file || line <= 0 || isSyntheticSourcePath(file)) {
        return undefined;
    }
    return {
        command: 'platformio-debug.trace.openLocation',
        title: 'Open Source Location',
        arguments: [{ file, line, elfPath }],
    };
}

/** Sidebar TreeDataProvider for ESP32 RISC-V trace captures and analysis. */
export class TraceTreeProvider implements vscode.TreeDataProvider<TraceTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TraceTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private analysis: TraceCaptureAnalysis | undefined;

    setCapture(analysis: TraceCaptureAnalysis | undefined): void {
        this.analysis = analysis;
        this.refresh();
    }

    getCapture(): TraceCaptureAnalysis | undefined {
        return this.analysis;
    }

    clear(): void {
        this.analysis = undefined;
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TraceTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TraceTreeItem): TraceTreeItem[] {
        if (!element) {
            const roots: TraceTreeItem[] = [this.buildActionsNode()];
            if (this.analysis) {
                roots.push(this.buildCaptureNode(this.analysis));
            }
            return roots;
        }
        if (element.children) {
            return element.children;
        }
        return [];
    }

    private buildActionsNode(): TraceTreeItem {
        const items: TraceTreeItem[] = [
            this.actionItem('Load / Inspect Capture…', 'platformio-debug.trace.inspectCapture'),
            this.actionItem('Open Trace Inspector…', 'platformio-debug.trace.openInspector'),
            this.actionItem('Open Capture Folder', 'platformio-debug.trace.openCaptureFolder'),
        ];

        const session = vscode.debug.activeDebugSession;
        if (session && session.type === 'platformio-debug') {
            items.push(
                this.actionItem('Probe OpenOCD Trace', 'platformio-debug.trace.probeCapture'),
                this.actionItem('Start Capture', 'platformio-debug.trace.startCapture'),
                this.actionItem('Stop Capture', 'platformio-debug.trace.stopCapture'),
                this.actionItem('Dump Capture', 'platformio-debug.trace.dumpCapture')
            );
        }

        const group = new TraceTreeItem(
            'Trace Actions',
            vscode.TreeItemCollapsibleState.Expanded,
            'actions',
            undefined,
            items
        );
        return group;
    }

    private actionItem(label: string, command: string): TraceTreeItem {
        const item = new TraceTreeItem(label, vscode.TreeItemCollapsibleState.None, 'action');
        item.command = { command, title: label };
        return item;
    }

    private buildCaptureNode(analysis: TraceCaptureAnalysis): TraceTreeItem {
        const children: TraceTreeItem[] = [
            this.actionItem('Open Full Trace Inspector', 'platformio-debug.trace.openInspector'),
            ...analysis.cores.map((core) => this.buildCoreNode(core, analysis.elfPath)),
        ];
        const node = new TraceTreeItem(
            path.basename(analysis.capturePath),
            vscode.TreeItemCollapsibleState.Expanded,
            'capture',
            undefined,
            children
        );
        node.description = `${analysis.chip} · ${analysis.cores.length} core(s)`;
        node.tooltip = analysis.capturePath;
        return node;
    }

    private buildCoreNode(core: TraceCoreAnalysis, elfPath?: string): TraceTreeItem {
        const children: TraceTreeItem[] = [
            this.buildDiagnosticsNode(core),
            this.buildFaultNode(core, elfPath),
            this.buildHotspotsNode(core, elfPath),
            this.buildHistoryNode(core, elfPath),
        ];
        const node = new TraceTreeItem(
            `Core ${core.coreId}`,
            vscode.TreeItemCollapsibleState.Expanded,
            'core',
            core,
            children
        );
        node.description = `${core.diag.instructions} insns · ${core.diag.traps} traps · ${core.diag.gaps} gaps`;
        return node;
    }

    private buildDiagnosticsNode(core: TraceCoreAnalysis): TraceTreeItem {
        const d = core.diag;
        const rows = [
            `Instructions: ${d.instructions}`,
            `Syncs: ${d.syncs}`,
            `Traps: ${d.traps}`,
            `Gaps: ${d.gaps}`,
            `Warnings: ${d.warnings}`,
            `ELF SHA: ${core.note.elf_sha_status}`,
        ].map((text) => new TraceTreeItem(text, vscode.TreeItemCollapsibleState.None, 'leaf'));

        return new TraceTreeItem(
            'Diagnostics',
            vscode.TreeItemCollapsibleState.Collapsed,
            'diagnostics',
            core,
            rows
        );
    }

    private buildFaultNode(core: TraceCoreAnalysis, elfPath?: string): TraceTreeItem {
        const win = core.origin;
        if (!win.fault) {
            return new TraceTreeItem(
                'Fault & Origin (none)',
                vscode.TreeItemCollapsibleState.None,
                'faultGroup',
                core
            );
        }

        const fault = win.fault;
        const children: TraceTreeItem[] = [];
        const epc = fault.epc;
        const epcSym = epc !== undefined ? core.image?.symbolAt(epc) : undefined;
        const epcLoc = epc !== undefined ? core.resolver.resolve(epc) : undefined;
        const faultItem = new TraceTreeItem(
            `Fault cause=${fault.cause} epc=${epc !== undefined ? fmtAddr(epc) : 'none'}`,
            vscode.TreeItemCollapsibleState.None,
            'leaf'
        );
        if (epcSym || epcLoc) {
            faultItem.description = [epcSym, epcLoc ? `${path.basename(epcLoc.file)}:${epcLoc.line}` : undefined]
                .filter(Boolean)
                .join(' · ');
        }
        if (epcLoc) {
            faultItem.command = makeLocationCommand(epcLoc.file, epcLoc.line, elfPath);
        }
        children.push(faultItem);

        const calls = win.stackCalls(new Map());
        if (calls.length > 0) {
            const callItems = calls.map((call) => {
                const sym = core.image?.symbolAt(call.pc) ?? fmtAddr(call.pc);
                const loc = core.resolver.resolve(call.pc);
                const item = new TraceTreeItem(sym, vscode.TreeItemCollapsibleState.None, 'leaf');
                item.description = loc ? `${path.basename(loc.file)}:${loc.line}` : fmtAddr(call.pc);
                if (loc) {
                    item.command = makeLocationCommand(loc.file, loc.line, elfPath);
                }
                return item;
            });
            children.push(
                new TraceTreeItem(
                    `Unreturned Calls (${calls.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'leaf',
                    core,
                    callItems
                )
            );
        }

        const faultSym = epc !== undefined ? core.image?.symbolAt(epc) : undefined;
        const branches = win.branches(
            faultSym !== undefined ? (pc) => core.image?.symbolAt(pc) === faultSym : () => true
        );
        if (branches.length > 0) {
            const branchItems = branches.map((br) => {
                const loc = core.resolver.resolve(br.pc);
                const item = new TraceTreeItem(
                    `${fmtAddr(br.pc)} (${br.taken ? 'taken' : 'not taken'})`,
                    vscode.TreeItemCollapsibleState.None,
                    'leaf'
                );
                if (loc) {
                    item.description = `${path.basename(loc.file)}:${loc.line}`;
                    item.command = makeLocationCommand(loc.file, loc.line, elfPath);
                }
                return item;
            });
            children.push(
                new TraceTreeItem(
                    `Recent Branches (${branches.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'leaf',
                    core,
                    branchItems
                )
            );
        }

        return new TraceTreeItem(
            'Fault & Origin',
            vscode.TreeItemCollapsibleState.Expanded,
            'faultGroup',
            core,
            children
        );
    }

    private buildHotspotsNode(core: TraceCoreAnalysis, elfPath?: string): TraceTreeItem {
        const total = core.stats.total_instructions || 1;
        const ranked = [...core.stats.sample_hits.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const items = ranked.map(([key, count]) => {
            const [func, file, line] = JSON.parse(key) as [string, string, number];
            const pct = ((100 * count) / total).toFixed(1);
            const item = new TraceTreeItem(func, vscode.TreeItemCollapsibleState.None, 'leaf');
            const locSuffix = file !== UNRESOLVED_FILE && line > 0 ? ` · ${path.basename(file)}:${line}` : '';
            item.description = `${pct}% (${count})${locSuffix}`;
            item.command = makeLocationCommand(file, line, elfPath);
            return item;
        });

        return new TraceTreeItem(
            `Top Hotspots (${items.length})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            'hotspots',
            core,
            items
        );
    }

    private buildHistoryNode(core: TraceCoreAnalysis, elfPath?: string): TraceTreeItem {
        const entries = [...iterEntries(core.history.items)].slice(-20);
        const items = entries.map((entry) => {
            const sym = entry.pc !== undefined ? core.image?.symbolAt(entry.pc) ?? fmtAddr(entry.pc) : entry.kind;
            const loc = entry.pc !== undefined ? core.resolver.resolve(entry.pc) : undefined;
            const indent = '  '.repeat(Math.min(entry.depth, 6));
            const item = new TraceTreeItem(`${indent}${sym}`, vscode.TreeItemCollapsibleState.None, 'leaf');
            item.description = loc ? `${path.basename(loc.file)}:${loc.line}` : entry.kind;
            if (loc) {
                item.command = makeLocationCommand(loc.file, loc.line, elfPath);
            }
            return item;
        });

        return new TraceTreeItem(
            `Call History (${items.length})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            'history',
            core,
            items
        );
    }
}
