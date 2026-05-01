/**
 * Preservation Property Tests — Task 2
 *
 * These tests establish the baseline behavior that MUST be preserved after the fix.
 * They MUST PASS on unfixed code.
 *
 * Property 2: Preservation — `debug-ready` Emission and Breakpoint Test Assertions Unchanged
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */

import { MI2 } from '../../src/backend/mi2/mi2';

// ---------------------------------------------------------------------------
// Test A — debug-ready emitted after 200ms
// ---------------------------------------------------------------------------
describe('Test A — debug-ready emitted after 200ms', () => {
    let mi2: MI2;

    beforeEach(() => {
        jest.useFakeTimers();
        mi2 = new MI2('gdb', []);
    });

    afterEach(() => {
        // Clean up the timer if it's still pending
        if (mi2['debugReadyTimeout']) {
            clearTimeout(mi2['debugReadyTimeout']);
        }
        mi2.removeAllListeners();
        jest.useRealTimers();
    });

    /**
     * Validates: Requirement 3.1
     * When onOutput() detects 'PlatformIO: Initialization completed' and the timeout
     * fires normally, 'debug-ready' MUST be emitted after 200ms.
     */
    test('emits debug-ready exactly once after 200ms when trigger line is processed', () => {
        let debugReadyCount = 0;
        mi2.on('debug-ready', () => {
            debugReadyCount++;
        });

        // A valid GDB console stream record containing the trigger string
        mi2.onOutput('~"PlatformIO: Initialization completed\\n"');

        // Timer should be set but not yet fired
        expect(debugReadyCount).toBe(0);

        // Advance fake timers by 200ms — the timeout should fire
        jest.advanceTimersByTime(200);

        expect(debugReadyCount).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Test B — debug-ready emitted immediately on generic-stopped
// ---------------------------------------------------------------------------
describe('Test B — debug-ready emitted immediately on generic-stopped', () => {
    let mi2: MI2;

    beforeEach(() => {
        jest.useFakeTimers();
        mi2 = new MI2('gdb', []);
    });

    afterEach(() => {
        mi2.removeAllListeners();
        jest.useRealTimers();
    });

    /**
     * Validates: Requirement 3.2
     * When 'generic-stopped' fires before the 200ms timeout, 'debug-ready' MUST be
     * emitted immediately and the timer MUST be cancelled (no second emission).
     */
    test('emits debug-ready immediately when generic-stopped fires before 200ms', () => {
        let debugReadyCount = 0;
        mi2.on('debug-ready', () => {
            debugReadyCount++;
        });

        // Set up the timer by processing the trigger line
        mi2.onOutput('~"PlatformIO: Initialization completed\\n"');

        // Timer is pending but has not fired yet
        expect(debugReadyCount).toBe(0);

        // Emit generic-stopped BEFORE advancing timers — should trigger immediate emission
        mi2.emit('generic-stopped', {});

        // debug-ready should have been emitted immediately
        expect(debugReadyCount).toBe(1);

        // Advance timers by 200ms — the original timeout should have been cancelled,
        // so no second emission should occur
        jest.advanceTimersByTime(200);

        expect(debugReadyCount).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Test C — non-trigger lines produce no timer
// ---------------------------------------------------------------------------
describe('Test C — non-trigger lines produce no timer', () => {
    let mi2: MI2;

    beforeEach(() => {
        mi2 = new MI2('gdb', []);
    });

    afterEach(() => {
        mi2.removeAllListeners();
    });

    /**
     * Validates: Requirement 3.1 (by contrapositive)
     * Lines that do NOT contain 'PlatformIO: Initialization completed' MUST NOT
     * create a debugReadyTimeout.
     */
    test('empty string does not create a debugReadyTimeout', () => {
        mi2.onOutput('');
        expect(mi2['debugReadyTimeout']).toBeUndefined();
    });

    test('plain stdout line does not create a debugReadyTimeout', () => {
        mi2.onOutput('~"Some other output\\n"');
        expect(mi2['debugReadyTimeout']).toBeUndefined();
    });

    test('a different stream record does not create a debugReadyTimeout', () => {
        // @ prefix = target stream record (not console)
        mi2.onOutput('@"target output\\n"');
        expect(mi2['debugReadyTimeout']).toBeUndefined();
    });

    test('a GDB result record does not create a debugReadyTimeout', () => {
        // A result record (^done) — not a stream record
        mi2.onOutput('^done');
        expect(mi2['debugReadyTimeout']).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Test D — removeAllListeners() zeroes listener count
// ---------------------------------------------------------------------------
describe('Test D — removeAllListeners() zeroes listener count', () => {
    /**
     * Validates: Requirement 3.4 (cleanup pattern)
     * After calling removeAllListeners(), all listener counts MUST be 0.
     */
    test('listener counts are 0 after removeAllListeners()', () => {
        const mi2 = new MI2('gdb', []);

        // Add some listeners manually
        mi2.on('msg', () => {});
        mi2.on('debug-ready', () => {});

        // Confirm listeners were added
        expect(mi2.listenerCount('msg')).toBeGreaterThan(0);
        expect(mi2.listenerCount('debug-ready')).toBeGreaterThan(0);

        // Remove all listeners
        mi2.removeAllListeners();

        // All listener counts must be 0
        expect(mi2.listenerCount('msg')).toBe(0);
        expect(mi2.listenerCount('debug-ready')).toBe(0);
    });
});
