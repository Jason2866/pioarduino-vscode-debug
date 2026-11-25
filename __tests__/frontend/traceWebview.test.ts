import * as vscode from 'vscode';
import {
    escapeHtml,
    filterAndPaginateEvents,
    TraceWebviewPanel,
} from '../../src/frontend/trace_webview';
import { TraceCaptureAnalysis, TraceCoreAnalysis } from '../../src/trace/commands';
import { InsnClass, LinkKind } from '../../src/trace/ir/events';

function makeCore(eventCount: number): TraceCoreAnalysis {
    const events: any[] = [];
    for (let i = 0; i < eventCount; i++) {
        if (i === eventCount - 1) {
            events.push({ event: 'trap', cause: 5, epc: 0x42000100, interrupt: false });
        } else {
            events.push({
                event: 'instruction',
                pc: 0x42000000 + i * 2,
                length: 2,
                cls: InsnClass.NONE,
                link: LinkKind.NONE,
            });
        }
    }
    return {
        coreId: 0,
        note: { chip: 'esp32c5', elf_sha_status: 'match', source: 'espt' } as any,
        diag: { instructions: eventCount - 1, syncs: 1, traps: 1, gaps: 0, warnings: 0 } as any,
        events,
        resolver: { resolve: () => ({ file: '/ws/src/main.c', line: 10 }) },
        image: {
            symbolAt: () => 'app_main',
            read: () => Buffer.from([0x01, 0x00]),
        } as any,
        stats: {
            sample_hits: new Map(),
            block_hits: new Map(),
            unresolved_pcs: new Map(),
            total_instructions: eventCount - 1,
        },
        history: { items: [], omitted: 0, truncated: false } as any,
        profile: { runs: [], instructions: 0 },
        origin: {
            fault: undefined,
            complete: true,
            stackCalls: () => [],
            branches: () => [],
        } as any,
    };
}

describe('trace_webview', () => {
    test('escapeHtml escapes special HTML characters', () => {
        expect(escapeHtml('<script>"a"&\'b\'</script>')).toBe('&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;');
    });

    test('filterAndPaginateEvents slices pages and jumps to fault', () => {
        const core = makeCore(12);
        const page0 = filterAndPaginateEvents(core, { page: 0, pageSize: 5 });
        expect(page0.totalPages).toBe(3);
        expect(page0.rows).toHaveLength(5);

        const jumped = filterAndPaginateEvents(core, { page: 0, pageSize: 5, jumpToFault: true });
        expect(jumped.page).toBe(2);
        expect(jumped.rows.some((r) => r.kind === 'trap')).toBe(true);

        const filtered = filterAndPaginateEvents(core, { page: 0, pageSize: 5, filter: 'cause=5' });
        expect(filtered.totalMatched).toBe(1);
        expect(filtered.rows[0].kind).toBe('trap');
    });

    test('TraceWebviewPanel renders CSP-protected HTML and dispatches messages', () => {
        let messageHandler: ((msg: any) => void) | undefined;
        const postMessage = jest.fn().mockResolvedValue(true);
        const mockWebview = {
            html: '',
            postMessage,
            onDidReceiveMessage: jest.fn((cb: any) => {
                messageHandler = cb;
                return { dispose: jest.fn() };
            }),
        };
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue({
            title: '',
            reveal: jest.fn(),
            dispose: jest.fn(),
            onDidDispose: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            webview: mockWebview,
        });

        const analysis: TraceCaptureAnalysis = {
            capturePath: '/ws/cap.esptrace',
            chip: 'esp32c5',
            elfPath: '/ws/fw.elf',
            cores: [makeCore(4)],
        };
        const onOpenLocation = jest.fn();
        const onExport = jest.fn();
        const panel = new TraceWebviewPanel();
        panel.show(analysis, { onOpenLocation, onExport });

        expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
            'pioarduinoTraceInspector',
            'ESP32 Trace: cap.esptrace',
            vscode.ViewColumn.One,
            expect.objectContaining({ enableScripts: true })
        );

        const cspMatch = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(mockWebview.html);
        expect(cspMatch).not.toBeNull();
        const csp = cspMatch![1];
        expect(csp).toContain("default-src 'none'");
        const scriptSrcMatch = /script-src\s+'nonce-([a-f0-9]+)'/.exec(csp);
        expect(scriptSrcMatch).not.toBeNull();
        expect(mockWebview.html).toContain(`<script nonce="${scriptSrcMatch![1]}">`);

        messageHandler?.({ type: 'openLocation', file: '/ws/src/main.c', line: 10 });
        expect(onOpenLocation).toHaveBeenCalledWith('/ws/src/main.c', 10, '/ws/fw.elf');

        messageHandler?.({ type: 'export', kind: 'speedscope', coreId: 0 });
        expect(onExport).toHaveBeenCalledWith('speedscope', 0, false);

        messageHandler?.({ type: 'export', kind: 'speedscope', coreId: 0, saveToFile: true });
        expect(onExport).toHaveBeenCalledWith('speedscope', 0, true);

        messageHandler?.({ type: 'requestInstructions', coreId: 0, page: 0, pageSize: 2 });
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'instructionsPage', coreId: 0, totalMatched: 4 })
        );
    });

    test('filterAndPaginateEvents jumps to core.origin.fault rather than an earlier non-fault trap', () => {
        const core = makeCore(6);
        const faultTrap = { event: 'trap', cause: 5, epc: 0x42000100, interrupt: false };
        core.events = [
            { event: 'trap', cause: 11, epc: 0x42000010, interrupt: false } as any,
            ...core.events.slice(0, 4),
            faultTrap as any,
        ];
        (core.origin as any).fault = faultTrap;

        const jumped = filterAndPaginateEvents(core, { page: 0, pageSize: 3, jumpToFault: true });
        expect(jumped.page).toBe(1);
    });
});
