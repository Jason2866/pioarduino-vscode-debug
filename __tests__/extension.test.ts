import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';
import { NumberFormat } from '../src/common';
import { RecordType as RegisterRecordType } from '../src/frontend/registers';
import { RecordType as PeripheralRecordType } from '../src/frontend/peripheral';
import { getDiagnosticsManager } from '../src/frontend/diagnostics';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('extension activation', () => {
    let handlers: Map<string, (...args: any[]) => any>;
    let listeners: Map<string, (...args: any[]) => any>;
    let context: any;
    let ext: any;

    const pioSession = (customRequestImpl?: (cmd: string, args?: any) => any) => ({
        type: 'platformio-debug',
        customRequest: jest.fn(customRequestImpl ?? (() => Promise.resolve({}))),
    });

    beforeEach(() => {
        jest.clearAllMocks();
        handlers = new Map();
        listeners = new Map();
        (vscode.commands.registerCommand as jest.Mock).mockImplementation((id: string, cb: any) => {
            handlers.set(id, cb);
            return { dispose: jest.fn() };
        });
        const capture =
            (key: string) =>
            (cb: any) => {
                listeners.set(key, cb);
                return { dispose: jest.fn() };
            };
        (vscode.debug.onDidStartDebugSession as jest.Mock).mockImplementation(capture('start'));
        (vscode.debug.onDidTerminateDebugSession as jest.Mock).mockImplementation(capture('terminate'));
        (vscode.debug.onDidReceiveDebugSessionCustomEvent as jest.Mock).mockImplementation(capture('customEvent'));
        (vscode.window.onDidChangeActiveTextEditor as jest.Mock).mockImplementation(capture('activeEditor'));
        (vscode.workspace.onDidChangeConfiguration as jest.Mock).mockImplementation(capture('configChange'));
        (vscode.window.onDidChangeTextEditorSelection as jest.Mock).mockImplementation(capture('selectionChange'));
        (vscode.workspace.onDidChangeTextDocument as jest.Mock).mockImplementation(capture('textDocumentChange'));
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((_k: string, def?: any) => def),
        });
        (vscode.workspace.workspaceFolders as any) = [{ uri: { fsPath: '/ws' } }];
        (vscode.workspace.textDocuments as any) = [];
        (vscode.debug as any).activeDebugSession = undefined;
        context = {
            subscriptions: [],
            workspaceState: { get: jest.fn(), update: jest.fn() },
        };
        ext = activate(context);
    });

    afterEach(() => {
        (vscode.debug as any).activeDebugSession = undefined;
    });

    test('deactivate is a no-op', () => {
        expect(() => deactivate()).not.toThrow();
    });

    test('activate registers tree providers, content providers and commands', () => {
        expect(vscode.window.createTreeView).toHaveBeenCalledWith(
            'platformio-debug.peripherals',
            expect.anything()
        );
        expect(vscode.window.registerTreeDataProvider).toHaveBeenCalledWith(
            'platformio-debug.registers',
            expect.anything()
        );
        expect(vscode.window.registerTreeDataProvider).toHaveBeenCalledWith(
            'platformio-debug.memory',
            expect.anything()
        );
        expect(vscode.window.registerTreeDataProvider).toHaveBeenCalledWith(
            'platformio-debug.disassembly',
            expect.anything()
        );
        expect(vscode.workspace.registerTextDocumentContentProvider).toHaveBeenCalledWith(
            'examinememory',
            expect.anything()
        );
        expect(vscode.workspace.registerTextDocumentContentProvider).toHaveBeenCalledWith(
            'disassembly',
            expect.anything()
        );
        expect(vscode.debug.registerDebugConfigurationProvider).toHaveBeenCalledWith(
            'platformio-debug',
            expect.anything()
        );
        expect(handlers.has('platformio-debug.viewDisassembly')).toBe(true);
        expect(handlers.has('platformio-debug.memory.edit')).toBe(true);
        expect(context.subscriptions.length).toBeGreaterThan(10);
    });

    describe('register commands', () => {
        test('selectedNode toggles expansion for registers but not fields', () => {
            const regNode = { recordType: RegisterRecordType.Register, expanded: false, node: {} };
            handlers.get('platformio-debug.registers.selectedNode')!(regNode);
            expect(regNode.expanded).toBe(true);
            const fieldNode = { recordType: RegisterRecordType.Field, expanded: false, node: {} };
            handlers.get('platformio-debug.registers.selectedNode')!(fieldNode);
            expect(fieldNode.expanded).toBe(false);
        });

        test('copyValue writes the node value to the clipboard', () => {
            const node = { node: { getCopyValue: () => '0xdeadbeef' } };
            handlers.get('platformio-debug.registers.copyValue')!(node);
            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('0xdeadbeef');
            handlers.get('platformio-debug.registers.copyValue')!({ node: { getCopyValue: () => null } });
            expect(vscode.env.clipboard.writeText).toHaveBeenCalledTimes(1);
        });

        test('setFormat applies the picked format', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Hex', value: NumberFormat.Hexidecimal });
            const node = { node: { setFormat: jest.fn() } };
            await handlers.get('platformio-debug.registers.setFormat')!(node);
            expect(node.node.setFormat).toHaveBeenCalledWith(NumberFormat.Hexidecimal);
        });
    });

    describe('memory commands', () => {
        beforeEach(() => {
            (vscode.debug as any).activeDebugSession = pioSession();
        });

        test('examineMemory with args opens a memory document', async () => {
            handlers.get('platformio-debug.examineMemory')!('0x1000', '16');
            await flush();
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
                expect.objectContaining({})
            );
            expect(vscode.window.showTextDocument).toHaveBeenCalled();
        });

        test('examineMemory interactively validates address and length', async () => {
            (vscode.window.showInputBox as jest.Mock)
                .mockResolvedValueOnce('0x1000')
                .mockResolvedValueOnce('32');
            handlers.get('platformio-debug.examineMemory')!();
            await flush();
            await flush();
            expect(ext.memoryTreeProvider.dumpSettings()).toContain('0x1000+32');
        });

        test('examineMemory rejects an invalid address', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('not-an-address');
            handlers.get('platformio-debug.examineMemory')!();
            await flush();
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Invalid memory address entered');
        });

        test('examineMemory rejects an invalid length', async () => {
            (vscode.window.showInputBox as jest.Mock)
                .mockResolvedValueOnce('0x1000')
                .mockResolvedValueOnce('lots');
            handlers.get('platformio-debug.examineMemory')!();
            await flush();
            await flush();
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Invalid length entered');
        });

        test('examineMemory requires a debug session', () => {
            (vscode.debug as any).activeDebugSession = undefined;
            handlers.get('platformio-debug.examineMemory')!();
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No debugging session available');
        });

        test('deleteHistoryItem and clearHistory manage the tree provider', () => {
            ext.memoryTreeProvider.pushHistory('0x1000', '16');
            handlers.get('platformio-debug.memory.deleteHistoryItem')!({ label: '0x1000+16' });
            expect(ext.memoryTreeProvider.dumpSettings()).toEqual([]);
            ext.memoryTreeProvider.pushHistory('0x2000', '8');
            handlers.get('platformio-debug.memory.clearHistory')!();
            expect(ext.memoryTreeProvider.dumpSettings()).toEqual([]);
        });

        test('memoryWriteByte writes via the debug session', async () => {
            const session = pioSession(() => Promise.resolve({}));
            (vscode.debug as any).activeDebugSession = session;
            await handlers.get('platformio-debug.memory.writeByte')!({ address: 0x1000, value: 0x41 });
            expect(session.customRequest).toHaveBeenCalledWith('write-memory', {
                address: 0x1000,
                data: '41',
            });
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Wrote 0x41'));
        });

        test('memoryWriteByte validates byte range', async () => {
            const session = pioSession(() => Promise.resolve({}));
            (vscode.debug as any).activeDebugSession = session;
            await handlers.get('platformio-debug.memory.edit')!({ address: 0x1000, value: 300 });
            expect(session.customRequest).not.toHaveBeenCalledWith('write-memory', expect.anything());
            expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        });

        test('memorySetDataType applies the selection', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('u16 (unsigned 16-bit)');
            await handlers.get('platformio-debug.memory.setDataType')!();
            expect(vscode.window.showQuickPick).toHaveBeenCalled();
        });

        test('memoryToggleEndianness reports the new endianness', () => {
            handlers.get('platformio-debug.memory.toggleEndianness')!();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('endianness'));
        });
    });

    describe('disassembly commands', () => {
        test('viewDisassembly requires a session', async () => {
            await handlers.get('platformio-debug.viewDisassembly')!();
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No debugging session available');
        });

        test('viewDisassembly opens the matched function', async () => {
            const session = pioSession((cmd: string) => {
                if (cmd === 'load-function-symbols') {
                    return Promise.resolve({
                        functionSymbols: [{ name: 'main', file: 'main.c', scope: 1 }],
                    });
                }
                return Promise.resolve({});
            });
            (vscode.debug as any).activeDebugSession = session;
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('main');
            await handlers.get('platformio-debug.viewDisassembly')!();
            expect(session.customRequest).toHaveBeenCalledWith('load-function-symbols');
            expect(vscode.window.showTextDocument).toHaveBeenCalled();
        });

        test('viewDisassembly reports an unknown function', async () => {
            const session = pioSession((cmd: string) => {
                if (cmd === 'load-function-symbols') {
                    return Promise.resolve({ functionSymbols: [{ name: 'main', file: 'a.c', scope: 1 }] });
                }
                return Promise.resolve({});
            });
            (vscode.debug as any).activeDebugSession = session;
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('nope');
            await handlers.get('platformio-debug.viewDisassembly')!();
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No function with name nope found.');
        });

        test('setForceDisassembly with an explicit value', async () => {
            const session = pioSession(() => Promise.resolve({}));
            (vscode.debug as any).activeDebugSession = session;
            await handlers.get('platformio-debug.setForceDisassembly')!('Forced');
            expect(session.customRequest).toHaveBeenCalledWith('set-force-disassembly', { force: true });
        });

        test('setForceDisassembly prompts when no value given', async () => {
            const session = pioSession(() => Promise.resolve({}));
            (vscode.debug as any).activeDebugSession = session;
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Auto' });
            await handlers.get('platformio-debug.setForceDisassembly')!();
            await flush();
            expect(session.customRequest).toHaveBeenCalledWith('set-force-disassembly', { force: false });
        });
    });

    describe('peripheral commands', () => {
        test('selectedNode toggles expansion for peripherals', () => {
            const node = { recordType: PeripheralRecordType.Register, expanded: false, selected: () => Promise.resolve(true), node: {} };
            handlers.get('platformio-debug.peripherals.selectedNode')!(node);
            expect(node.expanded).toBe(true);
            const field = { recordType: PeripheralRecordType.Field, expanded: false, selected: () => Promise.resolve(true), node: {} };
            handlers.get('platformio-debug.peripherals.selectedNode')!(field);
            expect(field.expanded).toBe(false);
        });

        test('copyValue writes peripheral value', () => {
            const node = { node: { getCopyValue: () => '42' } };
            handlers.get('platformio-debug.peripherals.copyValue')!(node);
            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('42');
        });

        test('updateNode refreshes on success', async () => {
            const node = { node: { performUpdate: () => Promise.resolve(true) } };
            handlers.get('platformio-debug.peripherals.updateNode')!(node);
            await flush();
        });

        test('setFormat applies the picked format', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Decimal', value: NumberFormat.Decimal });
            const node = { node: { setFormat: jest.fn() } };
            await handlers.get('platformio-debug.peripherals.setFormat')!(node);
            expect(node.node.setFormat).toHaveBeenCalledWith(NumberFormat.Decimal);
        });
    });

    describe('diagnostics commands', () => {
        test('showLog shows the diagnostics channel', () => {
            const spy = jest.spyOn(getDiagnosticsManager(), 'showOutputChannel').mockImplementation(() => {});
            try {
                handlers.get('platformio-debug.diagnostics.showLog')!();
                expect(spy).toHaveBeenCalled();
            } finally {
                spy.mockRestore();
            }
        });

        test('exportLog copies the log to the clipboard', async () => {
            handlers.get('platformio-debug.diagnostics.exportLog')!();
            await flush();
            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Diagnostic Log'));
        });

        test('clearLog clears entries', () => {
            expect(() => handlers.get('platformio-debug.diagnostics.clearLog')!()).not.toThrow();
        });
    });

    describe('reloadSVD', () => {
        test('with an explicit path reloads without a dialog', async () => {
            await handlers.get('platformio-debug.reloadSVD')!('/tmp/test.svd');
            expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
        });

        test('without a path prompts for a file', async () => {
            await handlers.get('platformio-debug.reloadSVD')!();
            expect(vscode.window.showOpenDialog).toHaveBeenCalled();
        });
    });

    describe('debug session events', () => {
        test('start initialises providers for platformio-debug sessions', async () => {
            const session = pioSession((cmd: string) =>
                cmd === 'get-arguments' ? Promise.resolve({ svdPath: '/tmp/mcu.svd', device: 'esp32c6' }) : Promise.resolve({})
            );
            listeners.get('start')!(session);
            await flush();
            await flush();
            expect(session.customRequest).toHaveBeenCalledWith('get-arguments');
            expect(ext.peripheralProvider.svdPath).toBe('/tmp/mcu.svd');
        });

        test('start ignores non-platformio sessions', async () => {
            const session = pioSession();
            session.type = 'other';
            listeners.get('start')!(session);
            await flush();
            expect(session.customRequest).not.toHaveBeenCalled();
        });

        test('terminate persists tree state', () => {
            listeners.get('terminate')!({ type: 'platformio-debug' });
            expect(context.workspaceState.update).toHaveBeenCalledWith(
                'debugRegistersTreeState',
                expect.anything()
            );
            expect(context.workspaceState.update).toHaveBeenCalledWith(
                'debugPeripheralsTreeState',
                expect.anything()
            );
            expect(context.workspaceState.update).toHaveBeenCalledWith(
                'debugMemoryTreeState',
                expect.anything()
            );
        });

        test('custom events route by name', async () => {
            (vscode.debug as any).activeDebugSession = pioSession();
            listeners.get('customEvent')!({ event: 'adapter-output', body: { content: 'hello' } });
            expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Adapter Output');
            listeners.get('customEvent')!({ event: 'custom-stop', body: {} });
            listeners.get('customEvent')!({ event: 'custom-continued', body: {} });
            listeners.get('customEvent')!({ event: 'record-event', body: {} });
            listeners.get('customEvent')!({ event: 'unknown', body: {} });
        });

        test('custom events are ignored without a platformio session', () => {
            (vscode.debug as any).activeDebugSession = { type: 'other' };
            expect(() =>
                listeners.get('customEvent')!({ event: 'adapter-output', body: { content: 'x' } })
            ).not.toThrow();
        });

        test('active editor change notifies the session', () => {
            const session = pioSession();
            (vscode.debug as any).activeDebugSession = session;
            listeners.get('activeEditor')!({
                document: { uri: { scheme: 'file', path: '/src/main.c' } },
            });
            expect(session.customRequest).toHaveBeenCalledWith('set-active-editor', { path: '/src/main.c' });
            listeners.get('activeEditor')!({
                document: { uri: { scheme: 'disassembly', authority: 'auth', path: '/fn' } },
            });
            expect(session.customRequest).toHaveBeenCalledWith('set-active-editor', {
                path: 'disassembly://auth/fn',
            });
            listeners.get('activeEditor')!(undefined);
        });

        test('configuration change updates diagnostics flag', () => {
            listeners.get('configChange')!({ affectsConfiguration: () => true });
        });

        test('text editor selection on .dbgmem files is handled', () => {
            const setDecorations = jest.fn();
            listeners.get('selectionChange')!({
                textEditor: {
                    document: { fileName: 'mem.dbgmem', lineCount: 10 },
                    setDecorations,
                },
                selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }],
            });
            listeners.get('selectionChange')!({
                textEditor: { document: { fileName: 'other.c', lineCount: 10 }, setDecorations },
                selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }],
            });
        });

        test('text document change on examineme scheme applies decorations', () => {
            const setDecorations = jest.fn();
            const docUri = { scheme: 'examinememory', toString: () => 'examinememory:///x' };
            (vscode.workspace as any).textDocuments = [];
            (vscode.window as any).visibleTextEditors = [
                {
                    document: { uri: docUri },
                    setDecorations,
                },
            ];
            listeners.get('textDocumentChange')!({ document: { uri: docUri } });
            listeners.get('textDocumentChange')!({ document: { uri: { scheme: 'file' } } });
        });
    });
});
