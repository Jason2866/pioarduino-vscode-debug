import * as vscode from 'vscode';
import { NumberFormat } from '../../src/common';
import {
    BaseNode,
    FieldNode,
    RecordType,
    RegisterNode,
    RegisterTreeProvider,
    TreeNode,
} from '../../src/frontend/registers';

describe('register node classes', () => {
    test('BaseNode defaults', () => {
        const node = new BaseNode(RecordType.Register);
        expect(node.format).toBe(NumberFormat.Auto);
        expect(node.expanded).toBe(false);
        expect(node.getChildren()).toEqual([]);
        expect(node.getTreeNode()).toBeNull();
        expect(node.getCopyValue()).toBeNull();
        node.setFormat(NumberFormat.Decimal);
        expect(node.format).toBe(NumberFormat.Decimal);
    });

    test('TreeNode wires the selectedNode command', () => {
        const node = new RegisterNode('R0', 0);
        const treeNode = node.getTreeNode();
        expect(treeNode.command.command).toBe('platformio-debug.registers.selectedNode');
        expect(treeNode.contextValue).toBe('register');
    });

    describe('RegisterNode', () => {
        test('plain register has no fields and collapses to None', () => {
            const reg = new RegisterNode('R0', 0);
            expect(reg.fields).toBeUndefined();
            expect(reg.getChildren()).toBeUndefined();
            const item = reg.getTreeNode();
            expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
        });

        test.each(['XPSR', 'xpsr', 'CPSR'])('%s gets the ARM special-purpose fields', (name) => {
            const reg = new RegisterNode(name, 3);
            expect(reg.fields.length).toBe(10);
            expect(reg.getChildren().length).toBe(10);
            expect(reg.getTreeNode().collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
        });

        test('CONTROL gets its three fields', () => {
            const reg = new RegisterNode('CONTROL', 4);
            expect(reg.fields.map((f) => f.name)).toEqual(['FPCA', 'SPSEL', 'nPRIV']);
        });

        test('getTreeNode formats the value per format', () => {
            const reg = new RegisterNode('R1', 1);
            reg.setValue(0x2a);
            expect(reg.getTreeNode().label).toBe('R1 = 0x0000002a');
            reg.setFormat(NumberFormat.Decimal);
            expect(reg.getTreeNode().label).toBe('R1 = 42');
            reg.setFormat(NumberFormat.Binary);
            expect(reg.getTreeNode().label).toBe('R1 = 0000 0000 0000 0000 0000 0000 0010 1010');
            reg.setFormat(NumberFormat.Hexidecimal);
            expect(reg.getTreeNode().label).toBe('R1 = 0x0000002a');
        });

        test('expanded register uses the Expanded collapsible state', () => {
            const reg = new RegisterNode('XPSR', 5);
            reg.expanded = true;
            expect(reg.getTreeNode().collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
        });

        test('getCopyValue honours the format', () => {
            const reg = new RegisterNode('R1', 1);
            reg.setValue(0xff);
            expect(reg.getCopyValue()).toBe('0x000000ff');
            reg.setFormat(NumberFormat.Decimal);
            expect(reg.getCopyValue()).toBe('255');
            reg.setFormat(NumberFormat.Binary);
            expect(reg.getCopyValue()).toContain('0b');
        });

        test('extractBits reads the current value', () => {
            const reg = new RegisterNode('R1', 1);
            reg.setValue(0b1010);
            expect(reg.extractBits(1, 2)).toBe(0b01);
        });

        test('dumpSettings only emits non-default state', () => {
            const plain = new RegisterNode('R0', 0);
            expect(plain.dumpSettings()).toEqual([]);
            const xpsr = new RegisterNode('XPSR', 1);
            expect(xpsr.dumpSettings()).toEqual([]);
            xpsr.expanded = true;
            xpsr.setFormat(NumberFormat.Decimal);
            const settings = xpsr.dumpSettings();
            expect(settings[0]).toEqual({ node: 'XPSR', format: NumberFormat.Decimal, expanded: true });
        });
    });

    describe('FieldNode', () => {
        test('label shows the extracted field value', () => {
            const reg = new RegisterNode('XPSR', 0);
            reg.setValue(0x80000000); // N flag set
            const nFlag = reg.fields.find((f) => f.name.includes('Negative'))!;
            const item = nFlag.getTreeNode();
            expect(item.label).toContain('= ');
            expect(item.contextValue).toBe('field');
        });

        test('field format inherits the register format when Auto', () => {
            const reg = new RegisterNode('XPSR', 0);
            reg.setValue(0xf);
            const field = reg.fields[0];
            expect(field.getFormat()).toBe(NumberFormat.Auto);
            reg.setFormat(NumberFormat.Decimal);
            expect(field.getFormat()).toBe(NumberFormat.Decimal);
            field.setFormat(NumberFormat.Binary);
            expect(field.getFormat()).toBe(NumberFormat.Binary);
        });

        test('getCopyValue honours explicit and inherited formats', () => {
            const reg = new RegisterNode('XPSR', 0);
            reg.setValue(0x40000000); // Z flag (bit 30)
            const zFlag = reg.fields.find((f) => f.name.includes('Zero'))!;
            expect(zFlag.getCopyValue()).toBe('0b1');
            reg.setFormat(NumberFormat.Decimal);
            zFlag.setFormat(NumberFormat.Hexidecimal);
            expect(zFlag.getCopyValue()).toMatch(/^0x/);
        });

        test('dumpSettings is null for Auto format', () => {
            const reg = new RegisterNode('XPSR', 0);
            const field = reg.fields[0];
            expect(field.dumpSettings()).toBeNull();
            field.setFormat(NumberFormat.Decimal);
            expect(field.dumpSettings()).toEqual({
                node: `XPSR.${field.name}`,
                format: NumberFormat.Decimal,
            });
        });
    });
});

describe('RegisterTreeProvider', () => {
    let provider: RegisterTreeProvider;
    let session: any;

    const names = ['R0', 'R1', 'SP', 'XPSR', ''];

    beforeEach(() => {
        provider = new RegisterTreeProvider();
        session = {
            type: 'platformio-debug',
            customRequest: jest.fn((cmd: string) => {
                if (cmd === 'read-register-list') {
                    return Promise.resolve(names);
                }
                if (cmd === 'read-registers') {
                    return Promise.resolve([
                        { number: '0', value: '0' },
                        { number: '1', value: '2a' },
                        { number: '2', value: '2000f000' },
                        { number: '3', value: '60000000' },
                    ]);
                }
                return Promise.resolve({});
            }),
        };
        (vscode.debug as any).activeDebugSession = session;
    });

    afterEach(() => {
        (vscode.debug as any).activeDebugSession = undefined;
    });

    const flush = () => new Promise((r) => setTimeout(r, 0));

    test('fetchRegisterList does nothing without a session', () => {
        (vscode.debug as any).activeDebugSession = undefined;
        provider.fetchRegisterList();
        expect(session.customRequest).not.toHaveBeenCalled();
    });

    test('first fetch loads names then values', async () => {
        provider.fetchRegisterList();
        await flush();
        await flush();
        expect(session.customRequest).toHaveBeenCalledWith('read-register-list');
        expect(session.customRequest).toHaveBeenCalledWith('read-registers');
        const children = provider.getChildren();
        expect(children.length).toBe(4); // empty name skipped
        expect(children[0].label).toBe('R0 = 0x00000000');
        expect(children[3].label).toBe('XPSR = 0x60000000');
    });

    test('subsequent fetches only re-read values', async () => {
        provider.fetchRegisterList();
        await flush();
        await flush();
        (session.customRequest as jest.Mock).mockClear();
        provider.fetchRegisterList();
        await flush();
        expect(session.customRequest).toHaveBeenCalledWith('read-registers');
        expect(session.customRequest).not.toHaveBeenCalledWith('read-register-list');
    });

    test('getChildren returns a Loading node before registers arrive', () => {
        jest.useFakeTimers();
        const children = provider.getChildren();
        expect(children.length).toBe(1);
        expect(children[0].label).toBe('Loading...');
        jest.useRealTimers();
    });

    test('getChildren returns empty without a session even when loaded', async () => {
        provider.fetchRegisterList();
        await flush();
        await flush();
        (vscode.debug as any).activeDebugSession = undefined;
        expect(provider.getChildren()).toEqual([]);
    });

    test('getChildren on a register element returns its field nodes', async () => {
        provider.fetchRegisterList();
        await flush();
        await flush();
        const xpsrNode = provider.getChildren()[3];
        const fields = provider.getChildren(xpsrNode);
        expect(fields.length).toBe(10);
        expect(fields[0].contextValue).toBe('field');
    });

    test('updateRegisterValues sets values by index', async () => {
        provider.fetchRegisterList();
        await flush();
        await flush();
        provider.updateRegisterValues([{ number: 1, value: 0x7b }]);
        expect(provider.getChildren()[1].label).toBe('R1 = 0x0000007b');
    });

    test('debugSessionStarted applies saved settings on next load', async () => {
        provider.debugSessionStarted([
            { node: 'R1', format: NumberFormat.Decimal, expanded: true },
            { node: 'XPSR.Negative Flag (N)', format: NumberFormat.Binary },
            { node: 'missing', format: NumberFormat.Decimal },
        ]);
        provider.fetchRegisterList();
        await flush();
        await flush();
        expect(provider.getChildren()[1].label).toBe('R1 = 42');
        const xpsrFields = provider.getChildren(provider.getChildren()[3]);
        expect(xpsrFields[0].node.format).toBe(NumberFormat.Binary);
        expect(provider.dumpSettings().length).toBeGreaterThan(0);
    });

    test('debugSessionTerminated clears state', async () => {
        provider.fetchRegisterList();
        await flush();
        await flush();
        provider.debugSessionTerminated();
        expect(provider.dumpSettings()).toEqual([]);
        expect(provider.getChildren()[0].label).toBe('Loading...');
    });

    test('debugStopped refetches only when the view was expanded', async () => {
        provider.debugSessionStarted(undefined);
        provider.fetchRegisterList();
        await flush();
        await flush();
        (session.customRequest as jest.Mock).mockClear();
        provider.debugStopped(); // viewExpanded false until getChildren ran
        await flush();
        expect(session.customRequest).not.toHaveBeenCalled();
        provider.getChildren(); // sets viewExpanded
        provider.debugStopped();
        await flush();
        await flush();
        expect(session.customRequest).toHaveBeenCalledWith('read-registers');
    });

    test('debugContinued is a no-op', () => {
        expect(() => provider.debugContinued()).not.toThrow();
    });
});
