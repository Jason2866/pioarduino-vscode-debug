import * as path from 'path';
import { parseGdbInfoLineOutput } from '../../src/trace/elf/gdbResolver';
import { originCapture } from '../../src/trace/commands';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'trace');

describe('parseGdbInfoLineOutput', () => {
    test('pairs __PC__ markers with `info line` file and line', () => {
        const stdout = [
            '(gdb) __PC__=0x42000100',
            'Line 42 of "/proj/src/main.c" starts at address 0x42000100 <app_main+4> and ends at 0x42000104 <app_main+8>.',
            '(gdb) __PC__=0x42000200',
            'No line number information available for address 0x42000200',
            '(gdb) __PC__=0x42000300',
            '(gdb) Line 7 of "foo.c" starts at address 0x42000300 and ends at 0x42000304.',
        ].join('\n');

        const map = parseGdbInfoLineOutput(stdout);
        expect(map.get(0x42000100)).toEqual({ file: '/proj/src/main.c', line: 42 });
        expect(map.get(0x42000200)).toBeUndefined();
        expect(map.get(0x42000300)).toEqual({ file: 'foo.c', line: 7 });
    });
});

describe('originCapture', () => {
    jest.setTimeout(60_000);

    test('formats fault summary, unreturned calls, and recent branches on esp32c5 panic', async () => {
        const result = await originCapture(path.join(FIXTURES, 'esp32c5_panic_stop.esptrace'), {
            elfPath: path.join(FIXTURES, 'esp32c5.elf'),
            quiet: true,
            warn: () => undefined,
        });
        const text = result.lines.join('\n');
        expect(text).toContain('# origin');
        expect(text).toContain('fault: cause=');
        expect(text).toContain('unreturned calls');
        expect(text).toContain('recent branches');
    });
});
