import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { iterCores, openSession } from '../trace/session';
import {
    CommandOptions,
    CommandResult,
    TraceCaptureAnalysis,
    analyzeCapture,
    decodeCapture,
    historyCapture,
    originCapture,
    profileCapture,
    statsCapture,
} from '../trace/commands';
import { resolveSourceFilePath } from '../trace/elf/locationPath';
import { TraceService } from '../trace/service';
import { ResolveTraceContextOptions, TraceContext, TraceTargetArch } from '../trace/types';
import { TraceDocumentLinkProvider } from './trace_link_provider';
import { TraceTreeProvider } from './trace_tree_provider';
import { TraceExportKind, TraceWebviewPanel } from './trace_webview';

function asTraceTargetArch(value: unknown): TraceTargetArch | undefined {
    return value === 'riscv' || value === 'xtensa' ? value : undefined;
}

/** Frontend integration for ESP32 RISC-V trace commands. */
export class TraceFrontend {
    private readonly service = new TraceService();
    private readonly treeProvider = new TraceTreeProvider();
    private readonly webviewPanel = new TraceWebviewPanel();
    private readonly linkProvider = new TraceDocumentLinkProvider();
    private outputChannel: vscode.OutputChannel | undefined;
    private lastCaptureFile: string | undefined;
    private lastResolvedContext: TraceContext | undefined;
    private inspectorGeneration = 0;

    register(context: vscode.ExtensionContext): vscode.Disposable[] {
        this.outputChannel = vscode.window.createOutputChannel('PlatformIO Debug Trace');
        const disposables: vscode.Disposable[] = [this.outputChannel, this.webviewPanel];

        disposables.push(
            vscode.window.registerTreeDataProvider('platformio-debug.traceView', this.treeProvider),
            vscode.languages.registerDocumentLinkProvider({ scheme: 'untitled' }, this.linkProvider),
            vscode.workspace.onDidCloseTextDocument((doc) => this.linkProvider.untrackDocument(doc.uri)),
            vscode.commands.registerCommand('platformio-debug.trace.resolveContext', this.resolveContext.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.inspectCapture', this.inspectCapture.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.probeCapture', this.probeCapture.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.startCapture', this.startCapture.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.stopCapture', this.stopCapture.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.dumpCapture', this.dumpCapture.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.decode', this.decodeCaptureCmd.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.stats', this.statsCaptureCmd.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.history', this.historyCaptureCmd.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.profile', this.profileCaptureCmd.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.origin', this.originCaptureCmd.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.openCaptureFolder', this.openCaptureFolder.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.openInspector', this.openInspector.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.openLocation', this.openLocation.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.loadCapture', this.loadCapture.bind(this)),
            vscode.commands.registerCommand('platformio-debug.trace.clearCapture', this.clearCapture.bind(this)),
            vscode.debug.onDidStartDebugSession(() => this.treeProvider.refresh()),
            vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
                if (
                    event.session.type === 'platformio-debug' &&
                    event.event === 'stopped' &&
                    this.isEnabled() &&
                    this.getTraceConfig().autoDecodeOnStop === true &&
                    this.lastCaptureFile &&
                    fs.existsSync(this.lastCaptureFile)
                ) {
                    void this.runTraceAnalysisForFile('decode', this.lastCaptureFile, {}, true);
                }
            }),
            vscode.debug.onDidTerminateDebugSession((session) => {
                this.treeProvider.refresh();
                if (
                    session.type === 'platformio-debug' &&
                    this.isEnabled() &&
                    this.getTraceConfig().autoDecodeOnStop === true &&
                    this.lastCaptureFile &&
                    fs.existsSync(this.lastCaptureFile)
                ) {
                    void this.runTraceAnalysisForFile('decode', this.lastCaptureFile, {}, true);
                }
            })
        );

        return disposables;
    }

    private getTraceConfig(): Record<string, any> {
        return vscode.workspace.getConfiguration('platformio-debug').get<Record<string, any>>('trace', {});
    }

    private isEnabled(): boolean {
        return this.getTraceConfig().enabled !== false;
    }

    private ensureEnabled(): boolean {
        if (this.isEnabled()) {
            return true;
        }
        vscode.window.showInformationMessage('ESP32 trace features are disabled (platformio-debug.trace.enabled).');
        return false;
    }

    private async resolveContext(): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const channel = this.requireOutputChannel();
        try {
            const options = await this.buildResolveOptions();
            const traceContext = await this.service.resolveContext(options);
            this.printContext(channel, traceContext);
            if (traceContext.warnings.length > 0) {
                vscode.window.showWarningMessage(
                    `Trace context resolved with ${traceContext.warnings.length} warning(s). See PlatformIO Debug Trace output.`
                );
            } else {
                vscode.window.showInformationMessage(
                    `Trace context resolved for ${traceContext.elfPath ?? 'unknown ELF'}`
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Failed to resolve trace context: ${message}`);
            vscode.window.showErrorMessage(`Failed to resolve trace context: ${message}`);
        }
    }

    private async inspectCapture(): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const channel = this.requireOutputChannel();
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'ESP Trace': ['esptrace', 'elf'], 'All files': ['*'] },
            title: 'Select ESP trace capture',
        });
        const uri = uris?.[0];
        if (!uri) {
            return;
        }
        channel.appendLine(`Inspecting trace capture: ${uri.fsPath}`);
        try {
            const options = await this.resolveToolchainOptions(channel);
            const session = openSession(uri.fsPath, {
                elfPath: options.elfPath,
                chip: options.chip,
                warn: (message) => channel.appendLine(`Warning: ${message}`),
            });
            const cap = session.cap;
            channel.appendLine(`Capture: ${cap.source_path}`);
            channel.appendLine(`Chip: ${session.chip} (target_id=${cap.target_id ?? 'n/a'})`);
            channel.appendLine(`Cores: ${cap.cores.map((c) => c.core_id).join(', ') || '(none)'}`);
            channel.appendLine(`Snapshot ABI: ${cap.abi_major}.${cap.abi_minor}`);
            for (const view of iterCores(session)) {
                const buffers = view.session.cap.cores.filter((c) => c.core_id === view.core.core_id);
                channel.appendLine(
                    `Core ${view.core.core_id}: head_offset=${view.core.head_offset} ` +
                        `head_valid=${view.core.head_valid} buffers=${buffers.length}`
                );
            }
            try {
                const config = this.getTraceConfig();
                const core =
                    typeof config.core === 'number' && Number.isInteger(config.core) && config.core >= 0
                        ? config.core
                        : undefined;
                const analysis = await analyzeCapture(uri.fsPath, {
                    elfPath: options.elfPath,
                    addr2linePath: options.addr2linePath,
                    gdbPath: options.gdbPath,
                    core,
                    chip: options.chip,
                    romElfPath: options.romElfPath,
                    romElfPathHint: options.romElfPathHint,
                    warn: (message) => channel.appendLine(`Warning: ${message}`),
                });
                if (analysis) {
                    this.treeProvider.setCapture(analysis);
                }
            } catch {
                // Keep openSession inspection working even if full analysis requires an ELF.
            }
            channel.show(true);
            vscode.window.showInformationMessage(
                `Trace capture loaded: ${session.chip}, ${cap.cores.length} core(s).`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Failed to inspect capture: ${message}`);
            channel.show(true);
            vscode.window.showErrorMessage(`Failed to inspect trace capture: ${message}`);
        }
    }

    private requireDebugSession(): vscode.DebugSession {
        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== 'platformio-debug') {
            throw new Error('No active platformio-debug session. Start a debug session first.');
        }
        return session;
    }

    private async traceRequest(command: string, args?: any): Promise<any> {
        const channel = this.requireOutputChannel();
        channel.appendLine(`> ${command} ${args ? JSON.stringify(args) : ''}`);
        let session: vscode.DebugSession;
        try {
            session = this.requireDebugSession();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Trace command ${command} failed: ${message}`);
            channel.show(true);
            throw error;
        }
        try {
            const result = await session.customRequest(command, args ?? {});
            const output = result && result.output ? result.output : '';
            if (output) {
                channel.appendLine(output);
            }
            channel.show(true);
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Trace command ${command} failed: ${message}`);
            channel.show(true);
            throw error;
        }
    }

    private async probeCapture(): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const channel = this.requireOutputChannel();
        try {
            const result = await this.traceRequest('trace-probe');
            const output = (result && result.output ? result.output : '').trim();
            if (output && !/unknown command|invalid command|unrecognized/i.test(output)) {
                vscode.window.showInformationMessage('OpenOCD riscv_trace commands appear to be available.');
            } else {
                vscode.window.showWarningMessage(
                    'OpenOCD does not recognize `esp riscv_trace`. It needs a build with CONFIG_ESP_RISCV_TRACE_OPENOCD.'
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Trace probe failed: ${message}`);
            vscode.window.showErrorMessage(`Trace probe failed: ${message}`);
        }
    }

    private async openCaptureFile(title: string): Promise<string | undefined> {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'ESP Trace': ['esptrace', 'elf'], 'All files': ['*'] },
            title,
        });
        return uris?.[0]?.fsPath;
    }

    private resolveCaptureDir(): string | undefined {
        const config = this.getTraceConfig();
        const raw = typeof config.captureDir === 'string' && config.captureDir.trim() !== ''
            ? config.captureDir.trim()
            : path.join('.pio', 'debug-trace');
        if (path.isAbsolute(raw)) {
            return raw;
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return workspaceFolder ? path.join(workspaceFolder, raw) : undefined;
    }

    private async openCaptureFolder(): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const dir = this.resolveCaptureDir();
        if (!dir) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            return;
        }
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch {
            // Fall through to openExternal even if mkdir fails.
        }
        await vscode.env.openExternal(vscode.Uri.file(dir));
    }

    private async pickCaptureFile(defaultName: string): Promise<string | undefined> {
        const dir = this.resolveCaptureDir();
        if (dir) {
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch {
                // Ignore directory creation errors and still show the save dialog.
            }
        }
        const uris = await vscode.window.showSaveDialog({
            defaultUri: dir
                ? vscode.Uri.file(path.join(dir, defaultName))
                : undefined,
            filters: { 'ESP Trace': ['esptrace'], 'All files': ['*'] },
            title: 'ESP trace capture file',
        });
        return uris?.fsPath;
    }

    private async startCapture(): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const channel = this.requireOutputChannel();
        try {
            this.requireDebugSession();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Trace start failed: ${message}`);
            channel.show(true);
            vscode.window.showErrorMessage(`Trace start failed: ${message}`);
            return;
        }
        const file = await this.pickCaptureFile(`trace-${Date.now()}.esptrace`);
        if (!file) {
            return;
        }
        const config = this.getTraceConfig();
        const timeoutMs = typeof config.captureTimeoutMs === 'number' ? config.captureTimeoutMs : undefined;
        const mode = config.mode === 'loop' ? 'loop' : 'loop';
        try {
            await this.traceRequest('trace-start', { file, timeoutMs, mode });
            this.lastCaptureFile = file;
            vscode.window.showInformationMessage(`Trace capture started: ${file}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Trace start failed: ${message}`);
        }
    }

    private async stopCapture(): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const channel = this.requireOutputChannel();
        try {
            await this.traceRequest('trace-stop');
            vscode.window.showInformationMessage('Trace capture stopped.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Trace stop failed: ${message}`);
            vscode.window.showErrorMessage(`Trace stop failed: ${message}`);
        }
    }

    private async dumpCapture(): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const channel = this.requireOutputChannel();
        try {
            this.requireDebugSession();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Trace dump failed: ${message}`);
            channel.show(true);
            vscode.window.showErrorMessage(`Trace dump failed: ${message}`);
            return;
        }
        const file = await this.pickCaptureFile(`trace-dump-${Date.now()}.esptrace`);
        if (!file) {
            return;
        }
        try {
            await this.traceRequest('trace-dump', { file });
            this.lastCaptureFile = file;
            vscode.window.showInformationMessage(`Trace buffers dumped to ${file}`);
            if (this.getTraceConfig().autoDecodeOnStop === true && fs.existsSync(file)) {
                void this.runTraceAnalysisForFile('decode', file, {}, true);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Trace dump failed: ${message}`);
        }
    }

    // ------------------------------------------------------------------
    // Decode / stats / history / profile
    // ------------------------------------------------------------------

    private async decodeCaptureCmd(): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const scope = await vscode.window.showQuickPick(
            [
                { label: 'Full decode', last: undefined as number | undefined },
                { label: 'Last 50 instructions before the fault', last: 50 },
                { label: 'Last 200 instructions before the fault', last: 200 },
                { label: 'Last 1000 instructions before the fault', last: 1000 },
            ],
            { title: 'ESP trace decode scope', placeHolder: 'How much of the trace to decode' }
        );
        if (scope === undefined) {
            return;
        }
        await this.runTraceAnalysis('decode', { last: scope.last }, true);
    }

    private async statsCaptureCmd(): Promise<void> {
        await this.runTraceAnalysis('stats', {}, false);
    }

    private async historyCaptureCmd(): Promise<void> {
        await this.runTraceAnalysis('history', {}, false);
    }

    private async profileCaptureCmd(): Promise<void> {
        await this.runTraceAnalysis('profile', {}, true);
    }

    private async originCaptureCmd(): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const file = await this.openCaptureFile('Select trace capture to origin');
        if (!file) {
            return;
        }
        const regInfo = await this.readActiveSessionRegisters(file);
        await this.runTraceAnalysisForFile(
            'origin',
            file,
            {
                registersByCore: regInfo?.registersByCore,
                registerNote: regInfo && !regInfo.verified ? 'unverified - sourced from active debug session' : undefined,
            },
            true
        );
    }

    private async runTraceAnalysis(
        kind: 'decode' | 'stats' | 'history' | 'profile' | 'origin',
        extra: Partial<CommandOptions>,
        asDocument: boolean
    ): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const file = await this.openCaptureFile(`Select trace capture to ${kind}`);
        if (!file) {
            return;
        }
        await this.runTraceAnalysisForFile(kind, file, extra, asDocument);
    }

    private async runTraceAnalysisForFile(
        kind: 'decode' | 'stats' | 'history' | 'profile' | 'origin',
        file: string,
        extra: Partial<CommandOptions>,
        asDocument: boolean
    ): Promise<void> {
        const channel = this.requireOutputChannel();
        channel.appendLine(`> ${kind} ${file}`);
        try {
            const options = await this.resolveToolchainOptions(channel);
            const config = this.getTraceConfig();
            const core =
                typeof config.core === 'number' && Number.isInteger(config.core) && config.core >= 0
                    ? config.core
                    : undefined;
            const cmdOptions: CommandOptions = {
                elfPath: options.elfPath,
                addr2linePath: options.addr2linePath,
                gdbPath: options.gdbPath,
                core,
                chip: options.chip,
                romElfPath: options.romElfPath,
                romElfPathHint: options.romElfPathHint,
                warn: (message) => channel.appendLine(`Warning: ${message}`),
                ...extra,
            };
            if (kind === 'profile' && cmdOptions.profileFormat === undefined) {
                cmdOptions.profileFormat = config.profileFormat === 'speedscope' ? 'speedscope' : 'folded';
            }
            if (kind === 'history' && cmdOptions.asJson === undefined && config.historyJson === true) {
                cmdOptions.asJson = true;
            }

            let result: CommandResult;
            if (kind === 'decode') {
                result = await decodeCapture(file, cmdOptions);
            } else if (kind === 'stats') {
                result = await statsCapture(file, cmdOptions);
            } else if (kind === 'history') {
                result = await historyCapture(file, cmdOptions);
            } else if (kind === 'origin') {
                result = await originCapture(file, cmdOptions);
            } else {
                result = await profileCapture(file, cmdOptions);
            }

            if (result.summary !== undefined) {
                channel.appendLine(result.summary);
            }
            const text = result.lines.join('\n') + '\n';
            if (asDocument) {
                const doc = await vscode.workspace.openTextDocument({
                    content: text,
                    language: kind === 'profile' && cmdOptions.profileFormat === 'speedscope' ? 'json' : 'plaintext',
                });
                if ((kind === 'decode' || kind === 'origin') && doc && doc.uri) {
                    this.linkProvider.trackDocument(doc.uri);
                }
                await vscode.window.showTextDocument(doc, { preview: false });
            } else {
                channel.append(text);
                channel.show(true);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`${kind} failed: ${message}`);
            channel.show(true);
            vscode.window.showErrorMessage(`Trace ${kind} failed: ${message}`);
        }
    }

    private async loadCapture(): Promise<void> {
        await this.openInspectorWithCapture(true);
    }

    private clearCapture(): void {
        this.inspectorGeneration++;
        this.treeProvider.clear();
        this.webviewPanel.dispose();
    }

    private async openInspector(): Promise<void> {
        await this.openInspectorWithCapture(false);
    }

    private async openInspectorWithCapture(forcePick: boolean): Promise<void> {
        if (!this.ensureEnabled()) {
            return;
        }
        const gen = ++this.inspectorGeneration;
        const channel = this.requireOutputChannel();
        let analysis: TraceCaptureAnalysis | undefined = forcePick ? undefined : this.treeProvider.getCapture();
        if (!analysis) {
            const file = await this.openCaptureFile('Select trace capture to inspect');
            if (!file || gen !== this.inspectorGeneration) {
                return;
            }
            try {
                const options = await this.resolveToolchainOptions(channel);
                if (gen !== this.inspectorGeneration) {
                    return;
                }
                const config = this.getTraceConfig();
                const core =
                    typeof config.core === 'number' && Number.isInteger(config.core) && config.core >= 0
                        ? config.core
                        : undefined;
                analysis = await analyzeCapture(file, {
                    elfPath: options.elfPath,
                    addr2linePath: options.addr2linePath,
                    gdbPath: options.gdbPath,
                    core,
                    chip: options.chip,
                    romElfPath: options.romElfPath,
                    romElfPathHint: options.romElfPathHint,
                    warn: (message) => channel.appendLine(`Warning: ${message}`),
                });
                if (gen !== this.inspectorGeneration) {
                    return;
                }
                this.treeProvider.setCapture(analysis);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                channel.appendLine(`openInspector failed: ${message}`);
                channel.show(true);
                vscode.window.showErrorMessage(`Trace inspector failed: ${message}`);
                return;
            }
        }

        const capturePath = analysis.capturePath;
        const regInfo = await this.readActiveSessionRegisters(capturePath, analysis.cores.map((c) => c.coreId));
        if (gen !== this.inspectorGeneration) {
            return;
        }
        const registerNote = regInfo && !regInfo.verified ? 'unverified - sourced from active debug session' : undefined;
        const loadedElfPath = analysis.elfPath;
        const loadedRomElfPath = analysis.romElfPath;
        this.webviewPanel.show(
            analysis,
            {
                onOpenLocation: (file, line, elfPath) => {
                    void this.openLocation({ file, line, elfPath });
                },
                onExport: (kind: TraceExportKind, coreId: number, saveToFile?: boolean) => {
                    const baseExtra: Partial<CommandOptions> = {
                        core: coreId,
                        elfPath: loadedElfPath,
                        romElfPath: loadedRomElfPath,
                    };
                    const mapKind: Record<
                        TraceExportKind,
                        { cmd: 'decode' | 'stats' | 'history' | 'profile' | 'origin'; extra: Partial<CommandOptions>; ext: string }
                    > = {
                        decode: { cmd: 'decode', extra: baseExtra, ext: 'txt' },
                        stats: { cmd: 'stats', extra: baseExtra, ext: 'txt' },
                        historyText: { cmd: 'history', extra: { ...baseExtra, asJson: false }, ext: 'txt' },
                        historyJson: { cmd: 'history', extra: { ...baseExtra, asJson: true }, ext: 'json' },
                        folded: { cmd: 'profile', extra: { ...baseExtra, profileFormat: 'folded' }, ext: 'folded' },
                        speedscope: { cmd: 'profile', extra: { ...baseExtra, profileFormat: 'speedscope' }, ext: 'speedscope.json' },
                        origin: {
                            cmd: 'origin',
                            extra: {
                                ...baseExtra,
                                registersByCore: regInfo?.registersByCore,
                                registerNote,
                            },
                            ext: 'txt',
                        },
                    };
                    const entry = mapKind[kind];
                    if (!entry) {
                        return;
                    }
                    if (saveToFile) {
                        void this.saveTraceExport(entry.cmd, capturePath, entry.extra, entry.ext);
                    } else {
                        void this.runTraceAnalysisForFile(entry.cmd, capturePath, entry.extra, true);
                    }
                },
            },
            regInfo?.registersByCore,
            registerNote
        );
    }

    private async saveTraceExport(
        kind: 'decode' | 'stats' | 'history' | 'profile' | 'origin',
        capturePath: string,
        extra: Partial<CommandOptions>,
        ext: string
    ): Promise<void> {
        const channel = this.requireOutputChannel();
        const defaultName = `${path.basename(capturePath, path.extname(capturePath))}.${kind}.${ext}`;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const uri = await vscode.window.showSaveDialog({
            defaultUri: workspaceFolder ? vscode.Uri.file(path.join(workspaceFolder, defaultName)) : undefined,
            title: `Save trace ${kind} export`,
        });
        if (!uri) {
            return;
        }
        try {
            const options = await this.resolveToolchainOptions(channel);
            const cmdOptions: CommandOptions = {
                elfPath: options.elfPath,
                addr2linePath: options.addr2linePath,
                gdbPath: options.gdbPath,
                chip: options.chip,
                romElfPath: options.romElfPath,
                romElfPathHint: options.romElfPathHint,
                warn: (message) => channel.appendLine(`Warning: ${message}`),
                ...extra,
            };
            let result: CommandResult;
            if (kind === 'decode') {
                result = await decodeCapture(capturePath, cmdOptions);
            } else if (kind === 'stats') {
                result = await statsCapture(capturePath, cmdOptions);
            } else if (kind === 'history') {
                result = await historyCapture(capturePath, cmdOptions);
            } else if (kind === 'origin') {
                result = await originCapture(capturePath, cmdOptions);
            } else {
                result = await profileCapture(capturePath, cmdOptions);
            }
            fs.writeFileSync(uri.fsPath, result.lines.join('\n') + '\n', 'utf-8');
            vscode.window.showInformationMessage(`Saved trace export to ${uri.fsPath}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Export failed: ${message}`);
            vscode.window.showErrorMessage(`Trace export failed: ${message}`);
        }
    }

    private async readActiveSessionRegisters(
        capturePath?: string,
        knownCoreIds?: readonly number[]
    ): Promise<{ registersByCore: Map<number, Map<number, number>>; verified: boolean } | undefined> {
        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== 'platformio-debug') {
            return undefined;
        }
        const abiNames: Record<string, number> = {
            zero: 0, ra: 1, sp: 2, gp: 3, tp: 4,
            t0: 5, t1: 6, t2: 7, s0: 8, fp: 8, s1: 9,
            a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a5: 15, a6: 16, a7: 17,
            s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23, s8: 24, s9: 25, s10: 26, s11: 27,
            t3: 28, t4: 29, t5: 30, t6: 31,
        };
        try {
            const threadsResp = await session.customRequest('threads');
            const threads: Array<{ id: number; name?: string }> = threadsResp?.threads ?? [];
            if (threads.length === 0) {
                return undefined;
            }
            const registersByCore = new Map<number, Map<number, number>>();
            for (const thread of threads) {
                if (typeof thread?.id !== 'number') {
                    continue;
                }
                const match = /(?:cpu|core)\s*#?(\d+)/i.exec(String(thread.name ?? ''));
                let coreId: number | undefined = match ? parseInt(match[1], 10) : undefined;
                if (coreId === undefined && threads.length === 1) {
                    if (!knownCoreIds || knownCoreIds.length === 1) {
                        coreId = knownCoreIds?.[0] ?? 0;
                    }
                }
                if (coreId === undefined) {
                    continue;
                }
                const stack = await session.customRequest('stackTrace', { threadId: thread.id, startFrame: 0, levels: 1 });
                const frameId = stack?.stackFrames?.[0]?.id;
                if (typeof frameId !== 'number') {
                    continue;
                }
                const scopes = await session.customRequest('scopes', { frameId });
                const regScope = (scopes?.scopes ?? []).find((s: any) => /register/i.test(String(s.name)));
                if (!regScope?.variablesReference) {
                    continue;
                }
                const vars = await session.customRequest('variables', { variablesReference: regScope.variablesReference });
                const regs = new Map<number, number>();
                for (const v of vars?.variables ?? []) {
                    const name = String(v.name ?? '').trim().toLowerCase();
                    let idx = abiNames[name];
                    if (idx === undefined && /^x(\d+)$/.test(name)) {
                        idx = parseInt(name.slice(1), 10);
                    }
                    if (idx === undefined || idx < 0 || idx > 31) {
                        continue;
                    }
                    const val = Number(v.value);
                    if (Number.isFinite(val)) {
                        regs.set(idx, val >>> 0);
                    }
                }
                if (regs.size > 0) {
                    registersByCore.set(coreId, regs);
                }
            }
            if (registersByCore.size === 0) {
                return undefined;
            }
            const verified = Boolean(capturePath && this.lastCaptureFile && capturePath === this.lastCaptureFile);
            return { registersByCore, verified };
        } catch {
            return undefined;
        }
    }

    private async openLocation(arg?: { file?: string; line?: number; elfPath?: string }): Promise<void> {
        if (!arg || typeof arg.file !== 'string' || !arg.file.trim()) {
            return;
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const roots: string[] = [];
        if (workspaceFolder) {
            roots.push(workspaceFolder);
        }
        if (arg.elfPath) {
            roots.push(path.dirname(arg.elfPath));
        }
        if (this.lastResolvedContext?.packagesDir) {
            const pkgDir = this.lastResolvedContext.packagesDir;
            roots.push(
                pkgDir,
                path.join(pkgDir, 'framework-espidf'),
                path.join(pkgDir, 'framework-arduinoespressif32')
            );
        }
        if (this.lastResolvedContext?.idfPath) {
            roots.push(this.lastResolvedContext.idfPath);
        }
        if (process.env.IDF_PATH) {
            roots.push(process.env.IDF_PATH);
        }
        const resolved = resolveSourceFilePath(arg.file, roots);
        if (!resolved) {
            vscode.window.showWarningMessage(`Source file not found: ${arg.file}`);
            return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
        const lineZero = Math.max(0, (typeof arg.line === 'number' && Number.isFinite(arg.line) ? Math.floor(arg.line) : 1) - 1);
        const range = new vscode.Range(lineZero, 0, lineZero, 0);
        await vscode.window.showTextDocument(doc, { selection: range, preview: true });
    }

    /**
     * Build resolve options, then run PlatformIO toolchain discovery so the
     * analysis commands get the discovered ELF/addr2line paths even when the
     * `platformio-debug.trace.*` settings are empty. Falls back to the
     * configured values when discovery fails.
     */
    private async resolveToolchainOptions(
        channel: vscode.OutputChannel
    ): Promise<ResolveTraceContextOptions & { romElfPathHint?: string }> {
        const options = await this.buildResolveOptions();
        try {
            const context = await this.service.resolveContext(options);
            this.lastResolvedContext = context;
            for (const warning of context.warnings) {
                channel.appendLine(`Warning: ${warning}`);
            }
            return {
                ...options,
                elfPath: context.elfPath ?? options.elfPath,
                // chip stays the explicitly configured value only: the
                // discovered context.chip describes the workspace ELF, not
                // necessarily the capture being decoded.
                // romElfPath likewise stays the explicit setting; the
                // discovered ROM ELF travels as a revision-checked hint so it
                // cannot bypass the capture's chip-revision selection.
                romElfPathHint: context.romElfPath,
                addr2linePath: context.addr2linePath ?? options.addr2linePath,
                gdbPath: context.gdbPath ?? options.gdbPath,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Trace context resolution failed, using configured paths: ${message}`);
            return options;
        }
    }

    private async buildResolveOptions(): Promise<ResolveTraceContextOptions> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
            throw new Error('No workspace folder is open.');
        }

        let debugArgs: any = {};
        const session = vscode.debug.activeDebugSession;
        if (session && session.type === 'platformio-debug') {
            try {
                debugArgs = await session.customRequest('get-arguments');
            } catch {
                // Fall back to workspace-only resolution.
            }
        }

        const config = vscode.workspace.getConfiguration('platformio-debug').get<Record<string, any>>('trace', {});
        // Contributed settings default to "" — treat empty strings as unset so
        // PlatformIO discovery and active-session values can apply.
        const str = (value: unknown): string | undefined =>
            typeof value === 'string' && value.trim() !== '' ? value : undefined;
        return {
            workspaceFolder: debugArgs.cwd ?? workspaceFolder,
            executable: debugArgs.executable,
            projectEnvName: debugArgs.projectEnvName,
            envName: debugArgs.envName ?? debugArgs.projectEnvName,
            elfPath: str(config.elfPath),
            chip: str(config.chip),
            targetArch: asTraceTargetArch(config.targetArch),
            coreDir: str(config.coreDir),
            packagesDir: str(config.packagesDir),
            buildDir: str(config.buildDir),
            gdbPath: str(config.gdbPath),
            addr2linePath: str(config.addr2linePath),
            openocdPath: str(config.openocdPath),
            romElfPath: str(config.romElfPath),
            usePlatformIOConfig: config.usePlatformIOConfig !== false,
        };
    }

    private printContext(channel: vscode.OutputChannel, context: TraceContext): void {
        channel.appendLine('ESP32 trace context:');
        channel.appendLine(JSON.stringify(context, null, 2));
        for (const warning of context.warnings) {
            channel.appendLine(`Warning: ${warning}`);
        }
        channel.show(true);
    }

    private requireOutputChannel(): vscode.OutputChannel {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('PlatformIO Debug Trace');
        }
        return this.outputChannel;
    }
}
