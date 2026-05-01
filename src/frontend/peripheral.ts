import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { NumberFormat } from '../common';
import {
    hexFormat,
    binaryFormat,
    extractBitsBigInt,
    parseBigInt,
} from '../utils';

export enum RecordType {
    Peripheral = 1,
    Register = 2,
    Field = 3,
    Cluster = 4,
}

export enum AccessType {
    ReadOnly = 1,
    ReadWrite = 2,
    WriteOnly = 3,
}

const ACCESS_MAP: { [key: string]: AccessType } = {
    'read-only': AccessType.ReadOnly,
    'write-only': AccessType.WriteOnly,
    'read-write': AccessType.ReadWrite,
    'writeOnce': AccessType.WriteOnly,
    'read-writeOnce': AccessType.ReadWrite,
};

export class TreeNode extends vscode.TreeItem {
    constructor(
        public label: string,
        public collapsibleState: vscode.TreeItemCollapsibleState,
        public contextValue: string,
        public node: BaseNode
    ) {
        super(label, collapsibleState);
        this.command = {
            command: 'platformio-debug.peripherals.selectedNode',
            arguments: [node],
            title: 'Selected Node',
        };
        this.tooltip = (node ? node.description : undefined) || label;
    }
}

export class BaseNode {
    public expanded: boolean = false;
    public format: NumberFormat = NumberFormat.Auto;
    public description: string;
    public accessType?: AccessType;
    private cachedTreeNode?: TreeNode;

    constructor(public recordType: RecordType) {}

    selected(): Promise<boolean> {
        return Promise.resolve(false);
    }

    update(): Promise<boolean> {
        return Promise.resolve(false);
    }

    performUpdate(): Promise<boolean> {
        return Promise.resolve(false);
    }

    getChildren(): BaseNode[] {
        return [];
    }

    getTreeNode(): TreeNode {
        return null;
    }

    protected getOrCreateTreeNode(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        contextValue: string
    ): TreeNode {
        if (!this.cachedTreeNode) {
            this.cachedTreeNode = new TreeNode(label, collapsibleState, contextValue, this);
        }

        this.cachedTreeNode.label = label;
        this.cachedTreeNode.collapsibleState = collapsibleState;
        this.cachedTreeNode.contextValue = contextValue;
        this.cachedTreeNode.node = this;
        this.cachedTreeNode.command = {
            command: 'platformio-debug.peripherals.selectedNode',
            arguments: [this],
            title: 'Selected Node',
        };
        this.cachedTreeNode.tooltip = this.description || label;
        this.cachedTreeNode.iconPath = undefined;
        this.cachedTreeNode.description = undefined;

        return this.cachedTreeNode;
    }

    getCopyValue(): string | null {
        return null;
    }

    setFormat(format: NumberFormat): void {
        this.format = format;
    }
}

function parseInteger(value: string): number | undefined {
    if (/^0b([01]+)$/i.test(value)) {
        return parseInt(value.substring(2), 2);
    }
    if (/^0x([0-9a-f]+)$/i.test(value)) {
        return parseInt(value.substring(2), 16);
    }
    if (/^[0-9]+$/i.test(value)) {
        return parseInt(value, 10);
    }
    if (/^#[0-1]+$/i.test(value)) {
        return parseInt(value.substring(1), 2);
    }
    return undefined;
}


function parseDimIndex(dimIndex: string, count: number): string[] {
    if (dimIndex.indexOf(',') !== -1) {
        const items = dimIndex.split(',').map((s) => s.trim());
        if (items.length !== count) {
            throw new Error('dimIndex Element has invalid specification.');
        }
        return items;
    }

    if (/^([0-9]+)\-([0-9]+)$/i.test(dimIndex)) {
        const parts = dimIndex.split('-').map((s) => parseInteger(s));
        const start = parts[0];
        if (parts[1] - start + 1 < count) {
            throw new Error('dimIndex Element has invalid specification.');
        }
        const result: string[] = [];
        for (let i = 0; i < count; i++) {
            result.push(`${start + i}`);
        }
        return result;
    }

    if (/^[a-zA-Z]\-[a-zA-Z]$/.test(dimIndex)) {
        const startChar = dimIndex.charCodeAt(0);
        if (dimIndex.charCodeAt(2) - startChar + 1 < count) {
            throw new Error('dimIndex Element has invalid specification.');
        }
        const result: string[] = [];
        for (let i = 0; i < count; i++) {
            result.push(String.fromCharCode(startChar + i));
        }
        return result;
    }

    return [];
}

class EnumerationValue {
    constructor(
        public name: string,
        public description: string,
        public value: bigint
    ) {}
}

// ============================================================================
// PeripheralNode
// ============================================================================

export class PeripheralNode extends BaseNode {
    public name: string;
    public description: string;
    public baseAddress: number;
    public totalLength: number;
    public groupName: string;
    public resetValue: bigint;
    public size: number;
    public children: BaseNode[] = [];
    public currentValue: number[];

    constructor(options: any) {
        super(RecordType.Peripheral);
        this.name = options.name;
        this.description = options.description;
        this.baseAddress = options.baseAddress;
        this.totalLength = options.totalLength;
        this.groupName = options.groupName || '';
        this.resetValue = options.resetValue !== undefined ? BigInt(options.resetValue) : 0n;
        this.size = options.size || 32;
        this.accessType = options.accessType;
    }

    getTreeNode(): TreeNode {
        const label = this.name + '  [' + hexFormat(this.baseAddress) + ']';
        return this.getOrCreateTreeNode(
            label,
            this.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
            'peripheral'
        );
    }

    getChildren(): BaseNode[] {
        return this.children;
    }

    setChildren(children: BaseNode[]): void {
        this.children = children;
        this.children.sort((a: any, b: any) => (a.offset > b.offset ? 1 : -1));
    }

    addChild(child: BaseNode): void {
        this.children.push(child);
        this.children.sort((a: any, b: any) => (a.offset > b.offset ? 1 : -1));
    }

    getBytes(offset: number, size: number): Uint8Array {
        try {
            return new Uint8Array(this.currentValue.slice(offset, offset + size));
        } catch (e) {
            return new Uint8Array(0);
        }
    }

    getAddress(offset: number): number {
        return this.baseAddress + offset;
    }

    getFormat(): NumberFormat {
        return this.format;
    }

    update(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            if (this.expanded) {
                vscode.debug.activeDebugSession
                    .customRequest('read-memory', {
                        address: this.baseAddress,
                        length: this.totalLength > 32768 ? 32768 : this.totalLength,
                    })
                    .then(
                        (result: any) => {
                            this.currentValue = result.bytes;
                            this.children.forEach((child) => child.update());
                            resolve(true);
                        },
                        (error: any) => {
                            reject(error);
                        }
                    );
            } else {
                resolve(false);
            }
        });
    }

    selected(): Promise<boolean> {
        return this.update();
    }

    dumpSettings(): any[] {
        const settings: any[] = [];
        if (this.format !== NumberFormat.Auto || this.expanded) {
            settings.push({
                node: `${this.name}`,
                expanded: this.expanded,
                format: this.format,
            });
        }
        this.children.forEach((child: any) => {
            settings.push(...child.dumpSettings(`${this.name}`));
        });
        return settings;
    }

    _findByPath(path: string[]): BaseNode | null {
        if (path.length === 0) {
            return this;
        }
        const child = (this.children as any[]).find((c) => c.name === path[0]);
        return child ? child._findByPath(path.slice(1)) : null;
    }
}

// ============================================================================
// ClusterNode
// ============================================================================

/** Register cluster at a common offset. */
export class ClusterNode extends BaseNode {
    public name: string;
    public description: string;
    public offset: number;
    public accessType: AccessType;
    public size: number;
    public resetValue: bigint;
    public children: BaseNode[] = [];

    constructor(public parent: any, options: any) {
        super(RecordType.Cluster);
        this.name = options.name;
        this.description = options.description;
        this.offset = options.addressOffset;
        this.accessType = options.accessType ?? parent.accessType ?? AccessType.ReadWrite;
        this.size = options.size || parent.size;
        this.resetValue = options.resetValue !== undefined ? BigInt(options.resetValue) : parent.resetValue;
        this.parent.addChild(this);
    }

    getTreeNode(): TreeNode {
        const label = `${this.name} [${hexFormat(this.offset, 0)}]`;
        return this.getOrCreateTreeNode(
            label,
            this.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
            'cluster'
        );
    }

    getChildren(): BaseNode[] {
        return this.children;
    }

    setChildren(children: BaseNode[]): void {
        this.children = children.slice(0, children.length);
        this.children.sort((a: any, b: any) => (a.offset > b.offset ? 1 : -1));
    }

    addChild(child: BaseNode): void {
        this.children.push(child);
        this.children.sort((a: any, b: any) => (a.offset > b.offset ? 1 : -1));
    }

    getBytes(offset: number, size: number): Uint8Array {
        return this.parent.getBytes(this.offset + offset, size);
    }

    getAddress(offset: number): number {
        return this.parent.getAddress(this.offset + offset);
    }

    getFormat(): NumberFormat {
        return this.format !== NumberFormat.Auto ? this.format : this.parent.getFormat();
    }

    update(): Promise<boolean> {
        return Promise.resolve(true);
    }

    dumpSettings(parentPath: string): any[] {
        const settings: any[] = [];
        if (this.format !== NumberFormat.Auto || this.expanded) {
            settings.push({
                node: `${parentPath}.${this.name}`,
                expanded: this.expanded,
                format: this.format,
            });
        }
        this.children.forEach((child: any) => {
            settings.push(...child.dumpSettings(`${parentPath}.${this.name}`));
        });
        return settings;
    }

    _findByPath(path: string[]): BaseNode | null {
        if (path.length === 0) {
            return this;
        }
        const child = (this.children as any[]).find((c) => c.name === path[0]);
        return child ? child._findByPath(path.slice(1)) : null;
    }
}

// ============================================================================
// RegisterNode
// ============================================================================

/** Single memory-mapped register with fields. */
export class RegisterNode extends BaseNode {
    public name: string;
    public description: string;
    public offset: number;
    public accessType: AccessType;
    public size: number;
    public resetValue: bigint;
    public currentValue: bigint;
    public previousValue: bigint;
    public valueChanged: boolean = false;
    public hexLength: number;
    public maxValue: bigint;
    public binaryRegex: RegExp;
    public hexRegex: RegExp;
    public children: BaseNode[] = [];

    constructor(public parent: any, options: any) {
        super(RecordType.Register);
        this.name = options.name;
        this.description = options.description;
        this.offset = options.addressOffset;
        this.accessType = options.accessType || parent.accessType;
        this.size = options.size || parent.size;
        this.resetValue = options.resetValue !== undefined ? BigInt(options.resetValue) : (parent.resetValue ?? 0n);
        this.currentValue = this.resetValue;
        this.previousValue = this.resetValue;
        this.hexLength = Math.ceil(this.size / 4);
        this.maxValue = 1n << BigInt(this.size);
        this.binaryRegex = new RegExp(`^0b[01]{1,${this.size}}$`, 'i');
        this.hexRegex = new RegExp(`^0x[0-9a-f]{1,${this.hexLength}}$`, 'i');
        this.parent.addChild(this);
    }

    reset(): void {
        this.currentValue = this.resetValue;
    }

    extractBits(offset: number, width: number): bigint {
        return extractBitsBigInt(this.currentValue, offset, width);
    }

    updateBits(offset: number, width: number, value: bigint): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const maxVal = 1n << BigInt(width);
            if (value < 0n || value >= maxVal) {
                return reject(
                    `Value entered is invalid. Maximum value for this field is ${maxVal - 1n} (${hexFormat(maxVal - 1n, 0)})`
                );
            }
            const mask = (maxVal - 1n) << BigInt(offset);
            const newValue = (this.currentValue & ~mask) | (value << BigInt(offset));
            this.updateValueInternal(newValue).then(resolve, reject);
        });
    }

    getTreeNode(): TreeNode {
        let contextValue = 'registerRW';
        if (this.accessType === AccessType.ReadOnly) {
            contextValue = 'registerRO';
        } else if (this.accessType === AccessType.WriteOnly) {
            contextValue = 'registerWO';
        }

        let label = `${this.name} [${hexFormat(this.offset, 0)}]`;
        if (this.accessType === AccessType.WriteOnly) {
            label += ' - <Write Only>';
        } else {
            switch (this.getFormat()) {
                case NumberFormat.Decimal:
                    label += ` = ${this.currentValue.toString()}`;
                    break;
                case NumberFormat.Binary:
                    label += ` = ${binaryFormat(this.currentValue, this.hexLength * 4, false, true)}`;
                    break;
                default:
                    label += ` = ${hexFormat(this.currentValue, this.hexLength)}`;
                    break;
            }
        }

        const collapsible =
            this.children && this.children.length > 0
                ? this.expanded
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None;

        const treeNode = this.getOrCreateTreeNode(label, collapsible, contextValue);

        // Highlight registers whose value differs from the documented reset value.
        // Recently changed registers get an additional indicator.
        if (this.currentValue !== this.resetValue) {
            const color = this.valueChanged
                ? new vscode.ThemeColor('charts.orange')
                : new vscode.ThemeColor('charts.yellow');
            treeNode.iconPath = new vscode.ThemeIcon('circle-filled', color);
            const tooltipParts: string[] = [];
            if (this.description) {
                tooltipParts.push(this.description);
            }
            tooltipParts.push(`Reset: ${hexFormat(this.resetValue, this.hexLength)}`);
            tooltipParts.push(`Current: ${hexFormat(this.currentValue, this.hexLength)}`);
            if (this.valueChanged) {
                tooltipParts.push(`Previous: ${hexFormat(this.previousValue, this.hexLength)}`);
            }
            treeNode.tooltip = tooltipParts.join('\n');
        }

        return treeNode;
    }

    getChildren(): BaseNode[] {
        return this.children || [];
    }

    setChildren(children: BaseNode[]): void {
        this.children = children.slice(0, children.length);
        this.children.sort((a: any, b: any) => (a.offset > b.offset ? 1 : -1));
    }

    addChild(child: BaseNode): void {
        this.children.push(child);
        this.children.sort((a: any, b: any) => (a.offset > b.offset ? 1 : -1));
    }

    getFormat(): NumberFormat {
        return this.format !== NumberFormat.Auto ? this.format : this.parent.getFormat();
    }

    getCopyValue(): string {
        switch (this.getFormat()) {
            case NumberFormat.Decimal:
                return this.currentValue.toString();
            case NumberFormat.Binary:
                return binaryFormat(this.currentValue, this.hexLength * 4);
            default:
                return hexFormat(this.currentValue, this.hexLength);
        }
    }

    performUpdate(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            vscode.window
                .showInputBox({ prompt: 'Enter new value: (prefix hex with 0x, binary with 0b)' })
                .then((input) => {
                    // Handle cancellation (undefined input)
                    if (input === undefined) {
                        return resolve(false);
                    }
                    
                    let value: bigint;
                    try {
                        if (input.match(this.hexRegex)) {
                            value = BigInt('0x' + input.substring(2));
                        } else if (input.match(this.binaryRegex)) {
                            value = BigInt('0b' + input.substring(2));
                        } else if (input.match(/^[0-9]+$/)) {
                            value = BigInt(input);
                            if (value >= this.maxValue) {
                                return reject(
                                    `Value entered (${value}) is greater than the maximum value of ${this.maxValue - 1n}`
                                );
                            }
                        } else {
                            return reject('Value entered is not a valid format.');
                        }
                    } catch {
                        return reject('Value entered is not a valid format.');
                    }
                    this.updateValueInternal(value).then(resolve, reject);
                });
        });
    }

    private updateValueInternal(newValue: bigint): Promise<boolean> {
        const address = this.parent.getAddress(this.offset);
        const bytes: string[] = [];
        const byteCount = this.size / 8;

        let remaining = newValue;
        for (let i = 0; i < byteCount; i++) {
            const byte = Number(remaining & 0xFFn);
            remaining >>= 8n;
            let hexByte = byte.toString(16);
            if (hexByte.length === 1) {
                hexByte = '0' + hexByte;
            }
            bytes[i] = hexByte;
        }

        return new Promise((resolve, reject) => {
            vscode.debug.activeDebugSession
                .customRequest('write-memory', { address, data: bytes.join('') })
                .then(
                    (result: any) => {
                        this.parent.update().then(
                            () => {},
                            () => {}
                        );
                        resolve(true);
                    },
                    reject
                );
        });
    }

    update(): Promise<boolean> {
        const byteCount = this.size / 8;
        const bytes = this.parent.getBytes(this.offset, byteCount);
        if (bytes.length < byteCount) {
            return Promise.resolve(false);
        }
        const buffer = Buffer.from(bytes);

        const prior = this.currentValue;
        switch (byteCount) {
            case 1:
                this.currentValue = BigInt(buffer.readUInt8(0));
                break;
            case 2:
                this.currentValue = BigInt(buffer.readUInt16LE(0));
                break;
            case 4:
                this.currentValue = BigInt(buffer.readUInt32LE(0));
                break;
            case 8:
                this.currentValue = buffer.readBigUInt64LE(0);
                break;
            default:
                vscode.window.showErrorMessage(
                    `Register ${this.name} has invalid size: ${this.size}. Should be 8, 16, 32 or 64.`
                );
        }

        // Track value changes between successive reads to drive change highlighting.
        this.valueChanged = this.currentValue !== prior;
        this.previousValue = prior;

        this.children.forEach((child) => child.update());
        return Promise.resolve(true);
    }

    dumpSettings(parentPath: string): any[] {
        const settings: any[] = [];
        if (this.format !== NumberFormat.Auto || this.expanded) {
            settings.push({
                node: `${parentPath}.${this.name}`,
                expanded: this.expanded,
                format: this.format,
            });
        }
        this.children.forEach((child: any) => {
            settings.push(...child.dumpSettings(`${parentPath}.${this.name}`));
        });
        return settings;
    }

    _findByPath(path: string[]): BaseNode | null {
        if (path.length === 0) {
            return this;
        }
        if (path.length === 1) {
            return (this.children as any[]).find((c) => c.name === path[0]);
        }
        return null;
    }
}

// ============================================================================
// FieldNode
// ============================================================================

/** Named bit-field within a register. */
export class FieldNode extends BaseNode {
    public name: string;
    public description: string;
    public offset: number;
    public width: number;
    public accessType: AccessType;
    public enumeration: any;
    public enumerationMap: { [name: string]: bigint };
    public enumerationValues: string[];

    constructor(public parent: RegisterNode, options: any) {
        super(RecordType.Field);
        this.name = options.name;
        this.description = options.description;
        this.offset = options.offset;
        this.width = options.width;

        if (options.accessType) {
            if (parent.accessType === AccessType.ReadOnly && options.accessType !== AccessType.ReadOnly) {
                this.accessType = AccessType.ReadOnly;
            } else if (parent.accessType === AccessType.WriteOnly && options.accessType !== AccessType.WriteOnly) {
                this.accessType = AccessType.WriteOnly;
            } else {
                this.accessType = options.accessType;
            }
        } else {
            this.accessType = parent.accessType;
        }

        if (options.enumeration) {
            this.enumeration = options.enumeration;
            this.enumerationMap = {};
            this.enumerationValues = [];
            for (const key in options.enumeration) {
                const entry = options.enumeration[key];
                const name = entry.name;
                this.enumerationValues.push(name);
                // Store the bigint value directly from the EnumerationValue
                this.enumerationMap[name] = entry.value;
            }
        }

        this.parent.addChild(this);
    }

    getTreeNode(): TreeNode {
        const value = this.parent.extractBits(this.offset, this.width);
        let enumEntry: EnumerationValue | null = null;
        let label = this.name;
        const startBit = this.offset;
        let contextValue = 'field';

        label += `[${this.offset + this.width - 1}:${startBit}]`;

        if (this.name.toLowerCase() === 'reserved') {
            contextValue = 'field-res';
        } else if (this.accessType === AccessType.WriteOnly) {
            label += ' - <Write Only>';
        } else {
            let formattedValue = '';
            switch (this.getFormat()) {
                case NumberFormat.Decimal:
                    formattedValue = value.toString();
                    break;
                case NumberFormat.Binary:
                    formattedValue = binaryFormat(value, this.width);
                    break;
                case NumberFormat.Hexidecimal:
                    formattedValue = hexFormat(value, Math.ceil(this.width / 4), true);
                    break;
                default:
                    formattedValue =
                        this.width >= 4
                            ? hexFormat(value, Math.ceil(this.width / 4), true)
                            : binaryFormat(value, this.width);
                    break;
            }

            if (this.enumeration && this.enumeration[value.toString()]) {
                enumEntry = this.enumeration[value.toString()];
                label += ` = ${enumEntry.name} (${formattedValue})`;
            } else {
                label += ` = ${formattedValue}`;
            }
        }

        if (this.parent.accessType === AccessType.ReadOnly) {
            contextValue = 'field-ro';
        }

        return this.getOrCreateTreeNode(label, vscode.TreeItemCollapsibleState.None, contextValue);
    }

    performUpdate(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            if (this.enumeration) {
                vscode.window.showQuickPick(this.enumerationValues).then(
                    (selected) => {
                        if (selected === undefined) {
                            return resolve(false);
                        }
                        const value = this.enumerationMap[selected];
                        this.parent.updateBits(this.offset, this.width, value).then(resolve, reject);
                    }
                );
            } else {
                vscode.window
                    .showInputBox({ prompt: 'Enter new value: (prefix hex with 0x, binary with 0b)' })
                    .then((input) => {
                        // Handle cancellation
                        if (input === undefined) {
                            return resolve(false);
                        }
                        
                        const value = parseBigInt(input);
                        if (value === undefined) {
                            return reject('Unable to parse input value.');
                        }
                        this.parent.updateBits(this.offset, this.width, value).then(resolve, reject);
                    });
            }
        });
    }

    getCopyValue(): string {
        const value = this.parent.extractBits(this.offset, this.width);
        switch (this.getFormat()) {
            case NumberFormat.Decimal:
                return value.toString();
            case NumberFormat.Binary:
                return binaryFormat(value, this.width);
            case NumberFormat.Hexidecimal:
                return hexFormat(value, Math.ceil(this.width / 4), true);
            default:
                return this.width >= 4
                    ? hexFormat(value, Math.ceil(this.width / 4), true)
                    : binaryFormat(value, this.width);
        }
    }

    getFormat(): NumberFormat {
        return this.format !== NumberFormat.Auto ? this.format : this.parent.getFormat();
    }

    dumpSettings(parentPath: string): any[] {
        if (this.format !== NumberFormat.Auto) {
            return [{ node: `${parentPath}.${this.name}`, format: this.format }];
        }
        return [];
    }

    _findByPath(path: string[]): BaseNode | null {
        return path.length === 0 ? this : null;
    }
}

// ============================================================================
// PeripheralTreeProvider
// ============================================================================

/** TreeDataProvider for platformio-debug.peripherals. */
export class PeripheralTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    public onDidChangeTreeData = this._onDidChangeTreeData.event;
    private peripherials: PeripheralNode[] = [];
    private loaded: boolean = false;
    private viewExpanded: boolean = false;
    private svdPath: string;
    private initialSettings: any[];
    private treeView: vscode.TreeView<TreeNode> | undefined;

    /** Stores a reference to the TreeView so search can reveal entries. */
    setTreeView(treeView: vscode.TreeView<TreeNode>): void {
        this.treeView = treeView;
    }

    /** Returns the currently configured SVD path (if any). */
    getSVDPath(): string | undefined {
        return this.svdPath;
    }

    /** Returns the loaded peripheral nodes (used for testing/search). */
    getPeripherals(): PeripheralNode[] {
        return this.peripherials;
    }

    /** Refreshes the tree view. */
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /** Serialises expansion/format settings. */
    dumpSettings(): any[] {
        const settings: any[] = [];
        this.peripherials.forEach((peripheral) => {
            settings.push(...peripheral.dumpSettings());
        });
        return settings;
    }

    /** Parses SVD field definitions. */
    _parseFields(fieldDefs: any[], parent: RegisterNode): FieldNode[] {
        const fields: FieldNode[] = [];
        fieldDefs.map((field) => {
            let offset: number;
            let width: number;
            const description = field.description ? field.description : '';

            if (field.bitOffset !== undefined && field.bitWidth !== undefined) {
                offset = parseInteger(field.bitOffset);
                width = parseInteger(field.bitWidth);
            } else if (field.bitRange) {
                let range = String(field.bitRange);
                range = range.substring(1, range.length - 1);
                const parts = range.split(':');
                const msb = parseInteger(parts[0]);
                const lsb = parseInteger(parts[1]);
                width = msb - lsb + 1;
                offset = lsb;
            } else if (field.msb !== undefined && field.lsb !== undefined) {
                const msb = parseInteger(field.msb);
                const lsb = parseInteger(field.lsb);
                width = msb - lsb + 1;
                offset = lsb;
            } else {
                throw new Error(
                    `Unable to parse SVD file: field ${field.name} must have either bitOffset and bitWidth elements, bitRange Element, or msb and lsb elements.`
                );
            }

            let enumeration: any = null;
            if (field.enumeratedValues) {
                enumeration = {};
                const enumValues = field.enumeratedValues.enumeratedValue;
                enumValues.map((enumVal: any) => {
                    if (enumVal.value !== undefined) {
                        const name = enumVal.name;
                        const desc = enumVal.description ? enumVal.description : name;
                        const val = parseBigInt(String(enumVal.value));
                        if (val === undefined) {
                            console.warn(`Failed to parse enumeration value for ${name}: ${enumVal.value}`);
                            return;
                        }
                        enumeration[val.toString()] = new EnumerationValue(name, desc, val);
                    }
                });
                if (Object.keys(enumeration).length === 0) {
                    enumeration = null;
                }
            }

            const fieldOptions: any = {
                name: field.name,
                description,
                offset,
                width,
                enumeration,
            };

            if (field.dim) {
                if (!field.dimIncrement) {
                    throw new Error(
                        `Unable to parse SVD file: field ${field.name} has dim element, with no dimIncrement element.`
                    );
                }
                const dimCount = parseInteger(field.dim);
                const dimIncrement = parseInteger(field.dimIncrement);
                let dimIndices: string[] = [];
                if (field.dimIndex) {
                    dimIndices = parseDimIndex(field.dimIndex, dimCount);
                } else {
                    for (let i = 0; i < dimCount; i++) {
                        dimIndices.push(`${i}`);
                    }
                }
                const baseName = field.name;
                const baseOffset = offset;
                for (let i = 0; i < dimCount; i++) {
                    const name = baseName.replace('%s', dimIndices[i]);
                    fields.push(
                        new FieldNode(parent, {
                            ...fieldOptions,
                            name,
                            offset: baseOffset + dimIncrement * i,
                        })
                    );
                }
            } else {
                fields.push(new FieldNode(parent, { ...fieldOptions }));
            }
        });
        return fields;
    }

    /** Parses SVD register definitions (with dim). */
    _parseRegisters(registerDefs: any[], parent: any): RegisterNode[] {
        const registers: RegisterNode[] = [];
        registerDefs.forEach((reg) => {
            const options: any = {};
            if (reg.description) {
                options.description = reg.description;
            }
            if (reg.access) {
                options.accessType = ACCESS_MAP[reg.access];
            }
            if (reg.size) {
                options.size = parseInteger(reg.size);
            }
            if (reg.resetValue) {
                const parsed = parseBigInt(reg.resetValue);
                if (parsed !== undefined) {
                    options.resetValue = parsed;
                }
            }

            if (reg.dim) {
                if (!reg.dimIncrement) {
                    throw new Error(
                        `Unable to parse SVD file: register ${reg.name} has dim element, with no dimIncrement element.`
                    );
                }
                const dimCount = parseInteger(reg.dim);
                const dimIncrement = parseInteger(reg.dimIncrement);
                let dimIndices: string[] = [];
                if (reg.dimIndex) {
                    dimIndices = parseDimIndex(reg.dimIndex, dimCount);
                } else {
                    for (let i = 0; i < dimCount; i++) {
                        dimIndices.push(`${i}`);
                    }
                }
                const baseName = reg.name;
                const baseOffset = parseInteger(reg.addressOffset);
                for (let i = 0; i < dimCount; i++) {
                    const name = baseName.replace('%s', dimIndices[i]);
                    const registerNode = new RegisterNode(parent, {
                        ...options,
                        name,
                        addressOffset: baseOffset + dimIncrement * i,
                    });
                    if (reg.fields && reg.fields.field) {
                        this._parseFields(reg.fields.field, registerNode);
                    }
                    registers.push(registerNode);
                }
            } else {
                const registerNode = new RegisterNode(parent, {
                    ...options,
                    name: reg.name,
                    addressOffset: parseInteger(reg.addressOffset),
                });
                if (reg.fields && reg.fields.field) {
                    this._parseFields(reg.fields.field, registerNode);
                }
                registers.push(registerNode);
            }
        });
        registers.sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
        return registers;
    }

    /** Parses SVD cluster definitions (with dim). */
    _parseClusters(clusterDefs: any[], parent: any): ClusterNode[] {
        const clusters: ClusterNode[] = [];
        if (!clusterDefs) {
            return [];
        }
        clusterDefs.forEach((cluster) => {
            const options: any = {};
            if (cluster.description) {
                options.description = cluster.description;
            }
            if (cluster.access) {
                options.accessType = ACCESS_MAP[cluster.access];
            }
            if (cluster.size) {
                options.size = parseInteger(cluster.size);
            }
            if (cluster.resetValue) {
                const parsed = parseBigInt(cluster.resetValue);
                if (parsed !== undefined) {
                    options.resetValue = parsed;
                }
            }

            if (cluster.dim) {
                if (!cluster.dimIncrement) {
                    throw new Error(
                        `Unable to parse SVD file: cluster ${cluster.name} has dim element, with no dimIncrement element.`
                    );
                }
                const dimCount = parseInteger(cluster.dim);
                const dimIncrement = parseInteger(cluster.dimIncrement);
                let dimIndices: string[] = [];
                if (cluster.dimIndex) {
                    dimIndices = parseDimIndex(cluster.dimIndex, dimCount);
                } else {
                    for (let i = 0; i < dimCount; i++) {
                        dimIndices.push(`${i}`);
                    }
                }
                const baseName = cluster.name;
                const baseOffset = parseInteger(cluster.addressOffset);
                for (let i = 0; i < dimCount; i++) {
                    const name = baseName.replace('%s', dimIndices[i]);
                    const clusterNode = new ClusterNode(parent, {
                        ...options,
                        name,
                        addressOffset: baseOffset + dimIncrement * i,
                    });
                    if (cluster.register) {
                        this._parseRegisters(cluster.register, clusterNode);
                    }
                    clusters.push(clusterNode);
                }
            } else {
                const clusterNode = new ClusterNode(parent, {
                    ...options,
                    name: cluster.name,
                    addressOffset: parseInteger(cluster.addressOffset),
                });
                if (cluster.register) {
                    this._parseRegisters(cluster.register, clusterNode);
                    clusters.push(clusterNode);
                }
            }
        });
        return clusters;
    }

    /**
     * Computes the byte span covered by the peripheral's parsed registers/clusters.
     * Used as a fallback for `totalLength` when the SVD lacks an addressBlock.
     */
    private _computeCoveredRange(parent: any): number {
        let max = 0;
        const children: any[] = parent.children || [];
        for (const child of children) {
            const offset: number = child.offset || 0;
            if (child instanceof RegisterNode) {
                const sizeBits: number = child.size || parent.size || 32;
                const sizeBytes = Math.ceil(sizeBits / 8);
                if (offset + sizeBytes > max) {
                    max = offset + sizeBytes;
                }
            } else if (child instanceof ClusterNode) {
                const inner = this._computeCoveredRange(child);
                if (offset + inner > max) {
                    max = offset + inner;
                }
            }
        }
        return max;
    }

    /** Builds a PeripheralNode from SVD peripheral. */
    _parsePeripheral(peripheralDef: any, defaults: any): PeripheralNode {
        const options: any = {
            name: peripheralDef.name,
            baseAddress: parseInteger(peripheralDef.baseAddress),
            description: peripheralDef.description ? peripheralDef.description : '',
            totalLength: peripheralDef.addressBlock ? parseInteger(peripheralDef.addressBlock.size) : 0,
        };

        // Apply device-level defaults first
        if (defaults.size !== undefined) {
            options.size = defaults.size;
        }
        if (defaults.resetValue !== undefined) {
            options.resetValue = defaults.resetValue;
        }
        if (defaults.accessType !== undefined) {
            options.accessType = defaults.accessType;
        }

        // Override with peripheral-specific values
        if (peripheralDef.access) {
            options.accessType = ACCESS_MAP[peripheralDef.access];
        }
        if (peripheralDef.size) {
            options.size = parseInteger(peripheralDef.size);
        }
        if (peripheralDef.resetValue) {
            const parsed = parseBigInt(peripheralDef.resetValue);
            if (parsed !== undefined) {
                options.resetValue = parsed;
            }
        }
        if (peripheralDef.groupName) {
            options.groupName = peripheralDef.groupName;
        }

        const peripheral = new PeripheralNode(options);

        if (peripheralDef.registers?.register) {
            this._parseRegisters(peripheralDef.registers.register, peripheral);
        }
        if (peripheralDef.registers?.cluster) {
            this._parseClusters(peripheralDef.registers.cluster, peripheral);
        }

        // Fallback: when no addressBlock is provided, derive the total span
        // from the maximum offset+size covered by registers/clusters so that
        // memory reads request a non-zero, correct length.
        if (!peripheral.totalLength) {
            peripheral.totalLength = this._computeCoveredRange(peripheral);
        }

        return peripheral;
    }

    /**
     * Resolves transitive `<peripheral derivedFrom="...">` chains.
     * Each derived peripheral inherits the base's properties (including
     * registers/clusters) while keeping its own overrides such as name and
     * baseAddress.
     */
    private _resolvePeripheralDerivedFrom(peripheralMap: { [name: string]: any }): void {
        const resolved: { [name: string]: boolean } = {};
        const resolve = (name: string, visiting: Set<string>): void => {
            if (resolved[name]) {
                return;
            }
            if (visiting.has(name)) {
                throw new Error(`Circular derivedFrom reference detected at peripheral ${name}`);
            }
            const periph = peripheralMap[name];
            const baseName: string | undefined = periph?.['@_derivedFrom'];
            if (!baseName || !peripheralMap[baseName]) {
                resolved[name] = true;
                return;
            }
            visiting.add(name);
            resolve(baseName, visiting);
            visiting.delete(name);
            peripheralMap[name] = { ...peripheralMap[baseName], ...periph };
            // Drop the marker so we don't re-process if called again.
            delete peripheralMap[name]['@_derivedFrom'];
            resolved[name] = true;
        };

        for (const name in peripheralMap) {
            resolve(name, new Set<string>());
        }
    }

    /**
     * Resolves register, cluster and field `derivedFrom` references within a
     * single peripheral. The lookup is by simple name and supports clusters
     * deriving from clusters and registers deriving from registers.
     */
    private _resolveInnerDerivedFrom(periph: any): void {
        if (!periph?.registers) {
            return;
        }

        // In-place merge that mutates the stored object so that array entries
        // also see the inherited properties.
        const merge = (map: { [name: string]: any }, name: string, visiting: Set<string>): void => {
            const node = map[name];
            const baseName: string | undefined = node?.['@_derivedFrom'];
            if (!baseName || !map[baseName]) {
                return;
            }
            if (visiting.has(name)) {
                throw new Error(`Circular derivedFrom reference detected at ${name}`);
            }
            visiting.add(name);
            merge(map, baseName, visiting);
            visiting.delete(name);
            const merged = { ...map[baseName], ...node };
            delete merged['@_derivedFrom'];
            // Mutate the existing object so array references stay consistent.
            for (const key of Object.keys(node)) {
                delete node[key];
            }
            Object.assign(node, merged);
        };

        const resolveArray = (items: any[]): void => {
            const map: { [name: string]: any } = {};
            for (const item of items) {
                if (item?.name) {
                    map[item.name] = item;
                }
            }
            for (const name in map) {
                merge(map, name, new Set<string>());
            }
        };

        const resolveFields = (registersList: any[]): void => {
            for (const reg of registersList) {
                const fields: any[] = reg?.fields?.field;
                if (Array.isArray(fields)) {
                    resolveArray(fields);
                }
            }
        };

        const registers: any[] = Array.isArray(periph.registers.register)
            ? periph.registers.register
            : [];
        const clusters: any[] = Array.isArray(periph.registers.cluster)
            ? periph.registers.cluster
            : [];

        resolveArray(registers);
        resolveArray(clusters);

        // Resolve nested registers and fields within clusters.
        for (const cluster of clusters) {
            if (Array.isArray(cluster.register)) {
                resolveArray(cluster.register);
                resolveFields(cluster.register);
            }
        }

        // Resolve fields inside top-level registers.
        resolveFields(registers);
    }

    /** Reads/parses SVD XML file. */
    _loadSVD(svdPath: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            fs.readFile(svdPath, 'utf8', (err, data) => {
                if (err) {
                    return reject(err);
                }
                try {
                    const parser = new XMLParser({
                        ignoreAttributes: false,
                        isArray: (_name: string, jpath: string) => {
                            const arrayPaths = [
                                'device.peripherals.peripheral',
                                'device.peripherals.peripheral.registers.register',
                                'device.peripherals.peripheral.registers.cluster',
                                'device.peripherals.peripheral.registers.cluster.register',
                            ];
                            return arrayPaths.includes(jpath) || jpath.endsWith('.fields.field') || jpath.endsWith('.enumeratedValues.enumeratedValue');
                        },
                    });
                    const result = parser.parse(data);

                    const peripheralMap: { [name: string]: any } = {};
                    const defaults: any = {
                        accessType: AccessType.ReadWrite,
                        size: 32,
                        resetValue: 0n,
                    };

                    if (result.device.resetValue) {
                        const parsed = parseBigInt(result.device.resetValue);
                        if (parsed !== undefined) {
                            defaults.resetValue = parsed;
                        }
                    }
                    if (result.device.size) {
                        defaults.size = parseInteger(result.device.size);
                    }
                    if (result.device.access) {
                        defaults.accessType = ACCESS_MAP[result.device.access];
                    }

                    result.device.peripherals.peripheral.forEach((periph: any) => {
                        const name = periph.name;
                        peripheralMap[name] = periph;
                    });

                    // Handle derived peripherals (including transitive chains)
                    this._resolvePeripheralDerivedFrom(peripheralMap);

                    // Resolve register/cluster/field derivedFrom within each peripheral
                    for (const name in peripheralMap) {
                        this._resolveInnerDerivedFrom(peripheralMap[name]);
                    }

                    this.peripherials = [];
                    for (const name in peripheralMap) {
                        this.peripherials.push(this._parsePeripheral(peripheralMap[name], defaults));
                    }

                    this.peripherials.sort((a, b) =>
                        a.groupName > b.groupName
                            ? 1
                            : a.groupName < b.groupName
                            ? -1
                            : a.name > b.name
                            ? 1
                            : a.name < b.name
                            ? -1
                            : 0
                    );

                    return resolve(true);
                } catch (e) {
                    return reject(e);
                }
            });
        });
    }

    /** Resolves a dot path to a node. */
    _findNodeByPath(path: string): BaseNode | null {
        const parts = path.split('.');
        const peripheral = this.peripherials.find((p) => p.name === parts[0]);
        return peripheral ? peripheral._findByPath(parts.slice(1)) : null;
    }

    /** Returns the tree item unchanged. */
    getTreeItem(element: TreeNode): TreeNode {
        return element;
    }

    /** Returns child nodes; triggers initial load. */
    getChildren(element?: TreeNode): TreeNode[] {
        this.viewExpanded = true;
        if (!vscode.debug.activeDebugSession) {
            return [];
        }

        if (this.peripherials.length > 0) {
            if (element) {
                return element.node.getChildren().map((child) => child.getTreeNode());
            }
            return this.peripherials.map((p) => p.getTreeNode());
        }

        if (!this.loaded) {
            this._update();
        }

        return [
            new TreeNode(
                this.svdPath ? 'Loading...' : 'No Information',
                vscode.TreeItemCollapsibleState.None,
                'message',
                null
            ),
        ];
    }

    private async _load(): Promise<boolean> {
        if (this.svdPath) {
            this.loaded = true;
            this.peripherials = [];
            return new Promise((resolve) => {
                setTimeout(async () => {
                    try {
                        await this._loadSVD(this.svdPath);
                        if (this.initialSettings) {
                            this.initialSettings.forEach((setting) => {
                                const node = this._findNodeByPath(setting.node);
                                if (node) {
                                    node.expanded = setting.expanded || false;
                                    node.format = setting.format;
                                }
                            });
                        }
                    } catch (e) {
                        this.peripherials = [];
                        vscode.window.showErrorMessage(`Unable to parse SVD file: ${e.toString()}`);
                    }
                    resolve(true);
                }, 1000);
            });
        }
    }

    private async _update(): Promise<void> {
        if (this.viewExpanded) {
            if (!this.loaded) {
                await this._load();
            }
            try {
                await Promise.all(this.peripherials.map((p) => p.update()));
            } catch (e) {
                // Ignore update errors
            }
            this.refresh();
        }
    }

    /** Triggers a register read on expand. */
    onDidExpandElement(event: any): void {
        event.element.node.expanded = true;
        event.element.node.update();
        this.refresh();
    }

    /** Marks node collapsed. */
    onDidCollapseElement(event: any): void {
        event.element.node.expanded = false;
    }

    /** Resets list; records SVD path and settings. */
    debugSessionStarted(svdPath: string, savedState: any[]): void {
        this.peripherials = [];
        this.loaded = false;
        this.svdPath = svdPath;
        this.initialSettings = savedState;
    }

    /**
     * Searches well-known locations for a `.svd` file.
     * Order:
     *   1. workspaceRoot/.vscode/*.svd
     *   2. workspaceRoot/*.svd
     *   3. ~/.platformio/packages/*\/svd/*.svd (e.g. framework-*, tool-openocd)
     * If a `deviceName` is provided, candidates whose filename contains the
     * device name (case-insensitive) are preferred.
     */
    public findSVDFile(deviceName?: string): string | undefined {
        const candidates: string[] = [];

        const collect = (dir: string): void => {
            try {
                if (!fs.existsSync(dir)) {
                    return;
                }
                const entries = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
                for (const entry of entries) {
                    if (entry.toLowerCase().endsWith('.svd')) {
                        candidates.push(path.join(dir, entry));
                    }
                }
            } catch {
                // Ignore IO errors during discovery.
            }
        };

        const folders = vscode.workspace.workspaceFolders || [];
        for (const folder of folders) {
            const root = folder.uri.fsPath;
            collect(path.join(root, '.vscode'));
            collect(root);
        }

        const pioPackages = path.join(os.homedir(), '.platformio', 'packages');
        try {
            if (fs.existsSync(pioPackages)) {
                const pkgs = fs.readdirSync(pioPackages).sort((a, b) => a.localeCompare(b));
                for (const pkg of pkgs) {
                    collect(path.join(pioPackages, pkg, 'svd'));
                }
            }
        } catch {
            // Ignore IO errors during discovery.
        }

        if (candidates.length === 0) {
            return undefined;
        }

        if (deviceName) {
            const lower = deviceName.toLowerCase();
            const match = candidates.find((c) =>
                path.basename(c).toLowerCase().includes(lower)
            );
            if (match) {
                return match;
            }
        }

        return candidates[0];
    }

    /**
     * Opens a QuickPick to filter peripherals by name/address/description and
     * reveals the chosen peripheral in the tree view.
     */
    public async search(): Promise<void> {
        if (this.peripherials.length === 0) {
            vscode.window.showInformationMessage('No peripherals are currently loaded.');
            return;
        }

        const items: vscode.QuickPickItem[] = this.peripherials.map((p) => ({
            label: p.name,
            description: hexFormat(p.baseAddress),
            detail: p.description,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Search peripherals by name, address, or description',
            matchOnDescription: true,
            matchOnDetail: true,
        });

        if (!selected) {
            return;
        }

        const peripheral = this.peripherials.find((p) => p.name === selected.label);
        if (!peripheral) {
            return;
        }

        const treeNode = peripheral.getTreeNode();
        peripheral.expanded = true;
        this.refresh();
        if (this.treeView) {
            try {
                await this.treeView.reveal(treeNode, {
                    select: true,
                    focus: true,
                    expand: true,
                });
            } catch {
                // reveal can fail if the node was just rebuilt; ignore.
            }
        }
    }

    /** Updates the SVD path and reloads the peripheral tree. */
    reloadSVD(svdPath: string): void {
        this.peripherials = [];
        this.loaded = false;
        this.svdPath = svdPath;
        this.refresh();
    }

    /** Clears list and refreshes. */
    debugSessionTerminated(): void {
        this.peripherials = [];
        this.loaded = false;
        this.refresh();
    }

    /** Updates peripherals on stop. */
    debugStopped(): Promise<void> {
        return this._update();
    }

    /** No-op on continue. */
    debugContinued(): void {}
}
