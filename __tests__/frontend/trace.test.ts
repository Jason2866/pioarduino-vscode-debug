import * as vscode from 'vscode';
import { TraceFrontend } from '../../src/frontend/trace';
import { resolveTraceContext } from '../../src/trace/pioToolchain';
import { openSession, iterCores } from '../../src/trace/session';
import { decodeCapture, statsCapture, historyCapture, profileCapture } from '../../src/trace/commands';
import { TraceContext } from '../../src/trace/types';

jest.mock('../../src/trace/pioToolchain', () => ({
    resolveTraceContext: jest.fn(),
}));

jest.mock('../../src/trace/session', () => ({
    openSession: jest.fn(),
    iterCores: jest.fn(() => []),
}));

jest.mock('../../src/trace/commands', () => ({
    decodeCapture: jest.fn(),
    statsCapture: jest.fn(),
    historyCapture: jest.fn(),
    profileCapture: jest.fn(),
}));

const mockedResolveContext = resolveTraceContext as jest.MockedFunction<typeof resolveTraceContext>;
const mockedOpenSession = openSession as jest.MockedFunction<typeof openSession>;
const mockedDecode = decodeCapture as jest.MockedFunction<typeof decodeCapture>;
const mockedStats = statsCapture as jest.MockedFunction<typeof statsCapture>;
const mockedHistory = historyCapture as jest.MockedFunction<typeof historyCapture>;
const mockedProfile = profileCapture as jest.MockedFunction<typeof profileCapture>;

const TRACE_COMMANDS = [
    'platformio-debug.trace.resolveContext',
    'platformio-debug.trace.inspectCapture',
    'platformio-debug.trace.probeCapture',
    'platformio-debug.trace.startCapture',
    'platformio-debug.trace.stopCapture',
    'platformio-debug.trace.dumpCapture',
    'platformio-debug.trace.decode',
    'platformio-debug.trace.stats',
    'platformio-debug.trace.history',
    'platformio-debug.trace.profile',
];

describe('TraceFrontend', () => {
    let frontend: TraceFrontend;
    let handlers: Map<string, (...args: any[]) => any>;
    let channel: { appendLine: jest.Mock; append: jest.Mock; show: jest.Mock };

    let traceConfig: Record<string, any> = {};
    const configGet = jest.fn((key: string, def?: any) => (key === 'trace' ? traceConfig : def));

    beforeEach(() => {
        jest.clearAllMocks();
        handlers = new Map();
        channel = {
            appendLine: jest.fn(),
            append: jest.fn(),
            show: jest.fn(),
        };
        (vscode.window.createOutputChannel as jest.Mock).mockReturnValue(channel);
        (vscode.commands.registerCommand as jest.Mock).mockImplementation((id: string, cb: any) => {
            handlers.set(id, cb);
            return { dispose: jest.fn() };
        });
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({ get: configGet });
        traceConfig = {};
        configGet.mockImplementation((key: string, def?: any) => (key === 'trace' ? traceConfig : def));
        (vscode.workspace.workspaceFolders as any) = [{ uri: { fsPath: '/ws' } }];
        (vscode.debug as any).activeDebugSession = undefined;
        (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue(undefined);
        (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(undefined);
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

        frontend = new TraceFrontend();
        frontend.register({} as any);
    });

    const invoke = (id: string) => handlers.get(id)!();

    describe('register', () => {
        test('creates the output channel and registers all trace commands', () => {
            expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('PlatformIO Debug Trace');
            for (const id of TRACE_COMMANDS) {
                expect(handlers.has(id)).toBe(true);
            }
        });
    });

    describe('resolveContext', () => {
        test('prints the resolved context and reports success', async () => {
            const ctx = { elfPath: '/ws/.pio/build/env/firmware.elf', chip: 'esp32c6', warnings: [] } as TraceContext;
            mockedResolveContext.mockResolvedValue(ctx);
            await invoke('platformio-debug.trace.resolveContext');
            expect(mockedResolveContext).toHaveBeenCalledWith(
                expect.objectContaining({ workspaceFolder: '/ws', usePlatformIOConfig: true })
            );
            expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('ESP32 trace context:'));
            expect(vscode.window.showInformationMessage).toHaveBeenCalled();
        });

        test('warns when the context has warnings', async () => {
            mockedResolveContext.mockResolvedValue({ elfPath: '/x.elf', warnings: ['w1', 'w2'] } as TraceContext);
            await invoke('platformio-debug.trace.resolveContext');
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('2 warning'));
        });

        test('reports failure without a workspace folder', async () => {
            (vscode.workspace.workspaceFolders as any) = undefined;
            await invoke('platformio-debug.trace.resolveContext');
            expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('Failed to resolve trace context'));
            expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        });

        test('reports resolver errors', async () => {
            mockedResolveContext.mockRejectedValue(new Error('no ELF'));
            await invoke('platformio-debug.trace.resolveContext');
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('no ELF'));
        });
    });

    describe('inspectCapture', () => {
        test('does nothing when the dialog is cancelled', async () => {
            await invoke('platformio-debug.trace.inspectCapture');
            expect(mockedOpenSession).not.toHaveBeenCalled();
        });

        test('loads the selected capture and prints session info', async () => {
            (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/tmp/cap.esptrace' }]);
            mockedOpenSession.mockReturnValue({
                cap: {
                    source_path: '/tmp/cap.esptrace',
                    cores: [{ core_id: 0 }, { core_id: 1 }],
                    abi_major: 1,
                    abi_minor: 0,
                    target_id: 0x20,
                },
                chip: 'esp32c5',
            } as any);
            await invoke('platformio-debug.trace.inspectCapture');
            expect(mockedOpenSession).toHaveBeenCalledWith('/tmp/cap.esptrace', expect.objectContaining({}));
            expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('Chip: esp32c5'));
            expect(channel.appendLine).toHaveBeenCalledWith('Cores: 0, 1');
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('2 core'));
        });

        test('reports load failures', async () => {
            (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/tmp/bad.esptrace' }]);
            mockedOpenSession.mockImplementation(() => {
                throw new Error('malformed');
            });
            await invoke('platformio-debug.trace.inspectCapture');
            expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('Failed to inspect capture: malformed'));
            expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        });
    });

    describe('capture controls', () => {
        const debugSession = () => ({
            type: 'platformio-debug',
            customRequest: jest.fn().mockResolvedValue({ output: 'ok' }),
        });

        test('probeCapture reports available commands', async () => {
            const session = debugSession();
            session.customRequest.mockResolvedValue({ output: 'esp riscv_trace start loop ...' });
            (vscode.debug as any).activeDebugSession = session;
            await invoke('platformio-debug.trace.probeCapture');
            expect(session.customRequest).toHaveBeenCalledWith('trace-probe', {});
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('available'));
        });

        test('probeCapture warns when OpenOCD lacks trace support', async () => {
            const session = debugSession();
            session.customRequest.mockResolvedValue({ output: 'unknown command' });
            (vscode.debug as any).activeDebugSession = session;
            await invoke('platformio-debug.trace.probeCapture');
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('CONFIG_ESP_RISCV_TRACE_OPENOCD'));
        });

        test('probeCapture handles request failures', async () => {
            const session = debugSession();
            session.customRequest.mockRejectedValue(new Error('no session'));
            (vscode.debug as any).activeDebugSession = session;
            await invoke('platformio-debug.trace.probeCapture');
            expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('Trace probe failed'));
        });

        test('startCapture sends trace-start with the picked file', async () => {
            const session = debugSession();
            (vscode.debug as any).activeDebugSession = session;
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue([{ fsPath: '/ws/.pio/trace-1.esptrace' }]);
            traceConfig = { captureTimeoutMs: 5000 };
            await invoke('platformio-debug.trace.startCapture');
            expect(session.customRequest).toHaveBeenCalledWith('trace-start', {
                file: '/ws/.pio/trace-1.esptrace',
                timeoutMs: 5000,
            });
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Trace capture started'));
        });

        test('startCapture aborts when the save dialog is cancelled', async () => {
            const session = debugSession();
            (vscode.debug as any).activeDebugSession = session;
            await invoke('platformio-debug.trace.startCapture');
            expect(session.customRequest).not.toHaveBeenCalled();
        });

        test('stopCapture sends trace-stop', async () => {
            const session = debugSession();
            (vscode.debug as any).activeDebugSession = session;
            await invoke('platformio-debug.trace.stopCapture');
            expect(session.customRequest).toHaveBeenCalledWith('trace-stop', {});
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Trace capture stopped.');
        });

        test('stopCapture reports failures to the channel', async () => {
            const session = debugSession();
            session.customRequest.mockRejectedValue(new Error('gdb gone'));
            (vscode.debug as any).activeDebugSession = session;
            await invoke('platformio-debug.trace.stopCapture');
            expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('Trace stop failed'));
        });

        test('dumpCapture sends trace-dump with the picked file', async () => {
            const session = debugSession();
            (vscode.debug as any).activeDebugSession = session;
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue([{ fsPath: '/ws/.pio/dump.esptrace' }]);
            await invoke('platformio-debug.trace.dumpCapture');
            expect(session.customRequest).toHaveBeenCalledWith('trace-dump', { file: '/ws/.pio/dump.esptrace' });
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('dumped'));
        });

        test('capture commands fail gracefully without a debug session', async () => {
            (vscode.debug as any).activeDebugSession = undefined;
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue([{ fsPath: '/tmp/x.esptrace' }]);
            await expect(invoke('platformio-debug.trace.startCapture')).resolves.toBeUndefined();
            await expect(invoke('platformio-debug.trace.stopCapture')).resolves.toBeUndefined();
        });
    });

    describe('analysis commands', () => {
        beforeEach(() => {
            traceConfig = { elfPath: '/x.elf', chip: 'esp32c6' };
            mockedDecode.mockResolvedValue({ lines: ['decoded'], summary: 'done' });
            mockedStats.mockResolvedValue({ lines: ['stats'], summary: 'done' });
            mockedHistory.mockResolvedValue({ lines: ['hist'], summary: 'done' });
            mockedProfile.mockResolvedValue({ lines: ['prof'], summary: 'done' });
        });

        test('decode opens a document with the decoded output', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Full decode', last: undefined });
            (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/tmp/cap.esptrace' }]);
            await invoke('platformio-debug.trace.decode');
            expect(mockedDecode).toHaveBeenCalledWith(
                '/tmp/cap.esptrace',
                expect.objectContaining({ elfPath: '/x.elf', chip: 'esp32c6' })
            );
            expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
            expect(vscode.window.showTextDocument).toHaveBeenCalled();
        });

        test('decode passes the selected last-N scope', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Last 200', last: 200 });
            (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/tmp/cap.esptrace' }]);
            await invoke('platformio-debug.trace.decode');
            expect(mockedDecode).toHaveBeenCalledWith('/tmp/cap.esptrace', expect.objectContaining({ last: 200 }));
        });

        test('decode aborts when quick pick is cancelled', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
            await invoke('platformio-debug.trace.decode');
            expect(mockedDecode).not.toHaveBeenCalled();
        });

        test('stats writes to the output channel', async () => {
            (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/tmp/cap.esptrace' }]);
            await invoke('platformio-debug.trace.stats');
            expect(mockedStats).toHaveBeenCalled();
            expect(channel.append).toHaveBeenCalledWith('stats\n');
            expect(channel.show).toHaveBeenCalledWith(true);
        });

        test('history honours the historyJson setting', async () => {
            (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/tmp/cap.esptrace' }]);
            traceConfig = { historyJson: true };
            await invoke('platformio-debug.trace.history');
            expect(mockedHistory).toHaveBeenCalledWith('/tmp/cap.esptrace', expect.objectContaining({ asJson: true }));
        });

        test('profile uses speedscope format and JSON document when configured', async () => {
            (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/tmp/cap.esptrace' }]);
            traceConfig = { profileFormat: 'speedscope' };
            await invoke('platformio-debug.trace.profile');
            expect(mockedProfile).toHaveBeenCalledWith(
                '/tmp/cap.esptrace',
                expect.objectContaining({ profileFormat: 'speedscope' })
            );
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
                expect.objectContaining({ language: 'json' })
            );
        });

        test('analysis failures show an error message', async () => {
            (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/tmp/cap.esptrace' }]);
            mockedStats.mockRejectedValue(new Error('decode blew up'));
            await invoke('platformio-debug.trace.stats');
            expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('stats failed: decode blew up'));
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('decode blew up'));
        });

        test('analysis aborts when the file dialog is cancelled', async () => {
            await invoke('platformio-debug.trace.stats');
            expect(mockedStats).not.toHaveBeenCalled();
        });
    });
});
