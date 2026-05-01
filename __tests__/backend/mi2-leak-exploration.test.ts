/**
 * Bug Condition Exploration Tests — Task 1
 *
 * These tests surface the two leaks that cause Jest to force-exit its worker:
 *
 *   Cause A — Unref'd timer: MI2.onOutput() creates a setTimeout without .unref(),
 *             keeping the Node.js event loop alive after tests finish.
 *
 *   Cause B — Dangling listeners: MI2 instances created in tests without afterEach
 *             cleanup leave EventEmitter listeners registered on live objects.
 *
 * EXPECTED OUTCOME ON UNFIXED CODE:
 *   - Cause A test FAILS  → hasRef() returns true  (timer keeps event loop alive)
 *   - Cause B test PASSES → MI2 constructor adds no listeners itself
 *     (the leak pattern is about not having afterEach, not about constructor listeners)
 *
 * DO NOT modify mi2.ts or fix these tests when they fail.
 * Failure of Cause A confirms the bug exists.
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */

import { MI2 } from '../../src/backend/mi2/mi2';

// ---------------------------------------------------------------------------
// Cause A — Timer leak
// ---------------------------------------------------------------------------
describe('Cause A — Timer leak: debugReadyTimeout should be unref\'d', () => {
    let mi2: MI2;

    afterEach(() => {
        // Clean up the timer so it doesn't fire during other tests
        if (mi2['debugReadyTimeout']) {
            clearTimeout(mi2['debugReadyTimeout']);
        }
        mi2.removeAllListeners();
    });

    test(
        'hasRef() should be false after onOutput() triggers the PlatformIO init branch',
        () => {
            mi2 = new MI2('gdb', []);

            // A valid GDB console stream record: ~"<content>\n"
            // The ~ prefix makes parseMI produce isStream: true with type 'console'
            const triggerLine = '~"PlatformIO: Initialization completed\\n"';

            mi2.onOutput(triggerLine);

            // The timer must have been created
            expect(mi2['debugReadyTimeout']).toBeDefined();

            // On UNFIXED code this assertion FAILS because .unref() is never called.
            // hasRef() returns true  → the timer keeps the event loop alive.
            // On FIXED code this assertion PASSES because .unref() is called.
            expect(mi2['debugReadyTimeout'].hasRef()).toBe(false);
        }
    );
});

// ---------------------------------------------------------------------------
// Cause B — Listener leak
// ---------------------------------------------------------------------------
describe('Cause B — Listener leak: MI2 instance should have zero listeners after construction', () => {
    /**
     * NOTE: The MI2 constructor does NOT add any listeners itself.
     * The leak pattern described in the bug report is about tests that create MI2
     * instances without an afterEach cleanup block — those instances accumulate
     * listeners added during the test body and are never cleaned up.
     *
     * This test verifies the baseline: a freshly constructed MI2 instance has
     * zero 'msg' listeners. If this passes, it documents that Cause B is about
     * the *pattern* of missing afterEach, not about listeners added in the constructor.
     */
    test(
        'a freshly constructed MI2 instance has zero msg listeners',
        () => {
            const mi2 = new MI2('gdb', []);

            // No afterEach cleanup is intentionally omitted here to mirror the
            // pattern in breakpoint-error-handling.test.ts.
            // The constructor itself adds no listeners, so this should be 0.
            expect(mi2.listenerCount('msg')).toBe(0);
        }
    );
});
