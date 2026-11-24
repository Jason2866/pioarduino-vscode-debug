// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/containers/__init__.py (Apache-2.0).

import * as fs from 'fs';
import * as path from 'path';
import { ContainerError } from '../errors';
import { Capture } from './base';
import * as coredump from './coredump';
import * as espt from './espt';

export { Capture, ContainerError, TraceBuffer, traceBufferFromRecord, validateCapture, validateTraceBuffer } from './base';
export * as coredump from './coredump';
export * as espt from './espt';

/** Load an ESPT trace file or an esp-coredump ELF. */
export function loadCapture(filePath: string): Capture {
    const p = path.resolve(filePath);
    const fd = fs.openSync(p, 'r');
    let head: Buffer;
    try {
        head = Buffer.alloc(8);
        fs.readSync(fd, head, 0, 8, 0);
    } finally {
        fs.closeSync(fd);
    }
    if (espt.sniff(head)) {
        return espt.load(p);
    }
    if (coredump.sniff(head)) {
        return coredump.load(p);
    }
    throw new ContainerError(`${p} is neither an ESPT trace file nor a coredump ELF`);
}
