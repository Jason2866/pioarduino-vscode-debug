import * as vscode from 'vscode';
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
        channel.appendLine(`Trace capture inspection is not implemented yet: ${uri.fsPath}`);
        vscode.window.showInformationMessage('Trace capture inspection is not implemented yet.');
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
