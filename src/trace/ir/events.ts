// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/ir/events.py (Apache-2.0).

export enum InsnClass {
    NONE = 0, // non-control-flow (advances PC by insn length)
    BRANCH = 1, // direct conditional branch (consumes one branch-map bit)
    JUMP = 2, // direct unconditional jump (target is PC + imm)
    UNINFERABLE = 3, // indirect jump or trap return (next PC from address packet)
    TRAP = 4, // synchronous trap cause (next PC from trap packet)
}

export enum LinkKind {
    NONE = 'none', // not a jump
    CALL = 'call', // writes a link register
    RETURN = 'return', // jumps through a link register without writing one
    JUMP = 'jump', // neither
    COROUTINE = 'coroutine', // jumps through one link register and writes the other
    TRAP_RETURN = 'trap_return', // mret or sret
}

export interface Provenance {
    segment_index: number;
    stream_offset: number;
    packet_index: number;
    payload?: Buffer;
}

export type TraceEventKind = 'sync' | 'instruction' | 'trap' | 'gap' | 'boundary' | 'warning';

export interface TraceSync {
    event: 'sync';
    pc: number;
    privilege: number;
    provenance: Provenance | undefined;
}

export interface TraceInstruction {
    event: 'instruction';
    pc: number;
    length: number;
    cls: InsnClass;
    branch_taken: boolean | undefined;
    // undefined when an uninferable jump leaves the traced code
    next_pc: number | undefined;
    provenance: Provenance | undefined;
    inferred: boolean;
    link: LinkKind;
}

export interface TraceTrap {
    event: 'trap';
    cause: number;
    interrupt: boolean;
    handler_pc: number | undefined;
    interrupted_pc: number | undefined;
    tval: number | undefined;
    provenance: Provenance | undefined;
    // Instruction the trap was taken at, the value of mepc
    epc: number | undefined;
}

export interface TraceGap {
    event: 'gap';
    reason: string;
    detail: string;
    provenance: Provenance | undefined;
}

export interface TraceBoundary {
    event: 'boundary';
    kind: string;
    detail: string;
    provenance: Provenance | undefined;
}

export interface TraceWarning {
    event: 'warning';
    kind: string;
    detail: string;
    provenance: Provenance | undefined;
}

export type TraceEvent = TraceSync | TraceInstruction | TraceTrap | TraceGap | TraceBoundary | TraceWarning;
