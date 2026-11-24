/**
 * Unit tests for the trace-* custom requests in adapter.ts.
 *
 * Validates that trace-probe/trace-start/trace-stop/trace-dump build the right
 * `monitor esp riscv_trace ...` console commands, escape paths for MI quoting,
 * and return the captured OpenOCD output in the response body.
 */

jest.mock('@vscode/debugadapter', () => {
    class FakeHandles {
        private map = new Map<number, any>();
        private nextId = 1;
        create(v: any): number {
            const id = this.nextId++;
            this.map.set(id, v);
            return id;
        }
        get(id: number): any {
            return this.map.get(id);
        }
        reset(): void {
            this.map.clear();
            this.nextId = 1;
        }
    }

    class FakeDebugSession {
        sendResponse(_response: any) {}
        sendErrorResponse(_response: any, _code: number, _message: string) {}
        sendEvent(_event: any) {}
    }

    class FakeEvent {
        constructor(public event: string, public body?: any) {}
    }

    return {
        DebugSession: FakeDebugSession,
        Event: FakeEvent,
        Handles: FakeHandles,
        InitializedEvent: class extends FakeEvent { constructor() { super('initialized'); } },
        OutputEvent: class extends FakeEvent {},
        TerminatedEvent: class extends FakeEvent {},
        ThreadEvent: class extends FakeEvent {},
        Thread: class {},
        StackFrame: class {},
        Scope: class {},
        Source: class {},
        ContinuedEvent: class extends FakeEvent {},
    };
});

jest.mock('../../src/backend/mi2/mi2', () => ({
    MI2: class {
        sendCommand = jest.fn();
        isReady = jest.fn().mockReturnValue(true);
        on = jest.fn();
        emit = jest.fn();
    },
    escape: (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'),
}));

jest.mock('../../src/backend/symbols', () => ({
    SymbolTable: class {
        getFunctionSymbols() { return []; }
    },
}));

jest.mock('../../src/backend/rtos', () => ({
    RTOSManager: class {},
    RTOSType: { None: 'none' },
}));

jest.mock('../../src/common', () => ({
    StoppedEvent: class { constructor(public event: string, public body?: any) {} },
    AdapterOutputEvent: class { constructor(public event: string, public body?: any) {} },
}));

jest.mock('../../src/backend/expand_value', () => ({
    expandValue: jest.fn().mockReturnValue({}),
}));

jest.mock('../../src/backend/mi_parse', () => ({
    MINode: class {},
}));

import { GDBDebugSession } from '../../src/backend/adapter';
import { MI2 } from '../../src/backend/mi2/mi2';

function createSession(): any {
    const session = new GDBDebugSession() as any;
    session.miDebugger = new (MI2 as any)();
    session.sendResponse = jest.fn();
    session.sendErrorResponse = jest.fn();
    return session;
}

function makeResponse(): any {
    return { seq: 1, type: 'response', request_seq: 1, success: false, command: 'custom' };
}

function resolveWith(output: string) {
    return {
        then: (cb: any) => {
            cb({
                resultRecords: { resultClass: 'done', results: [] },
                consoleOutput: output,
            });
            return { catch: jest.fn() };
        },
    };
}

describe('adapter.ts — trace-* custom requests', () => {
    let session: any;

    beforeEach(() => {
        session = createSession();
        jest.clearAllMocks();
    });

    test('trace-probe sends bare `esp riscv_trace` monitor command', () => {
        session.miDebugger.sendCommand.mockReturnValue(resolveWith('unknown command'));
        const response = makeResponse();

        session.customRequest('trace-probe', response, {});

        expect(session.miDebugger.sendCommand).toHaveBeenCalledWith(
            'interpreter-exec console "monitor esp riscv_trace"',
            false,
            true
        );
        expect(session.sendResponse).toHaveBeenCalled();
        expect(response.body ?? session.sendResponse.mock.calls[0][0].body).toBeDefined();
    });

    test('trace-status sends `esp riscv_trace status` monitor command', () => {
        session.miDebugger.sendCommand.mockReturnValue(resolveWith('stopped'));
        const response = makeResponse();

        session.customRequest('trace-status', response, {});

        expect(session.miDebugger.sendCommand).toHaveBeenCalledWith(
            'interpreter-exec console "monitor esp riscv_trace status"',
            false,
            true
        );
        expect(session.sendResponse).toHaveBeenCalled();
    });

    test('trace-start builds start loop command with quoted file and timeout', () => {
        session.miDebugger.sendCommand.mockReturnValue(resolveWith(''));
        const response = makeResponse();

        session.customRequest('trace-start', response, {
            file: '/tmp/my trace.cap',
            timeoutMs: 250,
        });

        expect(session.miDebugger.sendCommand).toHaveBeenCalledWith(
            'interpreter-exec console "monitor esp riscv_trace start loop \\"/tmp/my trace.cap\\" 250"',
            false,
            true
        );
    });

    test('trace-stop sends stop command', () => {
        session.miDebugger.sendCommand.mockReturnValue(resolveWith(''));
        const response = makeResponse();

        session.customRequest('trace-stop', response, {});

        expect(session.miDebugger.sendCommand).toHaveBeenCalledWith(
            'interpreter-exec console "monitor esp riscv_trace stop"',
            false,
            true
        );
    });

    test('trace-dump builds dump command with quoted file', () => {
        session.miDebugger.sendCommand.mockReturnValue(resolveWith(''));
        const response = makeResponse();

        session.customRequest('trace-dump', response, { file: '/tmp/dump.esptrace' });

        expect(session.miDebugger.sendCommand).toHaveBeenCalledWith(
            'interpreter-exec console "monitor esp riscv_trace dump \\"/tmp/dump.esptrace\\""',
            false,
            true
        );
    });

    test('trace-start escapes Tcl metacharacters in the file path', () => {
        session.miDebugger.sendCommand.mockReturnValue(resolveWith(''));
        const response = makeResponse();

        // Jim Tcl double-quote rules: \ " $ [ ] all need a backslash escape.
        session.customRequest('trace-dump', response, { file: 'C:\\tmp\\cap[1]$.esptrace' });

        expect(session.miDebugger.sendCommand).toHaveBeenCalledWith(
            'interpreter-exec console "monitor esp riscv_trace dump \\"C:\\\\\\\\tmp\\\\\\\\cap\\\\[1\\\\]\\\\$.esptrace\\""',
            false,
            true
        );
    });

    test('trace-start without file returns an error response', () => {
        const response = makeResponse();

        session.customRequest('trace-start', response, {});

        expect(session.miDebugger.sendCommand).not.toHaveBeenCalled();
        expect(session.sendErrorResponse).toHaveBeenCalled();
    });

    test('response body carries the captured OpenOCD output', () => {
        session.miDebugger.sendCommand.mockReturnValue(resolveWith('Trace started\n'));
        const response = makeResponse();

        session.customRequest('trace-stop', response, {});

        const sent = session.sendResponse.mock.calls[0][0];
        expect(sent.body.output).toBe('Trace started\n');
        expect(sent.body.resultClass).toBe('done');
    });

    test('fails cleanly when there is no debug session', () => {
        const debuggerSend = session.miDebugger.sendCommand;
        session.miDebugger = undefined;
        const response = makeResponse();

        session.customRequest('trace-stop', response, {});

        expect(session.sendErrorResponse).toHaveBeenCalled();
        expect(debuggerSend).not.toHaveBeenCalled();
    });

    test('trace-start ignores negative timeoutMs', () => {
        session.miDebugger.sendCommand.mockReturnValue(resolveWith(''));
        const response = makeResponse();

        session.customRequest('trace-start', response, { file: '/tmp/cap.esptrace', timeoutMs: -50 });

        expect(session.miDebugger.sendCommand).toHaveBeenCalledWith(
            'interpreter-exec console "monitor esp riscv_trace start loop \\"/tmp/cap.esptrace\\""',
            false,
            true
        );
    });
});
