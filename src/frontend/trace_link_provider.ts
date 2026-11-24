import * as vscode from 'vscode';
import { isSyntheticSourcePath } from '../trace/elf/locationPath';

const FILE_LINE_RE = /\b((?:[a-zA-Z]:[\\/]|\/)?[^\s():"']+\.[a-zA-Z0-9_]+):(\d+)\b/g;

/**
 * Adds clickable `file:line` DocumentLinks to plain-text trace decode and origin documents.
 */
export class TraceDocumentLinkProvider implements vscode.DocumentLinkProvider {
    private readonly trackedUris = new Set<string>();

    trackDocument(uri: vscode.Uri): void {
        this.trackedUris.add(uri.toString());
    }

    untrackDocument(uri: vscode.Uri): void {
        this.trackedUris.delete(uri.toString());
    }

    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        if (!this.trackedUris.has(document.uri.toString())) {
            return [];
        }

        const links: vscode.DocumentLink[] = [];
        const lineCount = document.lineCount;
        for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
            const text = document.lineAt(lineIdx).text;
            FILE_LINE_RE.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = FILE_LINE_RE.exec(text)) !== null) {
                const file = match[1];
                const line = parseInt(match[2], 10);
                if (!Number.isFinite(line) || line <= 0 || isSyntheticSourcePath(file)) {
                    continue;
                }
                const start = new vscode.Position(lineIdx, match.index);
                const end = new vscode.Position(lineIdx, match.index + match[0].length);
                const args = encodeURIComponent(JSON.stringify([{ file, line }]));
                const target = vscode.Uri.parse(`command:platformio-debug.trace.openLocation?${args}`);
                const link = new vscode.DocumentLink(new vscode.Range(start, end), target);
                link.tooltip = `Open ${file}:${line}`;
                links.push(link);
            }
        }
        return links;
    }
}
