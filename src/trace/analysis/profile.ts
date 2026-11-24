// SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0
// Ported from esp-riscv-trace esp_riscv_trace/analysis/profile.py (Apache-2.0).

import { GapReason } from '../decoder/reconstruct';
import { CodeImage } from '../elf/image';
import { LinkKind, TraceEvent, TraceGap, TraceInstruction, TraceSync, TraceTrap } from '../ir/events';
import { causeName, isFault } from './history';
import { unresolvedFunctionLabel } from './stats';

// Frame of code outside the traced range that called back into it, as ROM code calls the application
export const UNTRACED_FRAME = '[untraced]';

// ecall has no compressed form
const ECALL_LENGTH = 4;

// Oldest frames are dropped beyond this, so runaway recursion cannot grow the shadow stack without bound
const MAX_FRAMES = 1024;

// Call stack, outermost function first
export type Stack = string[];

export function trapFrame(trap: TraceTrap): string {
    /** Return the name of the frame a trap adds, such as `[interrupt 25]` or `[load access fault]`. */
    return `[${causeName(trap.cause, trap.interrupt)}]`;
}

export interface Profile {
    /** The instructions of one core by the call stack they ran under. */
    // (stack, instructions) for every run of instructions under one stack, in trace order
    runs: Array<readonly [Stack, number]>;
    instructions: number;
}

export function mergeProfiles(profiles: Iterable<Profile>): Profile {
    /** Join the runs of `profiles` in order. */
    const runs: Array<readonly [Stack, number]> = [];
    for (const profile of profiles) {
        runs.push(...profile.runs);
    }
    return { runs, instructions: runs.reduce((sum, [, count]) => sum + count, 0) };
}

export function profileStacks(profile: Profile): Map<string, number> {
    /** Return the instructions of every stack, summed over its runs. Keys are JSON-encoded stacks. */
    const counts = new Map<string, number>();
    for (const [stack, count] of profile.runs) {
        const key = JSON.stringify(stack);
        counts.set(key, (counts.get(key) ?? 0) + count);
    }
    return counts;
}

function makeFrame(names: Stack, resume: number[], trap: boolean, untracedCaller: boolean): Frame {
    return {
        names,
        resume,
        trap,
        untraced_caller: untracedCaller,
        accepts(target: number | undefined): boolean {
            if (target === undefined) {
                return true;
            }
            if (this.untraced_caller) {
                return false;
            }
            return this.resume.length === 0 || this.resume.includes(target);
        },
    };
}

function stackEquals(a: Stack, b: Stack): boolean {
    return a.length === b.length && a.every((name, i) => name === b[i]);
}

interface Frame {
    /** One shadow stack frame. */
    names: Stack; // what the frame adds to the stack: the caller, or the interrupted function and the trap
    resume: number[]; // addresses that return into the frame; empty when not known, which accepts any
    trap: boolean;
    // Entered from code outside the traced range, so it returns into untraced code
    untraced_caller: boolean;

    accepts(target: number | undefined): boolean;
}

export class ProfileAccumulator {
    /** Streams trace events of one core into a `Profile`. `image` names the functions. */
    private image: CodeImage;
    private symbols = new Map<number, string>();
    private frames: Frame[] = [];
    private outer: Stack | undefined = []; // names of every frame; undefined when a frame changed since
    private runs: Array<readonly [Stack, number]> = [];
    private stack: Stack | undefined; // stack of the newest run
    private count = 0; // instructions of the newest run
    // Outer frames and function of the newest instruction, so the next one can skip building its stack
    private runOuter: Stack | undefined;
    private runFunction: string | undefined;
    private function: string | undefined; // function of the newest instruction
    private running = false;
    // Code outside the traced range runs, the stack stays valid until the trace enters the range again
    private untraced = false;

    constructor(image: CodeImage) {
        this.image = image;
    }

    push(event: TraceEvent): void {
        if (event.event === 'instruction') {
            const insn = event as TraceInstruction;
            if (this.untraced) {
                this.reenter(insn.pc);
            }
            this.running = true;
            this.countInstruction(insn.pc);
            this.follow(insn);
        } else if (event.event === 'sync') {
            const sync = event as TraceSync;
            if (this.untraced) {
                this.reenter(sync.pc);
            }
        } else if (event.event === 'trap') {
            this.untraced = false;
            this.onTrap(event as TraceTrap);
        } else if (event.event === 'gap') {
            const gap = event as TraceGap;
            if (gap.reason === GapReason.UNTRACED && this.running) {
                this.untraced = true;
            } else {
                this.clear();
                this.running = false;
                this.untraced = false;
                this.function = undefined;
            }
        }
    }

    close(): Profile {
        const runs = [...this.runs];
        if (this.stack !== undefined) {
            runs.push([this.stack, this.count]);
        }
        return { runs, instructions: runs.reduce((sum, [, count]) => sum + count, 0) };
    }

    private countInstruction(pc: number): void {
        const functionName = this.symbol(pc);
        this.function = functionName;
        let outer = this.outer;
        if (outer === undefined) {
            outer = this.outer = this.frames.flatMap((frame) => frame.names);
        }
        if (outer === this.runOuter && functionName === this.runFunction) {
            this.count++;
            return;
        }
        this.runOuter = outer;
        this.runFunction = functionName;
        const stack = [...outer, functionName];
        if (this.stack !== undefined && stackEquals(stack, this.stack)) {
            this.count++;
            return;
        }
        if (this.stack !== undefined) {
            this.runs.push([this.stack, this.count]);
        }
        this.stack = stack;
        this.count = 1;
    }

    private follow(insn: TraceInstruction): void {
        const link = insn.link;
        if (link === LinkKind.CALL) {
            const fn = this.function;
            if (fn === undefined) {
                return;
            }
            this.pushFrame(makeFrame([fn], [insn.pc + insn.length], false, false));
        } else if (link === LinkKind.RETURN) {
            this.onReturn(insn.next_pc);
        } else if (link === LinkKind.TRAP_RETURN) {
            let trapAt = -1;
            for (let i = this.frames.length - 1; i >= 0; i--) {
                if (this.frames[i].trap) {
                    trapAt = i;
                    break;
                }
            }
            if (trapAt !== -1 && this.frames[trapAt].accepts(insn.next_pc)) {
                this.pop(trapAt);
            } else {
                // Back into code whose stack the trace does not show, usually another task
                this.clear();
            }
        }
    }

    private onReturn(target: number | undefined): void {
        const frames = this.frames;
        if (!frames.length || frames[frames.length - 1].trap) {
            // The caller is older than the trace, or the trace entered this code without a call
            return;
        }
        if (target === undefined) {
            this.pop(frames.length - 1);
            return;
        }
        for (let i = frames.length - 1; i >= 0; i--) {
            if (frames[i].trap) {
                break;
            }
            if (frames[i].accepts(target)) {
                this.pop(i);
                return;
            }
        }
        // The return does not match any call, so the stack below the newest trap is not this code's
        while (frames.length && !frames[frames.length - 1].trap) {
            frames.pop();
        }
        this.outer = undefined;
    }

    private onTrap(trap: TraceTrap): void {
        const epc = trap.epc;
        const interrupted = epc !== undefined ? this.symbol(epc) : this.function;
        const names: Stack = interrupted === undefined ? [trapFrame(trap)] : [interrupted, trapFrame(trap)];
        let resume: number[] = [];
        if (epc !== undefined) {
            // The handler returns past an ecall, or retries it
            const ecall = !trap.interrupt && !isFault(trap);
            resume = ecall ? [epc + ECALL_LENGTH, epc] : [epc];
        }
        this.pushFrame(makeFrame(names, resume, true, false));
        this.running = true;
    }

    private reenter(pc: number): void {
        /** Continue at `pc`, where the trace enters the traced range again. */
        this.untraced = false;
        const frames = this.frames;
        for (let i = frames.length - 1; i >= 0; i--) {
            if (frames[i].trap) {
                break;
            }
            if (frames[i].accepts(pc)) {
                this.pop(i);
                return;
            }
        }
        this.pushFrame(makeFrame([UNTRACED_FRAME], [], false, true));
    }

    private pushFrame(frame: Frame): void {
        this.frames.push(frame);
        if (this.frames.length > MAX_FRAMES) {
            this.frames.shift();
        }
        this.outer = undefined;
    }

    private pop(index: number): void {
        /** Drop the frame at `index` and every frame above it. */
        this.frames = this.frames.slice(0, index);
        this.outer = undefined;
    }

    private clear(): void {
        this.frames = [];
        this.outer = undefined;
    }

    private symbol(pc: number): string {
        let name = this.symbols.get(pc);
        if (name === undefined) {
            name = this.image.symbolAt(pc) ?? unresolvedFunctionLabel(pc);
            this.symbols.set(pc, name);
        }
        return name;
    }
}

export function buildProfile(events: Iterable<TraceEvent>, image: CodeImage): Profile {
    /** Build the profile of one core's events. */
    const acc = new ProfileAccumulator(image);
    for (const event of events) {
        acc.push(event);
    }
    return acc.close();
}
