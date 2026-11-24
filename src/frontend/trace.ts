import * as vscode from 'vscode';
import { iterCores, openSession } from '../trace/session';
import { CommandOptions, CommandResult, decodeCapture, historyCapture, profileCapture, statsCapture } from '../trace/commands';
import { TraceService } from '../trace/service';
import { ResolveTraceContextOptions, TraceContext, TraceTargetArch } from '../trace/types';

function asTraceTargetArch(value: unknown): TraceTargetArch | undefined {
    return value === 'riscv' || value === 'xtensa' ? value : undefined;
}

/** Frontend integration for ESP32 RISC-V trace commands. */
export class TraceFrontend {
    private readonly service = new TraceService();
    private outputChannel: vscode.OutputChannel | undefined;

    register(context: vscode.ExtensionContext): vscode.Disposable[] {
        this.outputChannel = vscode.window.createOutputChannel('PlatformIO Debug Trace');
        const disposables: vscode.Disposable[] = [this.outputChannel];

        disposables.push(
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
        );

        return disposables;
    }

    private async resolveContext(): Promise<void> {
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
            const options = await this.buildResolveOptions();
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
        const session = this.requireDebugSession();
        const channel = this.requireOutputChannel();
        channel.appendLine(`> ${command} ${args ? JSON.stringify(args) : ''}`);
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

    private async pickCaptureFile(defaultName: string): Promise<string | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const uris = await vscode.window.showSaveDialog({
            defaultUri: workspaceFolder
                ? vscode.Uri.file(`${workspaceFolder}/.pio/${defaultName}`)
                : undefined,
            filters: { 'ESP Trace': ['esptrace'], 'All files': ['*'] },
            title: 'ESP trace capture file',
        });
        return uris?.[0]?.fsPath;
    }

    private async startCapture(): Promise<void> {
        const file = await this.pickCaptureFile(`trace-${Date.now()}.esptrace`);
        if (!file) {
            return;
        }
        const config = vscode.workspace.getConfiguration('platformio-debug').get<Record<string, any>>('trace', {});
        const timeoutMs = typeof config.captureTimeoutMs === 'number' ? config.captureTimeoutMs : undefined;
        try {
            await this.traceRequest('trace-start', { file, timeoutMs });
            vscode.window.showInformationMessage(`Trace capture started: ${file}`);
        } catch {
            // Error already reported to the trace output channel.
        }
    }

    private async stopCapture(): Promise<void> {
        const channel = this.requireOutputChannel();
        try {
            await this.traceRequest('trace-stop');
            vscode.window.showInformationMessage('Trace capture stopped.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            channel.appendLine(`Trace stop failed: ${message}`);
        }
    }

    private async dumpCapture(): Promise<void> {
        const file = await this.pickCaptureFile(`trace-dump-${Date.now()}.esptrace`);
        if (!file) {
            return;
        }
        try {
            await this.traceRequest('trace-dump', { file });
            vscode.window.showInformationMessage(`Trace buffers dumped to ${file}`);
        } catch {
            // Error already reported to the trace output channel.
        }
    }

    // ------------------------------------------------------------------
    // Decode / stats / history / profile
    // ------------------------------------------------------------------

    private async decodeCaptureCmd(): Promise<void> {
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

    private async runTraceAnalysis(
        kind: 'decode' | 'stats' | 'history' | 'profile',
        extra: Partial<CommandOptions>,
        asDocument: boolean
    ): Promise<void> {
        const channel = this.requireOutputChannel();
        const file = await this.openCaptureFile(`Select trace capture to ${kind}`);
        if (!file) {
            return;
        }
        channel.appendLine(`> ${kind} ${file}`);
        try {
            const options = await this.buildResolveOptions();
            const config = vscode.workspace.getConfiguration('platformio-debug').get<Record<string, any>>('trace', {});
            const cmdOptions: CommandOptions = {
                elfPath: options.elfPath,
                addr2linePath: options.addr2linePath,
                chip: options.chip,
                romElfPath: options.romElfPath,
                warn: (message) => channel.appendLine(`Warning: ${message}`),
                ...extra,
            };
            if (kind === 'profile') {
                cmdOptions.profileFormat = config.profileFormat === 'speedscope' ? 'speedscope' : 'folded';
            }
            if (kind === 'history' && config.historyJson === true) {
                cmdOptions.asJson = true;
            }

            let result: CommandResult;
            if (kind === 'decode') {
                result = await decodeCapture(file, cmdOptions);
            } else if (kind === 'stats') {
                result = await statsCapture(file, cmdOptions);
            } else if (kind === 'history') {
                result = await historyCapture(file, cmdOptions);
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
        return {
            workspaceFolder: debugArgs.cwd ?? workspaceFolder,
            executable: debugArgs.executable,
            projectEnvName: debugArgs.projectEnvName,
            envName: debugArgs.envName ?? debugArgs.projectEnvName,
            elfPath: config.elfPath,
            chip: config.chip,
            targetArch: asTraceTargetArch(config.targetArch),
            coreDir: config.coreDir,
            packagesDir: config.packagesDir,
            buildDir: config.buildDir,
            gdbPath: config.gdbPath,
            addr2linePath: config.addr2linePath,
            openocdPath: config.openocdPath,
            romElfPath: config.romElfPath,
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
