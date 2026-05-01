/**
 * Unit tests for the write-memory dispatch path in adapter.ts.
 *
 * Tests that:
 *   1. The 'write-memory' custom-request case calls customWriteMemoryRequest
 *      with the correct address and data arguments.
 *   2. customWriteMemoryRequest constructs the right GDB/MI command:
 *      `data-write-memory-bytes <hexAddr> <data>`
 *   3. On MI success, sendResponse is called once.
 *   4. On MI failure, sendErrorResponse is called with code 114.
 */

// ---------------------------------------------------------------------------
// Minimal stubs for heavyweight dependencies
// ---------------------------------------------------------------------------

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
        on = jest.fn();
        emit = jest.fn();
    },
}));

jest.mock('../../src/backend/symbols', () => ({
    SymbolTable: class {
        getFunctionSymbols() { return []; }
        getFunctionAtAddress() { return null; }
        getSourceLines() { return []; }
    },
}));

jest.mock('../../src/backend/rtos', () => ({
    RTOSManager: class {
        detectRTOS() { return Promise.resolve(undefined); }
        getThreads() { return []; }
    },
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

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------
import { GDBDebugSession } from '../../src/backend/adapter';
import { MI2 } from '../../src/backend/mi2/mi2';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSession(): any {
    const session = new GDBDebugSession() as any;
    // Inject a mock MI2 instance so customWriteMemoryRequest has a debugger
    session.miDebugger = new (MI2 as any)();
    // Spy on sendResponse / sendErrorResponse
    session.sendResponse = jest.fn();
    session.sendErrorResponse = jest.fn();
    return session;
}

function makeResponse(): any {
    return { seq: 1, type: 'response', request_seq: 1, success: false, command: 'custom' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('adapter.ts — write-memory dispatch (customWriteMemoryRequest)', () => {
    let session: any;

    beforeEach(() => {
        session = createSession();
        jest.clearAllMocks();
        session.miDebugger.sendCommand = jest.fn();
    });

    describe('MI command construction', () => {
        test('sends data-write-memory-bytes with zero-padded hex address', async () => {
            session.miDebugger.sendCommand.mockReturnValue({ then: (cb: any) => { cb({}); return { catch: jest.fn() }; } });

            session.customWriteMemoryRequest(makeResponse(), 0x20000000, 'aabbccdd');

            expect(session.miDebugger.sendCommand).toHaveBeenCalledWith(
                'data-write-memory-bytes 0x20000000 aabbccdd'
            );
        });

        test('formats address with full 8-digit hex padding', () => {
            session.miDebugger.sendCommand.mockReturnValue({
                then: (cb: any) => { cb({}); return { catch: jest.fn() }; }
            });

            session.customWriteMemoryRequest(makeResponse(), 0x100, 'ff');

            expect(session.miDebugger.sendCommand).toHaveBeenCalledWith(
                'data-write-memory-bytes 0x00000100 ff'
            );
        });

        test('passes data string unmodified to the MI command', () => {
            session.miDebugger.sendCommand.mockReturnValue({
                then: (cb: any) => { cb({}); return { catch: jest.fn() }; }
            });

            session.customWriteMemoryRequest(makeResponse(), 0x20000004, '01020304050607');

            expect(session.miDebugger.sendCommand).toHaveBeenCalledWith(
                'data-write-memory-bytes 0x20000004 01020304050607'
            );
        });
    });

    describe('success path', () => {
        test('calls sendResponse on MI success', () => {
            const response = makeResponse();
            session.miDebugger.sendCommand.mockReturnValue({
                then: (onFulfilled: any) => {
                    onFulfilled({});
                    return { catch: jest.fn() };
                },
            });

            session.customWriteMemoryRequest(response, 0x20000000, 'ab');

            expect(session.sendResponse).toHaveBeenCalledWith(response);
            expect(session.sendErrorResponse).not.toHaveBeenCalled();
        });
    });

    describe('failure path', () => {
        test('calls sendErrorResponse with code 114 on MI failure', () => {
            const response = makeResponse();
            const error = new Error('target memory error');
            session.miDebugger.sendCommand.mockReturnValue({
                then: (_onFulfilled: any, onRejected: any) => {
                    onRejected(error);
                    return { catch: jest.fn() };
                },
            });

            session.customWriteMemoryRequest(response, 0x20000000, 'ab');

            expect(session.sendErrorResponse).toHaveBeenCalledWith(
                response,
                114,
                expect.stringContaining('Unable to write memory')
            );
            expect(session.sendResponse).not.toHaveBeenCalled();
        });

        test('error response message includes the MI error description', () => {
            const response = makeResponse();
            const error = new Error('cannot access memory at 0x20000000');
            session.miDebugger.sendCommand.mockReturnValue({
                then: (_onFulfilled: any, onRejected: any) => {
                    onRejected(error);
                    return { catch: jest.fn() };
                },
            });

            session.customWriteMemoryRequest(response, 0x20000000, 'ff');

            const errorCall = (session.sendErrorResponse as jest.Mock).mock.calls[0];
            expect(errorCall[2]).toMatch(/cannot access memory/i);
        });
    });

    describe('write-memory custom request dispatch', () => {
        test('customRequest routes write-memory to customWriteMemoryRequest', () => {
            // Spy on the private method via reflection
            const spy = jest.spyOn(session as any, 'customWriteMemoryRequest');
            session.miDebugger.sendCommand.mockReturnValue({
                then: (cb: any) => { cb({}); return { catch: jest.fn() }; }
            });

            const response = makeResponse();
            // customRequest signature: (command, response, args)
            session.customRequest('write-memory', response, {
                address: 0x20000000,
                data: 'deadbeef',
            });

            expect(spy).toHaveBeenCalledWith(response, 0x20000000, 'deadbeef');
        });
    });
});
