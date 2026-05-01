import * as vscode from 'vscode';
import { NumberFormat, SymbolScope } from './common';
import { encodeDisassembly } from './utils';
import { PlatformIODebugConfigurationProvider } from './frontend/configprovider';
import { DisassemblyContentProvider } from './frontend/disassembly_content_provider';
import { DisassemblyTreeProvider } from './frontend/disassembly_tree_provider';
import { MemoryContentProvider, MemoryDataType } from './frontend/memory_content_provider';
import { MemoryTreeProvider } from './frontend/memory_tree_provider';
import { PeripheralTreeProvider, RecordType as PeripheralRecordType } from './frontend/peripheral';
import { RegisterTreeProvider, RecordType as RegisterRecordType } from './frontend/registers';
import { getDiagnosticsManager } from './frontend/diagnostics';

/**
 * Main entry point and controller for the PlatformIO Debug VS Code extension.
 */
class PlatformIODebugExtension {
    private adapterOutputChannel: vscode.OutputChannel = null;
    private functionSymbols: any[] = null;
    private context: vscode.ExtensionContext;
    private registerProvider: RegisterTreeProvider;
    private peripheralProvider: PeripheralTreeProvider;
    private memoryTreeProvider: MemoryTreeProvider;
    private disassemblyTreeProvider: DisassemblyTreeProvider;
    private memoryContentProvider: MemoryContentProvider;
    private diagnostics = getDiagnosticsManager();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.registerProvider = new RegisterTreeProvider();
        this.peripheralProvider = new PeripheralTreeProvider();
        this.memoryTreeProvider = new MemoryTreeProvider();
        this.disassemblyTreeProvider = new DisassemblyTreeProvider();
        this.memoryContentProvider = new MemoryContentProvider();

        const peripheralTreeView = vscode.window.createTreeView('platformio-debug.peripherals', {
            treeDataProvider: this.peripheralProvider,
        });

        context.subscriptions.push(
            vscode.debug.registerDebugConfigurationProvider(
                'platformio-debug',
                new PlatformIODebugConfigurationProvider()
            ),
            peripheralTreeView,
            peripheralTreeView.onDidExpandElement(
                this.peripheralProvider.onDidExpandElement.bind(this.peripheralProvider)
            ),
            peripheralTreeView.onDidCollapseElement(
                this.peripheralProvider.onDidCollapseElement.bind(this.peripheralProvider)
            ),
            vscode.window.registerTreeDataProvider('platformio-debug.registers', this.registerProvider),
            vscode.window.registerTreeDataProvider('platformio-debug.memory', this.memoryTreeProvider),
            vscode.window.registerTreeDataProvider('platformio-debug.disassembly', this.disassemblyTreeProvider),
            vscode.workspace.registerTextDocumentContentProvider('examinememory', this.memoryContentProvider),
            vscode.workspace.registerTextDocumentContentProvider('disassembly', new DisassemblyContentProvider()),

            vscode.commands.registerCommand('platformio-debug.peripherals.updateNode', this.peripheralsUpdateNode.bind(this)),
            vscode.commands.registerCommand('platformio-debug.peripherals.selectedNode', this.peripheralsSelectedNode.bind(this)),
            vscode.commands.registerCommand('platformio-debug.peripherals.copyValue', this.peripheralsCopyValue.bind(this)),
            vscode.commands.registerCommand('platformio-debug.peripherals.setFormat', this.peripheralsSetFormat.bind(this)),
            vscode.commands.registerCommand('platformio-debug.registers.selectedNode', this.registersSelectedNode.bind(this)),
            vscode.commands.registerCommand('platformio-debug.registers.copyValue', this.registersCopyValue.bind(this)),
            vscode.commands.registerCommand('platformio-debug.registers.setFormat', this.registersSetFormat.bind(this)),
            vscode.commands.registerCommand('platformio-debug.memory.deleteHistoryItem', this.memoryDeleteHistoryItem.bind(this)),
            vscode.commands.registerCommand('platformio-debug.memory.clearHistory', this.memoryClearHistory.bind(this)),
            vscode.commands.registerCommand('platformio-debug.examineMemory', this.examineMemory.bind(this)),
            vscode.commands.registerCommand('platformio-debug.memory.setDataType', this.memorySetDataType.bind(this)),
            vscode.commands.registerCommand('platformio-debug.memory.toggleEndianness', this.memoryToggleEndianness.bind(this)),
            vscode.commands.registerCommand('platformio-debug.memory.writeByte', this.memoryWriteByte.bind(this)),
            vscode.commands.registerCommand('platformio-debug.viewDisassembly', this.showDisassembly.bind(this)),
            vscode.commands.registerCommand('platformio-debug.setForceDisassembly', this.setForceDisassembly.bind(this)),
            vscode.commands.registerCommand('platformio-debug.diagnostics.showLog', this.showDiagnosticsLog.bind(this)),
            vscode.commands.registerCommand('platformio-debug.diagnostics.exportLog', this.exportDiagnosticsLog.bind(this)),
            vscode.commands.registerCommand('platformio-debug.diagnostics.clearLog', this.clearDiagnosticsLog.bind(this)),
            vscode.commands.registerCommand('platformio-debug.reloadSVD', this.reloadSVD.bind(this)),

            vscode.debug.onDidReceiveDebugSessionCustomEvent(this.receivedCustomEvent.bind(this)),
            vscode.debug.onDidStartDebugSession(this.debugSessionStarted.bind(this)),
            vscode.debug.onDidTerminateDebugSession(this.debugSessionTerminated.bind(this)),
            vscode.window.onDidChangeActiveTextEditor(this.activeEditorChanged.bind(this)),
            vscode.window.onDidChangeTextEditorSelection((e) => {
                if (e && e.textEditor.document.fileName.endsWith('.dbgmem')) {
                    this.memoryContentProvider.handleSelection(e);
                }
            })
        );
    }

    /** Returns true if the active session is platformio-debug. */
    private isPIODebugSession(): boolean {
        return vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.type === 'platformio-debug';
    }

    /** Notifies session on editor switch. */
    private activeEditorChanged(editor: vscode.TextEditor): void {
        if (!editor || !this.isPIODebugSession()) {
            return;
        }

        const uri = editor.document.uri;
        if (uri.scheme === 'file') {
            vscode.debug.activeDebugSession.customRequest('set-active-editor', { path: uri.path });
        } else if (uri.scheme === 'disassembly') {
            vscode.debug.activeDebugSession.customRequest('set-active-editor', {
                path: `${uri.scheme}://${uri.authority}${uri.path}`,
            });
        }
    }

    /** Prompts for function name and opens disassembly. */
    private async showDisassembly(): Promise<void> {
        if (!this.isPIODebugSession()) {
            vscode.window.showErrorMessage('No debugging session available');
            return;
        }

        if (!this.functionSymbols) {
            try {
                const result = await vscode.debug.activeDebugSession.customRequest('load-function-symbols');
                this.functionSymbols = result.functionSymbols;
            } catch (e) {
                vscode.window.showErrorMessage('Unable to load symbol table. Disassembly view unavailable.');
            }
        }

        try {
            const funcName = await vscode.window.showInputBox({
                placeHolder: 'main',
                ignoreFocusOut: true,
                prompt: 'Function Name to Disassemble',
            });

            const matches = this.functionSymbols.filter((s) => s.name === funcName);
            let uri: string;

            if (matches.length === 1) {
                uri = encodeDisassembly(matches[0].name, matches[0].file);
            } else if (matches.length > 1) {
                const selected = await vscode.window.showQuickPick(
                    matches.map((m) => ({
                        label: m.name,
                        name: m.name,
                        file: m.file,
                        scope: m.scope,
                        description:
                            m.scope === SymbolScope.Global ? 'Global Scope' : `Static in ${m.file}`,
                    })),
                    { ignoreFocusOut: true }
                );
                uri = encodeDisassembly(selected.name, selected.file);
            } else {
                vscode.window.showErrorMessage(`No function with name ${funcName} found.`);
                return;
            }

            if (uri) {
                vscode.window.showTextDocument(vscode.Uri.parse(uri));
            }
        } catch (e) {
            vscode.window.showErrorMessage('Unable to show disassembly.');
        }
    }

    /** Toggles/sets forced-disassembly mode. */
    private setForceDisassembly(force?: string): void {
        const doSet = (value: string) => {
            const forced = value === 'Forced';
            this.disassemblyTreeProvider.updateForcedState(forced);
            return vscode.debug.activeDebugSession.customRequest('set-force-disassembly', { force: forced });
        };

        if (force) {
            return doSet(force) as any;
        }

        vscode.window
            .showQuickPick(
                [
                    {
                        label: 'Auto',
                        description: 'Show disassembly for functions when source cannot be located.',
                    },
                    {
                        label: 'Forced',
                        description: 'Always show disassembly for functions.',
                    },
                ],
                { matchOnDescription: true, ignoreFocusOut: true }
            )
            .then(
                (selected) => {
                    doSet(selected.label);
                },
                (err) => {}
            );
    }

    /** Removes an entry from memory history. */
    private memoryDeleteHistoryItem(item: any): void {
        const [address, length] = item.label.split('+');
        this.memoryTreeProvider.deleteHistory(address, length);
    }

    /** Clears memory history. */
    private memoryClearHistory(): void {
        this.memoryTreeProvider.clearHistory();
    }

    /** Opens interactive memory examination. */
    private examineMemory(address?: string, length?: string): any {
        function validateInput(input: string): string | null {
            if (/^0x[0-9a-f]{1,8}$/i.test(input) || /^[0-9]+$/i.test(input)) {
                return input;
            }
            return null;
        }

        if (!this.isPIODebugSession()) {
            vscode.window.showErrorMessage('No debugging session available');
            return;
        }

        if (address && length) {
            return this.showMemoryContent(address, length);
        }

        vscode.window
            .showInputBox({
                placeHolder: 'Prefix with 0x for hexidecimal format',
                ignoreFocusOut: true,
                prompt: 'A start memory address',
            })
            .then(
                (addressInput) => {
                    if (validateInput(addressInput)) {
                        vscode.window
                            .showInputBox({
                                placeHolder: 'Prefix with 0x for hexidecimal format',
                                ignoreFocusOut: true,
                                prompt: 'How many bytes to read?',
                            })
                            .then(
                                (lengthInput) => {
                                    if (validateInput(lengthInput)) {
                                        this.memoryTreeProvider.pushHistory(addressInput, lengthInput);
                                        this.showMemoryContent(addressInput, lengthInput);
                                    } else {
                                        vscode.window.showErrorMessage('Invalid length entered');
                                    }
                                },
                                (err) => {}
                            );
                    } else {
                        vscode.window.showErrorMessage('Invalid memory address entered');
                    }
                },
                (err) => {}
            );
    }

    /** Opens a memory content document. */
    private showMemoryContent(address: string, length: string): void {
        vscode.workspace
            .openTextDocument(
                vscode.Uri.parse(
                    `examinememory:///Memory%20[${address}+${length}].dbgmem?address=${address}&length=${length}&timestamp=${new Date().getTime()}`
                )
            )
            .then(
                (doc) => {
                    vscode.window.showTextDocument(doc, { viewColumn: 2, preview: false });
                },
                (error) => {
                    vscode.window.showErrorMessage(`Failed to examine memory: ${error}`);
                }
            );
    }

    /** Sets the data type for memory interpretation. */
    private memorySetDataType(): void {
        const dataTypes = [
            { label: 'u8 (unsigned 8-bit)', value: MemoryDataType.U8 },
            { label: 'u16 (unsigned 16-bit)', value: MemoryDataType.U16 },
            { label: 'u32 (unsigned 32-bit)', value: MemoryDataType.U32 },
            { label: 'u64 (unsigned 64-bit)', value: MemoryDataType.U64 },
            { label: 'i8 (signed 8-bit)', value: MemoryDataType.I8 },
            { label: 'i16 (signed 16-bit)', value: MemoryDataType.I16 },
            { label: 'i32 (signed 32-bit)', value: MemoryDataType.I32 },
            { label: 'i64 (signed 64-bit)', value: MemoryDataType.I64 },
            { label: 'float (32-bit float)', value: MemoryDataType.Float },
            { label: 'double (64-bit double)', value: MemoryDataType.Double }
        ];

        vscode.window.showQuickPick(dataTypes.map(dt => dt.label)).then(selected => {
            if (selected) {
                const dataType = dataTypes.find(dt => dt.label === selected)?.value;
                if (dataType) {
                    this.memoryContentProvider.setDataType(dataType);
                    // Refresh all open memory documents
                    vscode.workspace.textDocuments.forEach(doc => {
                        if (doc.fileName.endsWith('.dbgmem')) {
                            this.memoryContentProvider.update(doc);
                        }
                    });
                }
            }
        });
    }

    /** Toggles endianness for memory interpretation. */
    private memoryToggleEndianness(): void {
        this.memoryContentProvider.toggleEndianness();
        const endianness = this.memoryContentProvider.getEndianness();
        vscode.window.showInformationMessage(`Memory view endianness: ${endianness}`);

        // Refresh all open memory documents
        vscode.workspace.textDocuments.forEach(doc => {
            if (doc.fileName.endsWith('.dbgmem')) {
                this.memoryContentProvider.update(doc);
            }
        });
    }

    /** Writes a byte to memory at the given address. */
    private async memoryWriteByte(args: { address: number; value: number }): Promise<void> {
        if (!this.isPIODebugSession()) {
            vscode.window.showErrorMessage('No debugging session available');
            return;
        }

        if (!args || typeof args.address !== 'number' || typeof args.value !== 'number') {
            // Interactive mode - prompt for address and value
            const addressInput = await vscode.window.showInputBox({
                prompt: 'Memory address to write (hex with 0x prefix or decimal)',
                validateInput: (value) => {
                    if (/^0x[0-9a-f]+$/i.test(value) || /^[0-9]+$/i.test(value)) {
                        return null;
                    }
                    return 'Invalid address format';
                }
            });

            if (!addressInput) return;

            const valueInput = await vscode.window.showInputBox({
                prompt: 'Value to write (0x00 - 0xFF)',
                validateInput: (value) => {
                    if (/^0x[0-9a-f]{1,2}$/i.test(value)) {
                        return null;
                    }
                    return 'Invalid hex byte format (use 0x00 - 0xFF)';
                }
            });

            if (!valueInput) return;

            const address = addressInput.startsWith('0x')
                ? parseInt(addressInput.substring(2), 16)
                : parseInt(addressInput, 10);
            const value = parseInt(valueInput.substring(2), 16);

            const success = await this.memoryContentProvider.writeByte(address, value);
            if (success) {
                vscode.window.showInformationMessage(`Wrote 0x${value.toString(16).padStart(2, '0').toUpperCase()} to ${addressInput}`);
                // Refresh open memory views
                vscode.workspace.textDocuments.forEach(doc => {
                    if (doc.fileName.endsWith('.dbgmem')) {
                        this.memoryContentProvider.update(doc);
                    }
                });
            }
        } else {
            // Direct call with args
            const success = await this.memoryContentProvider.writeByte(args.address, args.value);
            if (success) {
                vscode.window.showInformationMessage(
                    `Wrote 0x${args.value.toString(16).padStart(2, '0').toUpperCase()} to 0x${args.address.toString(16).toUpperCase()}`
                );
            }
        }
    }

    /** Updates a peripheral node and refreshes. */
    private peripheralsUpdateNode(node: any): void {
        node.node.performUpdate().then(
            (result: boolean) => {
                if (result) {
                    this.peripheralProvider.refresh();
                }
            },
            (error: any) => {
                vscode.window.showErrorMessage(`Unable to update value: ${error.toString()}`);
            }
        );
    }

    /** Handles selection of a peripheral node. */
    private peripheralsSelectedNode(node: any): void {
        if (node.recordType !== PeripheralRecordType.Field) {
            node.expanded = !node.expanded;
        }
        node.selected().then(
            (result: boolean) => {
                if (result) {
                    this.peripheralProvider.refresh();
                }
            },
            (error: any) => {}
        );
    }

    /** Copies peripheral node value. */
    private peripheralsCopyValue(node: any): void {
        const value = node.node.getCopyValue();
        if (value) {
            vscode.env.clipboard.writeText(value);
        }
    }

    /** Sets display format for peripheral node. */
    private async peripheralsSetFormat(node: any): Promise<void> {
        const selected = await vscode.window.showQuickPick([
            { label: 'Auto', description: 'Automatically choose format (Inherits from parent)', value: NumberFormat.Auto },
            { label: 'Hex', description: 'Format value in hexidecimal', value: NumberFormat.Hexidecimal },
            { label: 'Decimal', description: 'Format value in decimal', value: NumberFormat.Decimal },
            { label: 'Binary', description: 'Format value in binary', value: NumberFormat.Binary },
        ]);
        node.node.setFormat(selected.value);
        this.peripheralProvider.refresh();
    }

    /** Handles selection of a register node. */
    private registersSelectedNode(node: any): void {
        if (node.recordType !== RegisterRecordType.Field) {
            node.expanded = !node.expanded;
        }
    }

    /** Copies register node value. */
    private registersCopyValue(node: any): void {
        const value = node.node.getCopyValue();
        if (value) {
            vscode.env.clipboard.writeText(value);
        }
    }

    /** Sets display format for register node. */
    private async registersSetFormat(node: any): Promise<void> {
        const selected = await vscode.window.showQuickPick([
            { label: 'Auto', description: 'Automatically choose format (Inherits from parent)', value: NumberFormat.Auto },
            { label: 'Hex', description: 'Format value in hexidecimal', value: NumberFormat.Hexidecimal },
            { label: 'Decimal', description: 'Format value in decimal', value: NumberFormat.Decimal },
            { label: 'Binary', description: 'Format value in binary', value: NumberFormat.Binary },
        ]);
        node.node.setFormat(selected.value);
        this.registerProvider.refresh();
    }

    /** Initialises providers on session start. */
    private debugSessionStarted(session: vscode.DebugSession): void {
        if (session.type === 'platformio-debug') {
            this.functionSymbols = null;
            session.customRequest('get-arguments').then(
                (args: any) => {
                    this.registerProvider.debugSessionStarted(
                        this.context.workspaceState.get('debugRegistersTreeState')
                    );
                    this.peripheralProvider.debugSessionStarted(
                        args.svdPath,
                        this.context.workspaceState.get('debugPeripheralsTreeState')
                    );
                    this.memoryTreeProvider.debugSessionStarted(
                        this.context.workspaceState.get('debugMemoryTreeState')
                    );
                    this.disassemblyTreeProvider.debugSessionStarted();
                },
                (error: any) => {
                    console.error(error);
                }
            );
        }
    }

    /** Persists state and tears down on termination. */
    private debugSessionTerminated(session: vscode.DebugSession): void {
        if (session.type === 'platformio-debug') {
            this.context.workspaceState.update(
                'debugRegistersTreeState',
                this.registerProvider.dumpSettings()
            );
            this.context.workspaceState.update(
                'debugPeripheralsTreeState',
                this.peripheralProvider.dumpSettings()
            );
            this.context.workspaceState.update(
                'debugMemoryTreeState',
                this.memoryTreeProvider.dumpSettings()
            );

            this.registerProvider.debugSessionTerminated();
            this.peripheralProvider.debugSessionTerminated();
            this.memoryTreeProvider.debugSessionTerminated();
            this.disassemblyTreeProvider.debugSessionTerminated();
        }
    }

    /** Routes custom events. */
    private receivedCustomEvent(e: vscode.DebugSessionCustomEvent): void {
        if (!this.isPIODebugSession()) {
            return;
        }

        switch (e.event) {
            case 'custom-stop':
                this.receivedStopEvent(e);
                break;
            case 'custom-continued':
                this.receivedContinuedEvent(e);
                break;
            case 'adapter-output':
                this.receivedAdapterOutput(e);
                break;
            case 'record-event':
                this.receivedEvent(e);
                break;
        }
    }

    /** Handles stop event. */
    private receivedStopEvent(e: vscode.DebugSessionCustomEvent): void {
        this.peripheralProvider.debugStopped();
        this.registerProvider.debugStopped();

        vscode.workspace.textDocuments
            .filter((doc) => doc.fileName.endsWith('.dbgmem'))
            .forEach((doc) => {
                this.memoryContentProvider.update(doc);
            });
    }

    /** Handles continued event. */
    private receivedContinuedEvent(e: vscode.DebugSessionCustomEvent): void {
        this.peripheralProvider.debugContinued();
        this.registerProvider.debugContinued();
    }

    /** Handles telemetry events. */
    private receivedEvent(e: vscode.DebugSessionCustomEvent): void {}

    /** Appends adapter output to channel. */
    private receivedAdapterOutput(e: vscode.DebugSessionCustomEvent): void {
        if (!this.adapterOutputChannel) {
            this.adapterOutputChannel = vscode.window.createOutputChannel('Adapter Output');
        }

        let content: string = e.body.content;
        if (!content.endsWith('\n')) {
            content += '\n';
        }
        this.adapterOutputChannel.append(content);
    }

    /** Shows the diagnostic log output channel. */
    private showDiagnosticsLog(): void {
        this.diagnostics.showOutputChannel();
    }

    /** Exports diagnostic log to clipboard. */
    private exportDiagnosticsLog(): void {
        const logContent = this.diagnostics.exportLog();
        vscode.env.clipboard.writeText(logContent).then(() => {
            this.diagnostics.showInfo('Diagnostic log copied to clipboard');
        });
    }

    /** Clears the diagnostic log. */
    private clearDiagnosticsLog(): void {
        this.diagnostics.clearLog();
        this.diagnostics.showInfo('Diagnostic log cleared');
    }

    /** Reloads the peripheral tree using the supplied SVD file path. */
    private reloadSVD(svdPath: string): void {
        if (!svdPath) {
            return;
        }
        this.peripheralProvider.reloadSVD(svdPath);
        this.diagnostics.showInfo(`Reloaded SVD: ${svdPath}`);
    }
}

/**
 * VS Code activation hook.
 */
export function activate(context: vscode.ExtensionContext): PlatformIODebugExtension {
    return new PlatformIODebugExtension(context);
}

/**
 * VS Code deactivation hook.
 */
export function deactivate(): void {}
