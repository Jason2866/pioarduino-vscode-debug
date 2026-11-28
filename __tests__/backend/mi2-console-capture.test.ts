/**
 * Tests for per-command console/target stream capture in MI2.
 *
 * GDB/MI delivers `monitor` command replies as `~"..."` console stream records
 * on separate lines, before the `^done` result. `sendCommand(..., captureConsole)`
 * must attach that text to the resolved MINode so callers (e.g. OpenOCD
 * `esp riscv_trace` commands) can read the target's reply.
 */

import { MI2 } from '../../src/backend/mi2/mi2';

function makeMi2(): MI2 {
    const mi2 = new MI2('gdb', []);
    (mi2 as any).process = { stdin: { write: jest.fn() } };
    return mi2;
}

describe('MI2 console capture', () => {
    test('attaches console output emitted while the command was in flight', async () => {
        const mi2 = makeMi2();
        const pending = mi2.sendCommand('interpreter-exec console "monitor esp riscv_trace"', false, true);

        mi2.onOutput('~"esp riscv_trace: unknown command\\n"');
        mi2.onOutput('1^done');

        const result = await pending;
        expect(result.consoleOutput).toContain('esp riscv_trace: unknown command');
        expect(result.resultRecords.resultClass).toBe('done');
    });

    test('does not capture when captureConsole is false', async () => {
        const mi2 = makeMi2();
        const pending = mi2.sendCommand('some-command');

        mi2.onOutput('~"noise\\n"');
        mi2.onOutput('1^done');

        const result = await pending;
        expect(result.consoleOutput).toBeUndefined();
    });

    test('does not include console output emitted before the command was sent', async () => {
        const mi2 = makeMi2();
        mi2.onOutput('~"old output\\n"');

        const pending = mi2.sendCommand('interpreter-exec console "monitor x"', false, true);
        mi2.onOutput('~"new output\\n"');
        mi2.onOutput('1^done');

        const result = await pending;
        expect(result.consoleOutput).toBe('new output\n');
        expect(result.consoleOutput).not.toContain('old output');
    });

    test('captures multi-line monitor output', async () => {
        const mi2 = makeMi2();
        const pending = mi2.sendCommand('monitor esp riscv_trace start loop t.esptrace', false, true);

        mi2.onOutput('~"line one\\n"');
        mi2.onOutput('~"line two\\n"');
        mi2.onOutput('1^done');

        const result = await pending;
        expect(result.consoleOutput).toBe('line one\nline two\n');
    });
});
