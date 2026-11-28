// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace (Apache-2.0).

/** Base class for errors that stop a trace command. */
export class TraceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

export class AbiError extends TraceError {}
export class ContainerError extends TraceError {}
export class RingError extends TraceError {}
