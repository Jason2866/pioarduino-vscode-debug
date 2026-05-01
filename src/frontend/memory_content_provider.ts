import * as vscode from 'vscode';
import { hexFormat, parseQuery } from '../utils';

/** Supported data types for memory interpretation. */
export enum MemoryDataType {
    U8 = 'u8',
    U16 = 'u16',
    U32 = 'u32',
    U64 = 'u64',
    I8 = 'i8',
    I16 = 'i16',
    I32 = 'i32',
    I64 = 'i64',
    Float = 'float',
    Double = 'double',
}

/** Endianness options. */
export enum Endianness {
    Little = 'little',
    Big = 'big',
}

/** TextDocumentContentProvider for examinememory://. */
export class MemoryContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public onDidChange = this._onDidChange.event;

    private readonly headerLines = 2;
    private firstBytePos = 10;
    private lastBytePos = this.firstBytePos + 48 - 1;
    private firstAsciiPos = this.lastBytePos + 3;
    private lastAsciiPos = this.firstAsciiPos + 16;

    private smallDecorationType = vscode.window.createTextEditorDecorationType({
        borderWidth: '1px',
        borderStyle: 'solid',
        overviewRulerColor: 'blue',
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        light: { borderColor: 'darkblue' },
        dark: { borderColor: 'lightblue' },
    });

    private diffDecorationType = vscode.window.createTextEditorDecorationType({
        overviewRulerColor: 'orange',
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        light: { backgroundColor: 'rgba(255, 140, 0, 0.25)' },
        dark: { backgroundColor: 'rgba(255, 165, 0, 0.25)' },
    });

    // New: Data type interpretation settings
    private dataType: MemoryDataType = MemoryDataType.U8;
    private endianness: Endianness = Endianness.Little;

    // ASCII column toggle
    private showAscii: boolean = true;

    // New: Track memory contents for data type display
    private currentBytes: number[] = [];
    private currentAddress: number = 0;

    // Memory diff tracking — per-URI to prevent cross-contamination between open windows
    private previousBytes: number[] = [];
    private readonly uriBytes = new Map<string, { current: number[]; previous: number[] }>();
    private readonly uriChangedOffsets = new Map<string, Set<number>>();
    // Per-URI display settings; fall back to global defaults when absent.
    private readonly uriSettings = new Map<string, { dataType?: MemoryDataType; endianness?: Endianness; showAscii?: boolean }>();

    /** Sets the data type for interpretation. */
    setDataType(type: MemoryDataType): void {
        this.dataType = type;
    }

    /** Gets the current data type. */
    getDataType(): MemoryDataType {
        return this.dataType;
    }

    /** Sets the endianness for multi-byte data types. */
    setEndianness(endianness: Endianness): void {
        this.endianness = endianness;
    }

    /** Gets the current endianness. */
    getEndianness(): Endianness {
        return this.endianness;
    }

    /** Toggles between little and big endian. */
    toggleEndianness(): void {
        this.endianness = this.endianness === Endianness.Little
            ? Endianness.Big
            : Endianness.Little;
    }

    /** Sets whether to show the ASCII column. */
    setShowAscii(show: boolean): void {
        this.showAscii = show;
    }

    /** Gets whether the ASCII column is shown. */
    getShowAscii(): boolean {
        return this.showAscii;
    }

    /** Toggles the ASCII column visibility. */
    toggleAsciiView(): void {
        this.showAscii = !this.showAscii;
    }

    /** Sets the data type for a specific document URI. */
    setDataTypeForUri(uriKey: string, type: MemoryDataType): void {
        const s = this.uriSettings.get(uriKey) ?? {};
        s.dataType = type;
        this.uriSettings.set(uriKey, s);
    }

    /** Gets the effective data type for a URI, falling back to the global default. */
    getDataTypeForUri(uriKey: string): MemoryDataType {
        return this.uriSettings.get(uriKey)?.dataType ?? this.dataType;
    }

    /** Toggles endianness for a specific document URI. */
    toggleEndiannessForUri(uriKey: string): void {
        const s = this.uriSettings.get(uriKey) ?? {};
        s.endianness = (s.endianness ?? this.endianness) === Endianness.Little
            ? Endianness.Big
            : Endianness.Little;
        this.uriSettings.set(uriKey, s);
    }

    /** Gets the effective endianness for a URI, falling back to the global default. */
    getEndiannessForUri(uriKey: string): Endianness {
        return this.uriSettings.get(uriKey)?.endianness ?? this.endianness;
    }

    /** Toggles the ASCII column for a specific document URI. */
    toggleAsciiViewForUri(uriKey: string): void {
        const s = this.uriSettings.get(uriKey) ?? {};
        s.showAscii = !(s.showAscii ?? this.showAscii);
        this.uriSettings.set(uriKey, s);
    }

    /** Returns byte offsets that differ between the last two reads. */
    getChangedOffsets(): number[] {
        return this.computeChangedOffsets(this.currentBytes, this.previousBytes);
    }

    /** Internal helper: returns changed offsets between two byte arrays. */
    private computeChangedOffsets(current: number[], previous: number[]): number[] {
        if (previous.length === 0 || previous.length !== current.length) {
            return [];
        }
        const changed: number[] = [];
        for (let i = 0; i < current.length; i++) {
            if (current[i] !== previous[i]) {
                changed.push(i);
            }
        }
        return changed;
    }

    /** Returns the previous bytes snapshot (from the last read). */
    getPreviousBytes(): number[] {
        return this.previousBytes.slice();
    }

    /** Returns hex+ASCII memory dump for the URI. */
    provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
        return new Promise((resolve, reject) => {
            const params = parseQuery(uri.query);
            const address = params.address.startsWith('0x')
                ? parseInt(params.address.substring(2), 16)
                : parseInt(params.address, 10);
            const length = params.length.startsWith('0x')
                ? parseInt(params.length.substring(2), 16)
                : parseInt(params.length, 10);

            this.currentAddress = address;

            vscode.debug.activeDebugSession
                .customRequest('read-memory', { address, length: length || 32 })
                .then(
                    (result: any) => {
                        const bytes: number[] = result.bytes;
                        this.currentBytes = bytes;

                        // Compute diff against the previous read of THIS specific URI to
                        // avoid cross-contamination when multiple memory windows are open.
                        const uriKey = uri.toString();
                        const uriState = this.uriBytes.get(uriKey) ?? { current: [], previous: [] };
                        const changedOffsets = new Set(this.computeChangedOffsets(bytes, uriState.current));
                        uriState.previous = uriState.current;
                        uriState.current = bytes.slice();
                        this.uriBytes.set(uriKey, uriState);
                        this.uriChangedOffsets.set(uriKey, changedOffsets);

                        // Resolve per-URI display settings, falling back to global defaults.
                        const uriOverrides = this.uriSettings.get(uriKey) ?? {};
                        const dataType = uriOverrides.dataType ?? this.dataType;
                        const endianness = uriOverrides.endianness ?? this.endianness;
                        const showAscii = uriOverrides.showAscii ?? this.showAscii;

                        let output = '';

                        // Header with data type info
                        const asciiHeader = showAscii ? '  | ASCII' : '';
                        output += `  Data Type: ${dataType}, Endianness: ${endianness}\n`;
                        output += `  Offset: 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F${asciiHeader}\n`;

                        let rowAddress = address - (address % 16);
                        const offset = address - rowAddress;
                        output += hexFormat(rowAddress, 8, false) + ': ';

                        let asciiStr = '';
                        for (let i = 0; i < offset; i++) {
                            output += '   ';
                            asciiStr += ' ';
                        }

                        for (let i = 0; i < length; i++) {
                            const byte = bytes[i];
                            output += hexFormat(byte, 2, false).toUpperCase() + ' ';
                            asciiStr +=
                                byte <= 32 || (byte >= 127 && byte <= 159)
                                    ? '.'
                                    : String.fromCharCode(bytes[i]);

                            if ((address + i) % 16 === 15 && i < length - 1) {
                                if (showAscii) {
                                    output += ' |' + asciiStr;
                                }
                                asciiStr = '';
                                output += '\n';
                                rowAddress += 16;
                                output += hexFormat(rowAddress, 8, false) + ': ';
                            }
                        }

                        const remaining = (16 - ((address + length) % 16)) % 16;
                        for (let i = 0; i < remaining; i++) {
                            output += '   ';
                        }
                        if (showAscii) {
                            output += ' |' + asciiStr;
                        }
                        output += '\n';

                        // Add data type interpretation section
                        const typeInfo = this.formatDataTypeInterpretation(bytes, address, dataType, endianness);
                        if (typeInfo) {
                            output += '\n  Data Type Interpretation:\n';
                            output += typeInfo;
                        }

                        // Add memory diff summary when bytes changed since last read
                        if (changedOffsets.size > 0) {
                            output += `\n  Diff: ${changedOffsets.size} byte(s) changed since last read\n`;
                        }

                        // Store the prior snapshot so getChangedOffsets() returns the true diff.
                        this.previousBytes = uriState.previous.slice();

                        resolve(output);
                    },
                    (error: any) => {
                        vscode.window.showErrorMessage(
                            `Unable to read memory from ${hexFormat(address, 8)} to ${hexFormat(address + length, 8)}`
                        );
                        reject(error.toString());
                    }
                );
        });
    }

    /** Formats data type interpretation of the bytes. */
    private formatDataTypeInterpretation(
        bytes: number[],
        baseAddress: number,
        dataType: MemoryDataType,
        endianness: Endianness
    ): string {
        if (bytes.length === 0) return '';

        const typeSize = this.getTypeSize(dataType);
        let output = '';
        let lineCount = 0;
        const maxLines = 16; // Limit output lines

        for (let i = 0; i < bytes.length && lineCount < maxLines; i += typeSize) {
            if (i + typeSize > bytes.length) break;

            const value = this.readValue(bytes, i, dataType, endianness);
            const address = baseAddress + i;

            output += `    ${hexFormat(address, 8)}: `;

            switch (dataType) {
                case MemoryDataType.U8:
                case MemoryDataType.U16:
                case MemoryDataType.U32:
                    output += `${value} (0x${value.toString(16).toUpperCase()})\n`;
                    break;
                case MemoryDataType.U64:
                    output += `${value} (0x${(value as bigint).toString(16).toUpperCase()})\n`;
                    break;
                case MemoryDataType.I8:
                case MemoryDataType.I16:
                case MemoryDataType.I32:
                    output += `${value}\n`;
                    break;
                case MemoryDataType.I64:
                    output += `${value}\n`;
                    break;
                case MemoryDataType.Float:
                    output += `${value}\n`;
                    break;
                case MemoryDataType.Double:
                    output += `${value}\n`;
                    break;
            }
            lineCount++;
        }

        return output;
    }

    /** Gets the size of a data type in bytes. */
    private getTypeSize(type: MemoryDataType): number {
        switch (type) {
            case MemoryDataType.U8:
            case MemoryDataType.I8:
                return 1;
            case MemoryDataType.U16:
            case MemoryDataType.I16:
                return 2;
            case MemoryDataType.U32:
            case MemoryDataType.I32:
            case MemoryDataType.Float:
                return 4;
            case MemoryDataType.U64:
            case MemoryDataType.I64:
            case MemoryDataType.Double:
                return 8;
            default:
                return 1;
        }
    }

    /** Reads a value from bytes at given offset with specified type and endianness. */
    private readValue(bytes: number[], offset: number, type: MemoryDataType, endianness: Endianness): number | bigint {
        const size = this.getTypeSize(type);
        const buf = Buffer.alloc(size);

        // Copy bytes
        for (let i = 0; i < size; i++) {
            buf[i] = bytes[offset + i];
        }

        // Reverse for big endian if needed
        if (endianness === Endianness.Big) {
            buf.reverse();
        }

        switch (type) {
            case MemoryDataType.U8:
                return buf.readUInt8(0);
            case MemoryDataType.U16:
                return buf.readUInt16LE(0);
            case MemoryDataType.U32:
                return buf.readUInt32LE(0);
            case MemoryDataType.U64:
                return buf.readBigUInt64LE(0);
            case MemoryDataType.I8:
                return buf.readInt8(0);
            case MemoryDataType.I16:
                return buf.readInt16LE(0);
            case MemoryDataType.I32:
                return buf.readInt32LE(0);
            case MemoryDataType.I64:
                return buf.readBigInt64LE(0);
            case MemoryDataType.Float:
                return buf.readFloatLE(0);
            case MemoryDataType.Double:
                return buf.readDoubleLE(0);
            default:
                return buf.readUInt8(0);
        }
    }

    /** Writes a single byte to memory at the given address. */
    async writeByte(address: number, value: number): Promise<boolean> {
        if (!vscode.debug.activeDebugSession) {
            return false;
        }

        if (!Number.isInteger(value) || value < 0 || value > 255) {
            vscode.window.showErrorMessage(
                `Invalid byte value ${value}: must be an integer in the range 0–255`
            );
            return false;
        }

        try {
            const hexValue = hexFormat(value, 2, false);
            await vscode.debug.activeDebugSession.customRequest('write-memory', {
                address,
                data: hexValue
            });
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to write memory at ${hexFormat(address, 8)}: ${error}`);
            return false;
        }
    }

    /** Writes multiple bytes to memory at the given address. */
    async writeBytes(address: number, bytes: number[]): Promise<boolean> {
        if (!vscode.debug.activeDebugSession) {
            return false;
        }

        for (const b of bytes) {
            if (!Number.isInteger(b) || b < 0 || b > 255) {
                vscode.window.showErrorMessage(
                    `Invalid byte value ${b}: each byte must be an integer in the range 0–255`
                );
                return false;
            }
        }

        try {
            const hexData = bytes.map(b => hexFormat(b, 2, false)).join('');
            await vscode.debug.activeDebugSession.customRequest('write-memory', {
                address,
                data: hexData
            });
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to write memory at ${hexFormat(address, 8)}: ${error}`);
            return false;
        }
    }

    /** Triggers a content refresh. */
    update(document: vscode.TextDocument): void {
        this._onDidChange.fire(document.uri);
    }

    /** Maps editor position to byte offset. */
    getOffset(position: vscode.Position): number | undefined {
        if (position.line < this.headerLines) {
            return undefined;
        }

        if (position.character < this.firstBytePos) {
            return;
        }

        if (position.character > this.lastBytePos && position.character < this.firstAsciiPos) {
            return;
        }

        let offset = 16 * Math.max(0, position.line - this.headerLines);

        if (position.character >= this.firstBytePos && position.character <= this.lastBytePos) {
            const charOffset = position.character - this.firstBytePos;
            offset += Math.floor(charOffset / 3);
            return offset;
        }

        if (position.character >= this.firstAsciiPos && position.character < this.lastAsciiPos) {
            offset += position.character - this.firstAsciiPos;
            return offset;
        }

        return;
    }

    /** Maps byte offset to editor position. */
    getPosition(offset: number, isAscii: boolean = false): vscode.Position {
        const normalizedOffset = Math.max(0, offset);
        const line = this.headerLines + Math.floor(normalizedOffset / 16);
        let character = normalizedOffset % 16;
        if (isAscii) {
            character += this.firstAsciiPos;
        } else {
            character = this.firstBytePos + 3 * character;
        }
        return new vscode.Position(line, character);
    }

    /** Builds ranges for a contiguous byte range. */
    getRanges(startOffset: number, endOffset: number, isAscii: boolean): vscode.Range[] {
        const startPos = this.getPosition(startOffset, isAscii);
        let endPos = this.getPosition(endOffset, isAscii);
        endPos = new vscode.Position(endPos.line, endPos.character + (isAscii ? 1 : 2));

        const ranges: vscode.Range[] = [];
        const startChar = isAscii ? this.firstAsciiPos : this.firstBytePos;
        const endChar = isAscii ? this.lastAsciiPos : this.lastBytePos;

        for (let line = startPos.line; line <= endPos.line; ++line) {
            const lineStart = new vscode.Position(line, line === startPos.line ? startPos.character : startChar);
            const lineEnd = new vscode.Position(line, line === endPos.line ? endPos.character : endChar);
            ranges.push(new vscode.Range(lineStart, lineEnd));
        }

        return ranges;
    }

    /** Applies diff decorations (highlighting changed bytes) to the given editor. */
    applyDiffDecorations(editor: vscode.TextEditor): void {
        const uriKey = editor.document.uri.toString();
        const changedOffsets = this.uriChangedOffsets.get(uriKey);
        if (!changedOffsets || changedOffsets.size === 0) {
            editor.setDecorations(this.diffDecorationType, []);
            return;
        }
        const ranges: vscode.Range[] = [];
        for (const offset of changedOffsets) {
            ranges.push(...this.getRanges(offset, offset, false));
            if (this.uriSettings.get(uriKey)?.showAscii ?? this.showAscii) {
                ranges.push(...this.getRanges(offset, offset, true));
            }
        }
        editor.setDecorations(this.diffDecorationType, ranges);
    }

    /** Applies decorations for the selected range. */
    handleSelection(event: vscode.TextEditorSelectionChangeEvent): void {
        const lineCount = event.textEditor.document.lineCount;
        if (
            event.selections[0].start.line + 1 === lineCount ||
            event.selections[0].end.line + 1 === lineCount
        ) {
            event.textEditor.setDecorations(this.smallDecorationType, []);
            return;
        }

        const startOffset = this.getOffset(event.selections[0].start);
        const endOffset = this.getOffset(event.selections[0].end);

        if (startOffset === undefined || endOffset === undefined) {
            event.textEditor.setDecorations(this.smallDecorationType, []);
            return;
        }

        let ranges = this.getRanges(startOffset, endOffset, false);
        ranges = ranges.concat(this.getRanges(startOffset, endOffset, true));
        event.textEditor.setDecorations(this.smallDecorationType, ranges);
    }
}
