import * as vscode from 'vscode';
import { PlatformIODebugConfigurationProvider } from '../../src/frontend/configprovider';
import { MemoryTreeProvider } from '../../src/frontend/memory_tree_provider';
import { DisassemblyTreeProvider } from '../../src/frontend/disassembly_tree_provider';
import { DisassemblyContentProvider } from '../../src/frontend/disassembly_content_provider';

describe('PlatformIODebugConfigurationProvider', () => {
    const provider = new PlatformIODebugConfigurationProvider();

    test('resolveDebugConfiguration sets cwd from the workspace folder', async () => {
        const config: any = { name: 'debug' };
        const folder = { uri: { fsPath: '/ws/project' } } as any;
        const result = await provider.resolveDebugConfiguration(folder, config);
        expect(result.cwd).toBe('/ws/project');
    });

    test('falls back to workspace.rootPath without a folder', async () => {
        (vscode.workspace as any).rootPath = '/root/path';
        const config: any = {};
        const result = await provider.resolveDebugConfiguration(undefined, config);
        expect(result.cwd).toBe('/root/path');
        (vscode.workspace as any).rootPath = undefined;
    });
});

describe('MemoryTreeProvider', () => {
    let provider: MemoryTreeProvider;

    beforeEach(() => {
        provider = new MemoryTreeProvider();
        (vscode.debug as any).activeDebugSession = { type: 'platformio-debug' };
    });

    afterEach(() => {
        (vscode.debug as any).activeDebugSession = undefined;
    });

    test('getChildren returns empty without a debug session', () => {
        (vscode.debug as any).activeDebugSession = undefined;
        expect(provider.getChildren()).toEqual([]);
    });

    test('getChildren returns an examine prompt when history is empty', () => {
        const children = provider.getChildren();
        expect(children.length).toBe(1);
        expect(children[0].command.command).toBe('platformio-debug.examineMemory');
    });

    test('pushHistory adds entries once and refreshes', () => {
        provider.pushHistory('0x1000', '16');
        provider.pushHistory('0x1000', '16');
        expect(provider.dumpSettings()).toEqual(['0x1000+16']);
        const children = provider.getChildren();
        expect(children[0].command.arguments).toEqual(['0x1000', '16']);
    });

    test('deleteHistory removes only the matching entry', () => {
        provider.pushHistory('0x1000', '16');
        provider.pushHistory('0x2000', '8');
        provider.deleteHistory('0x1000', '16');
        expect(provider.dumpSettings()).toEqual(['0x2000+8']);
        provider.deleteHistory('0x9999', '1');
        expect(provider.dumpSettings()).toEqual(['0x2000+8']);
    });

    test('clearHistory empties history', () => {
        provider.pushHistory('0x1000', '16');
        provider.clearHistory();
        expect(provider.dumpSettings()).toEqual([]);
    });

    test('debugSessionStarted restores state and terminated clears it', () => {
        provider.debugSessionStarted(['0x3000+4']);
        expect(provider.dumpSettings()).toEqual(['0x3000+4']);
        provider.debugSessionTerminated();
        expect(provider.dumpSettings()).toEqual([]);
    });

    test('getTreeItem returns the element and refresh fires the event', () => {
        const item = provider.getChildren()[0];
        expect(provider.getTreeItem(item)).toBe(item);
        expect(() => provider.refresh()).not.toThrow();
    });
});

describe('DisassemblyTreeProvider', () => {
    let provider: DisassemblyTreeProvider;

    beforeEach(() => {
        provider = new DisassemblyTreeProvider();
        (vscode.debug as any).activeDebugSession = { type: 'platformio-debug' };
    });

    afterEach(() => {
        (vscode.debug as any).activeDebugSession = undefined;
    });

    test('getChildren returns empty without a debug session', () => {
        (vscode.debug as any).activeDebugSession = undefined;
        expect(provider.getChildren()).toEqual([]);
    });

    test('getChildren returns disassemble and switch items', () => {
        const children = provider.getChildren();
        expect(children.length).toBe(2);
        expect(children[0].command.command).toBe('platformio-debug.viewDisassembly');
        expect(children[1].label).toBe('Switch to assembly');
        expect(children[1].command.arguments).toEqual(['Forced']);
    });

    test('updateForcedState flips the switch label and argument', () => {
        provider.updateForcedState(true);
        const children = provider.getChildren();
        expect(children[1].label).toBe('Switch to code');
        expect(children[1].command.arguments).toEqual(['Auto']);
    });

    test('debugSessionTerminated resets the forced state', () => {
        provider.updateForcedState(true);
        provider.debugSessionTerminated();
        expect(provider.getChildren()[1].label).toBe('Switch to assembly');
    });

    test('getTreeItem returns the element', () => {
        const item = provider.getChildren()[0];
        expect(provider.getTreeItem(item)).toBe(item);
    });
});

describe('DisassemblyContentProvider', () => {
    const provider = new DisassemblyContentProvider();

    function uri(query: string): any {
        return { query };
    }

    test('formats disassembly instructions', async () => {
        (vscode.debug as any).activeDebugSession = {
            customRequest: jest.fn().mockResolvedValue({
                instructions: [
                    { address: '0x1000', opcodes: '01 02 03', instruction: 'nop' },
                    { address: '0x1004', opcodes: 'aa', instruction: 'ret' },
                ],
            }),
        };
        const text = await provider.provideTextDocumentContent(uri('func=main&file=a.c'), undefined as any);
        expect(text).toBe('0x1000: 01 02 03        \tnop\n0x1004: aa              \tret\n');
        expect((vscode.debug as any).activeDebugSession.customRequest).toHaveBeenCalledWith('disassemble', {
            function: 'main',
            file: 'a.c',
        });
    });

    test('shows an error and rejects on failure', async () => {
        (vscode.debug as any).activeDebugSession = {
            customRequest: jest.fn().mockRejectedValue(new Error('no symbols')),
        };
        await expect(provider.provideTextDocumentContent(uri('func=x'), undefined as any)).rejects.toBe('no symbols');
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('no symbols');
        (vscode.debug as any).activeDebugSession = undefined;
    });
});
