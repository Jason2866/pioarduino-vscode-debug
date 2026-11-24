import * as vscode from 'vscode';
import { TraceTreeProvider } from '../../src/frontend/trace_tree_provider';
import { TraceCaptureAnalysis } from '../../src/trace/commands';

function makeAnalysis(): TraceCaptureAnalysis {
    return {
        capturePath: '/ws/.pio/debug-trace/cap.esptrace',
        chip: 'esp32c5',
        elfPath: '/ws/.pio/build/env/fw.elf',
        cores: [
            {
                coreId: 0,
                note: {
                    chip: 'esp32c5',
                    elf_sha_status: 'match',
                    source: 'espt',
                } as any,
                diag: {
                    instructions: 100,
                    syncs: 2,
                    traps: 1,
                    gaps: 0,
                    warnings: 0,
                } as any,
                events: [],
                resolver: {
                    resolve: (pc: number) =>
                        pc === 0x42000100 ? { file: '/ws/src/main.c', line: 42 } : undefined,
                },
                image: {
                    symbolAt: (pc: number) => (pc === 0x42000100 ? 'app_main' : undefined),
                } as any,
                stats: {
                    sample_hits: new Map([
                        [JSON.stringify(['app_main', '/ws/src/main.c', 42]), 80],
                    ]),
                    block_hits: new Map(),
                    unresolved_pcs: new Map(),
                    total_instructions: 100,
                },
                history: { items: [], omitted: 0, truncated: false } as any,
                profile: { runs: [], instructions: 100 },
                origin: {
                    fault: { event: 'trap', cause: 5, epc: 0x42000100, interrupt: false },
                    complete: true,
                    stackCalls: () => [{ pc: 0x42000100, sp: 0x3fc00000 }],
                    branches: () => [{ pc: 0x42000100, taken: true }],
                } as any,
            },
        ],
    };
}

describe('TraceTreeProvider', () => {
    beforeEach(() => {
        (vscode.debug as any).activeDebugSession = undefined;
    });

    test('renders actions node without capture and includes session actions when active', () => {
        const provider = new TraceTreeProvider();
        const roots = provider.getChildren();
        expect(roots).toHaveLength(1);
        expect(roots[0].label).toBe('Trace Actions');
        expect(provider.getChildren(roots[0]).length).toBe(3);

        (vscode.debug as any).activeDebugSession = { type: 'platformio-debug' };
        const activeRoots = provider.getChildren();
        expect(provider.getChildren(activeRoots[0]).length).toBe(7);
    });

    test('renders capture, core, fault, and hotspot nodes with clickable openLocation commands', () => {
        const provider = new TraceTreeProvider();
        provider.setCapture(makeAnalysis());
        const roots = provider.getChildren();
        expect(roots).toHaveLength(2);
        const captureNode = roots[1];
        expect(captureNode.label).toBe('cap.esptrace');

        const captureChildren = provider.getChildren(captureNode);
        const coreNode = captureChildren[1];
        const coreSections = provider.getChildren(coreNode);

        const faultGroup = coreSections.find((n) => n.kind === 'faultGroup')!;
        const faultChildren = provider.getChildren(faultGroup);
        expect(faultChildren[0].command?.command).toBe('platformio-debug.trace.openLocation');
        expect(faultChildren[0].command?.arguments?.[0]).toEqual({
            file: '/ws/src/main.c',
            line: 42,
            elfPath: '/ws/.pio/build/env/fw.elf',
        });

        const hotspotsGroup = coreSections.find((n) => n.kind === 'hotspots')!;
        const hotspots = provider.getChildren(hotspotsGroup);
        expect(hotspots[0].label).toBe('app_main');
        expect(hotspots[0].command?.command).toBe('platformio-debug.trace.openLocation');
    });
});
