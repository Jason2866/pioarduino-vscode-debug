// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Text formatter for FaultWindow origin analysis.

import { FaultWindow, RegisterStep } from '../analysis/origin';
import { SP } from '../decoder/encoding';
import { CodeImage } from '../elf/image';
import { SourceResolver } from '../elf/resolver';
import { oneLine } from './_format';

function fmtAddr(pc: number): string {
    return `0x${(pc >>> 0).toString(16).padStart(8, '0')}`;
}

function fmtLocation(file: string, line: number): string {
    return `${oneLine(file)}:${line}`;
}

export interface FormatOriginOptions {
    label?: string;
    registers?: ReadonlyMap<number, number>;
    registerNote?: string;
    inside?: (pc: number) => boolean;
}

function formatPcPlace(pc: number, image: CodeImage | undefined, resolver: SourceResolver): string {
    const sym = image?.symbolAt(pc);
    const loc = resolver.resolve(pc);
    const locText = loc ? fmtLocation(loc.file, loc.line) : undefined;
    if (sym && locText) {
        return `${fmtAddr(pc)}  ${sym}  (${locText})`;
    }
    if (sym) {
        return `${fmtAddr(pc)}  ${sym}`;
    }
    if (locText) {
        return `${fmtAddr(pc)}  (${locText})`;
    }
    return fmtAddr(pc);
}

function formatStepLines(
    step: RegisterStep,
    indent: string,
    image: CodeImage | undefined,
    resolver: SourceResolver,
    out: string[]
): void {
    const parts: string[] = [`${indent}r${step.reg}  ${step.kind}`];
    if (step.value !== undefined) {
        parts.push(`val=${fmtAddr(step.value)}`);
    }
    if (step.instruction) {
        parts.push(`insn="${step.instruction}"`);
    }
    if (step.pc !== undefined) {
        parts.push(`at ${formatPcPlace(step.pc, image, resolver)}`);
    }
    if (step.crossed.length > 0) {
        parts.push(`crossed=[${step.crossed.join(',')}]`);
    }
    if (step.stop !== undefined) {
        parts.push(`stop=${step.stop}${step.detail ? `(${step.detail})` : ''}`);
    }
    out.push(parts.join('  '));
    for (const src of step.sources) {
        formatStepLines(src, `${indent}  `, image, resolver, out);
    }
}

/** Format a FaultWindow's fault summary, call stack, branches, and optional register origin. */
export function formatFaultOrigin(
    window: FaultWindow,
    image: CodeImage | undefined,
    resolver: SourceResolver,
    options: FormatOriginOptions = {}
): string[] {
    const lines: string[] = [];
    const label = options.label ? `  ${options.label}` : '';
    lines.push(`# origin${label}`);

    if (window.fault === undefined) {
        lines.push('No fault trap found in capture.');
        return lines;
    }

    const fault = window.fault;
    const epcText = fault.epc !== undefined ? formatPcPlace(fault.epc, image, resolver) : 'none';
    const tvalText = fault.tval !== undefined ? fmtAddr(fault.tval) : 'none';
    lines.push(
        `fault: cause=${fault.cause}  epc=${epcText}  tval=${tvalText}  window_complete=${window.complete}`
    );

    const hasSp = options.registers?.has(SP) === true;
    const regs = options.registers ?? new Map<number, number>();
    const calls = window.stackCalls(regs);
    lines.push('');
    lines.push(`unreturned calls (${calls.length}):`);
    if (calls.length === 0) {
        lines.push(hasSp ? '  (none)' : '  (unavailable - SP register not provided)');
    } else {
        for (const call of calls) {
            lines.push(`  ${formatPcPlace(call.pc, image, resolver)}  sp=${fmtAddr(call.sp)}`);
        }
    }

    const faultSym = fault.epc !== undefined ? image?.symbolAt(fault.epc) : undefined;
    const inside =
        options.inside ??
        (faultSym !== undefined
            ? (pc: number) => image?.symbolAt(pc) === faultSym
            : () => true);
    const branches = window.branches(inside);
    lines.push('');
    lines.push(`recent branches (${branches.length}):`);
    if (branches.length === 0) {
        lines.push('  (none)');
    } else {
        for (const br of branches) {
            lines.push(`  ${formatPcPlace(br.pc, image, resolver)}  ${br.taken ? 'taken' : 'not taken'}`);
        }
    }

    if (options.registers && options.registers.size > 0) {
        const root = window.origin(options.registers);
        lines.push('');
        lines.push(options.registerNote ? `register origin (${options.registerNote}):` : 'register origin:');
        if (root === undefined) {
            lines.push('  (no register to follow)');
        } else {
            formatStepLines(root, '  ', image, resolver, lines);
        }
    }

    return lines;
}
