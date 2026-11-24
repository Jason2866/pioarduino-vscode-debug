import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PersistentAddr2line } from '../../src/trace/addr2lineResolver';

describe('PersistentAddr2line', () => {
    let tempDir: string;
    let fakeAddr2line: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-addr2line-'));
        fakeAddr2line = path.join(tempDir, 'addr2line');
        fs.writeFileSync(fakeAddr2line, [
            '#!/bin/sh',
            'while IFS= read -r addr; do',
            '  printf \'%s\\n\' "$addr"',
            '  printf \'func_%s\\n\' "$addr"',
            '  printf \'/tmp/src/file.c:123\\n\'',
            'done',
            '',
        ].join('\n'));
        fs.chmodSync(fakeAddr2line, 0o755);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('resolves a batch of addresses through a persistent process', async () => {
        const resolver = new PersistentAddr2line(fakeAddr2line, '/fake/firmware.elf');
        try {
            const results = await resolver.resolveBatch(['0x1000', '0x2000']);
            expect(results).toEqual([
                { address: '0x1000', function: 'func_0x1000', file: '/tmp/src/file.c', line: '123' },
                { address: '0x2000', function: 'func_0x2000', file: '/tmp/src/file.c', line: '123' },
            ]);
        } finally {
            resolver.dispose();
        }
    });
});
