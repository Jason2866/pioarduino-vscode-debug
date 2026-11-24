import { spawn, type ChildProcess } from 'child_process';
import type { Addr2lineResult } from './types';

export type { Addr2lineResult } from './types';

const ADDR2LINE_HEADER_RE = /^0x[0-9a-fA-F]+$/;
const DISCRIMINATOR_RE = /\s*\(discriminator \d+\)/;
// Trailing marker address appended to every batch. Completion is detected by
// counting address headers (one per input plus this sentinel), so the value
// itself can never collide with a real PC such as 0x00000000.
const SENTINEL_ADDR = '0x00000000';
const IDLE_TIMEOUT_MS = 30_000;
const BATCH_TIMEOUT_MS = 15_000;
const MAX_BATCH_RETRIES = 1;

interface QueueEntry {
    addresses: string[];
    resolve: (results: Addr2lineResult[]) => void;
    reject: (err: Error) => void;
    attempts: number;
}

/**
 * Keeps an `addr2line` process running in interactive (stdin) mode and
 * serializes resolution requests through it. The process is restarted if it
 * crashes and killed after an idle timeout.
 */
export class PersistentAddr2line {
    private readonly addr2linePath: string;
    private readonly elfPath: string;

    private proc: ChildProcess | null = null;
    private disposed = false;

    private queue: QueueEntry[] = [];
    private processing = false;

    private stdoutBuffer = '';
    private idleTimer: ReturnType<typeof setTimeout> | undefined;
    // Cancels the in-flight batch's timer and data listener. Set by drainQueue,
    // cleared by the batch's own cleanup so exit/timeout/dispose cannot leave
    // stale state behind.
    private activeCleanup: (() => void) | undefined;

    constructor(addr2linePath: string, elfPath: string) {
        this.addr2linePath = addr2linePath;
        this.elfPath = elfPath;
    }

    resolveBatch(addresses: string[]): Promise<Addr2lineResult[]> {
        if (this.disposed) {
            return Promise.reject(new Error('PersistentAddr2line has been disposed'));
        }
        return new Promise<Addr2lineResult[]>((resolve, reject) => {
            this.queue.push({ addresses, resolve, reject, attempts: 0 });
            this.drainQueue();
        });
    }

    dispose(): void {
        this.disposed = true;
        this.activeCleanup?.();
        this.clearIdleTimer();
        this.killProcess();
        for (const entry of this.queue) {
            entry.reject(new Error('PersistentAddr2line disposed'));
        }
        this.queue = [];
    }

    private ensureProcess(): ChildProcess {
        if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
            return this.proc;
        }
        const proc = spawn(this.addr2linePath, ['-fiaC', '-e', this.elfPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Ignore exit/error events from a process that is no longer current —
        // a retry may already own this.proc by the time a stale event lands.
        proc.on('error', () => {
            if (this.proc === proc) {
                this.handleProcessExit();
            }
        });
        proc.on('exit', () => {
            if (this.proc === proc) {
                this.handleProcessExit();
            }
        });
        // stdin 'error' (e.g. EPIPE when the child exits before the write)
        // would otherwise surface as an uncaught exception; stderr must be
        // drained or a noisy child blocks on a full pipe.
        proc.stdin?.on('error', () => undefined);
        proc.stderr?.resume();
        this.proc = proc;
        return proc;
    }

    private handleProcessExit(): void {
        // Detach the dead process's batch timer and data listener before the
        // retry starts a new batch, so neither can fire against it later.
        this.activeCleanup?.();
        this.proc = null;
        if (this.processing) {
            this.processing = false;
            const entry = this.queue[0];
            if (entry && ++entry.attempts > MAX_BATCH_RETRIES) {
                this.queue.shift();
                entry.reject(new Error('addr2line exited before completing the batch'));
            }
            this.drainQueue();
        }
    }

    private killProcess(): void {
        if (this.proc) {
            this.proc.removeAllListeners();
            this.proc.stdout?.removeAllListeners();
            this.proc.kill();
            this.proc = null;
        }
    }

    private resetIdleTimer(): void {
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.killProcess();
        }, IDLE_TIMEOUT_MS);
    }

    private clearIdleTimer(): void {
        if (this.idleTimer !== undefined) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    private drainQueue(): void {
        if (this.processing || this.queue.length === 0 || this.disposed) {
            return;
        }
        this.processing = true;
        this.clearIdleTimer();

        const entry = this.queue[0];
        this.stdoutBuffer = '';

        const proc = this.ensureProcess();
        const stdout = proc.stdout!;
        // Decode once per stream so a multibyte character split across chunks
        // (e.g. a non-ASCII filename) is not corrupted per-chunk.
        stdout.setEncoding('utf8');

        let batchTimer: ReturnType<typeof setTimeout> | undefined;
        let onData: ((chunk: string) => void) | undefined;

        const cleanup = (): void => {
            if (batchTimer !== undefined) {
                clearTimeout(batchTimer);
                batchTimer = undefined;
            }
            if (onData !== undefined) {
                stdout.removeListener('data', onData);
                onData = undefined;
            }
            if (this.activeCleanup === cleanup) {
                this.activeCleanup = undefined;
            }
        };

        batchTimer = setTimeout(() => {
            // A stale timer must not touch a newer batch that now owns the queue.
            if (this.queue[0] !== entry) {
                return;
            }
            cleanup();
            this.killProcess();
            this.processing = false;
            this.queue.shift();
            entry.reject(new Error('addr2line batch timed out'));
            this.drainQueue();
        }, BATCH_TIMEOUT_MS);

        onData = (chunk: string): void => {
            this.stdoutBuffer += chunk;

            // Done when every address plus the sentinel header arrived; the
            // sentinel's own body is irrelevant.
            if (this.countHeaders(this.stdoutBuffer) > entry.addresses.length) {
                cleanup();
                this.processing = false;
                this.queue.shift();

                const results = this.parseOutput(this.stdoutBuffer, entry.addresses);
                entry.resolve(results);

                if (this.queue.length > 0) {
                    this.drainQueue();
                } else {
                    this.resetIdleTimer();
                }
            }
        };

        this.activeCleanup = cleanup;
        stdout.on('data', onData);

        const input = [...entry.addresses, SENTINEL_ADDR]
            .map((a) => a + '\n')
            .join('');
        proc.stdin!.write(input);
    }

    private countHeaders(output: string): number {
        let count = 0;
        for (const rawLine of output.split('\n')) {
            if (ADDR2LINE_HEADER_RE.test(rawLine.trim())) {
                count++;
            }
        }
        return count;
    }

    private parseOutput(output: string, addresses: string[]): Addr2lineResult[] {
        const rawLines = output.split('\n');
        const sections: string[][] = [];
        let currentBody: string[] = [];

        for (const rawLine of rawLines) {
            const stripped = rawLine.trim();
            if (!stripped) {
                continue;
            }
            if (ADDR2LINE_HEADER_RE.test(stripped)) {
                sections.push(currentBody);
                currentBody = [];
            } else {
                currentBody.push(stripped);
            }
        }
        sections.push(currentBody);

        const bodySections = sections.slice(1, 1 + addresses.length);
        const results: Addr2lineResult[] = [];

        for (let i = 0; i < addresses.length; i++) {
            const originalAddr = addresses[i];

            if (i >= bodySections.length) {
                results.push({ address: originalAddr });
                continue;
            }

            const body = bodySections[i];
            let j = 0;
            let funcName: string | undefined;
            let file: string | undefined;
            let lineNum: string | undefined;

            while (j + 1 < body.length) {
                const func = body[j];
                const loc = DISCRIMINATOR_RE.test(body[j + 1])
                    ? body[j + 1].replace(DISCRIMINATOR_RE, '')
                    : body[j + 1];

                if (func === '??' && loc.startsWith('??:')) {
                    j += 2;
                    continue;
                }

                if (!funcName) {
                    funcName = func;
                    const colonIdx = loc.lastIndexOf(':');
                    if (colonIdx > 0) {
                        file = loc.substring(0, colonIdx);
                        const ln = loc.substring(colonIdx + 1);
                        lineNum = ln && ln !== '0' && ln !== '?' ? ln : undefined;
                    }
                }
                j += 2;
            }

            results.push({
                address: originalAddr,
                function: funcName,
                file,
                line: lineNum,
            });
        }

        return results;
    }
}

/** Pool of persistent addr2line processes keyed by tool + ELF pair. */
export class Addr2linePool {
    private readonly instances = new Map<string, PersistentAddr2line>();

    get(addr2linePath: string, elfPath: string): PersistentAddr2line {
        const key = `${addr2linePath}::${elfPath}`;
        let instance = this.instances.get(key);
        if (!instance) {
            instance = new PersistentAddr2line(addr2linePath, elfPath);
            this.instances.set(key, instance);
        }
        return instance;
    }

    disposeAll(): void {
        for (const instance of this.instances.values()) {
            instance.dispose();
        }
        this.instances.clear();
    }
}

export async function resolveAddressBatch(
    pool: Addr2linePool,
    addr2linePath: string,
    elfPath: string,
    addresses: string[],
): Promise<Addr2lineResult[]> {
    const instance = pool.get(addr2linePath, elfPath);
    return instance.resolveBatch(addresses);
}
