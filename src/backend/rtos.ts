import { MI2 } from './mi2/mi2';

export enum RTOSType {
    None = 'none',
    FreeRTOS = 'freertos',
    ThreadX = 'threadx',
    Zephyr = 'zephyr',
    Unknown = 'unknown',
}

export type RTOSRequestedType = 'auto' | RTOSType;

export type RTOSThreadState = 'running' | 'ready' | 'blocked' | 'suspended' | 'unknown';

export interface RTOSThreadStackInfo {
    base: number;
    size: number;
    used?: number;
}

export interface RTOSThread {
    id: number;
    gdbThreadId?: number;
    name: string;
    state: RTOSThreadState;
    priority?: number;
    stackPointer?: number;
    stackInfo?: RTOSThreadStackInfo;
    source: RTOSType;
    isCurrent?: boolean;
}

export interface RTOSLoadOptions {
    enabled?: boolean;
    requestedType?: RTOSRequestedType | string;
    currentGdbThreadId?: number;
    gdbThreadIds?: number[];
}

export interface RTOSLoadResult {
    type: RTOSType;
    threads: RTOSThread[];
}

export interface RTOSExpressionReader {
    evalExpression(expression: string): Promise<any>;
}

export interface RTOSThreadParser {
    readonly type: RTOSType;
    parseThreads(reader: RTOSExpressionReader, options?: RTOSLoadOptions): Promise<RTOSThread[]>;
}

function normalizeRequestedType(value?: RTOSRequestedType | string): RTOSRequestedType {
    if (!value) {
        return 'auto';
    }

    const normalized = value.toString().trim().toLowerCase();
    switch (normalized) {
        case 'none':
            return RTOSType.None;
        case 'freertos':
            return RTOSType.FreeRTOS;
        case 'threadx':
            return RTOSType.ThreadX;
        case 'zephyr':
            return RTOSType.Zephyr;
        case 'unknown':
            return RTOSType.Unknown;
        default:
            return 'auto';
    }
}

async function evaluateValue(
    reader: RTOSExpressionReader,
    expression: string
): Promise<string | undefined> {
    try {
        const result = await reader.evalExpression(expression);
        if (result === undefined || result === null) {
            return undefined;
        }

        if (typeof result === 'string') {
            return result;
        }

        if (typeof result.result === 'function') {
            const value = result.result('value') ?? result.result('');
            if (value === undefined || value === null) {
                return undefined;
            }
            return String(value);
        }

        if (result.value !== undefined && result.value !== null) {
            return String(result.value);
        }

        return String(result);
    } catch {
        return undefined;
    }
}

function parseNumericValue(value?: string): number | undefined {
    if (!value) {
        return undefined;
    }

    const hexMatch = value.match(/-?0x[0-9a-f]+/i);
    if (hexMatch) {
        return parseInt(hexMatch[0], 16);
    }

    const decMatch = value.match(/-?\d+/);
    if (decMatch) {
        return parseInt(decMatch[0], 10);
    }

    return undefined;
}

function parseThreadName(value?: string): string | undefined {
    if (!value) {
        return undefined;
    }

    const quoted = value.match(/"([^"]*)"/);
    if (quoted) {
        return quoted[1];
    }

    const trimmed = value.trim();
    if (!trimmed || /^0x0+$/i.test(trimmed)) {
        return undefined;
    }

    return trimmed.replace(/^0x[0-9a-f]+\s*/i, '').trim() || undefined;
}

function calculateStackInfo(
    stackBase: number | undefined,
    stackEnd: number | undefined,
    stackPointer: number | undefined
): RTOSThreadStackInfo | undefined {
    if (stackBase === undefined || stackEnd === undefined) {
        return undefined;
    }

    const size = Math.abs(stackEnd - stackBase);
    const used = stackPointer === undefined ? undefined : Math.max(0, Math.abs(stackEnd - stackPointer));
    return {
        base: Math.min(stackBase, stackEnd),
        size,
        used,
    };
}

function mapFreeRTOSState(value: string | undefined, isCurrent: boolean): RTOSThreadState {
    const numeric = parseNumericValue(value);
    switch (numeric) {
        case 0:
            return 'running';
        case 1:
            return 'ready';
        case 2:
            return 'blocked';
        case 3:
            return 'suspended';
        default:
            return isCurrent ? 'running' : 'unknown';
    }
}

function mapThreadXState(value: string | undefined, isCurrent: boolean): RTOSThreadState {
    const numeric = parseNumericValue(value);
    switch (numeric) {
        case 0:
            return isCurrent ? 'running' : 'ready';
        case 1:
        case 2:
            return 'suspended';
        case 3:
            return 'ready';
        case 4:
        case 5:
        case 6:
        case 7:
        case 8:
        case 9:
        case 10:
        case 11:
        case 12:
        case 13:
            return 'blocked';
        default:
            return isCurrent ? 'running' : 'unknown';
    }
}

function mapZephyrState(value: string | undefined, isCurrent: boolean): RTOSThreadState {
    const numeric = parseNumericValue(value);
    if (numeric === undefined) {
        return isCurrent ? 'running' : 'unknown';
    }

    if (numeric === 0) {
        return isCurrent ? 'running' : 'ready';
    }

    if (numeric & 0x8 || numeric & 0x10 || numeric & 0x20) {
        return 'suspended';
    }

    return 'blocked';
}

function defaultThreadId(options?: RTOSLoadOptions): number {
    return options?.currentGdbThreadId ?? options?.gdbThreadIds?.[0] ?? 1;
}

export class RTOSDetector {
    async detect(reader: RTOSExpressionReader): Promise<RTOSType> {
        if (await this.symbolExists(reader, '&pxCurrentTCB')) {
            return RTOSType.FreeRTOS;
        }

        if (await this.symbolExists(reader, '&_tx_thread_current_ptr')) {
            return RTOSType.ThreadX;
        }

        if (await this.symbolExists(reader, '&_kernel')) {
            return RTOSType.Zephyr;
        }

        return RTOSType.None;
    }

    private async symbolExists(reader: RTOSExpressionReader, expression: string): Promise<boolean> {
        const value = await evaluateValue(reader, expression);
        return value !== undefined;
    }
}

// ---------------------------------------------------------------------------
// FreeRTOS list-walking helpers
// ---------------------------------------------------------------------------

/** Reads a FreeRTOS TCB by its numeric address and returns an RTOSThread. */
async function readFreeRTOSTCBByAddress(
    reader: RTOSExpressionReader,
    tcbPtr: number,
    gdbThreadId: number | undefined,
    isCurrent: boolean,
    source: RTOSType
): Promise<RTOSThread> {
    const hex = `0x${tcbPtr.toString(16)}`;
    const stackPointer = parseNumericValue(
        await evaluateValue(reader, `((TCB_t*)${hex})->pxTopOfStack`)
    );
    const stackBase = parseNumericValue(await evaluateValue(reader, `((TCB_t*)${hex})->pxStack`));
    const stackEnd = parseNumericValue(await evaluateValue(reader, `((TCB_t*)${hex})->pxEndOfStack`));
    const priority = parseNumericValue(await evaluateValue(reader, `((TCB_t*)${hex})->uxPriority`));
    const stateValue = await evaluateValue(reader, `((TCB_t*)${hex})->eCurrentState`);
    const name =
        parseThreadName(await evaluateValue(reader, `((TCB_t*)${hex})->pcTaskName`)) ||
        `FreeRTOS Task 0x${tcbPtr.toString(16)}`;

    return {
        id: gdbThreadId ?? tcbPtr,
        gdbThreadId,
        isCurrent,
        name,
        priority,
        stackPointer,
        stackInfo: calculateStackInfo(stackBase, stackEnd, stackPointer),
        state: mapFreeRTOSState(stateValue, isCurrent),
        source,
    };
}

/**
 * Walks a FreeRTOS List_t (suspended / delayed task list) and appends any
 * new TCBs found to `threads`.
 */
async function walkFreeRTOSStateList(
    reader: RTOSExpressionReader,
    listName: string,
    visitedTCBPtrs: Set<number>,
    threads: RTOSThread[],
    maxTasks: number,
    source: RTOSType
): Promise<void> {
    const itemCount = parseNumericValue(
        await evaluateValue(reader, `${listName}.uxNumberOfItems`)
    );
    if (!itemCount) {
        return;
    }

    let itemPtr = parseNumericValue(
        await evaluateValue(reader, `${listName}.xListEnd.pxNext`)
    );

    for (let i = 0; i < itemCount && itemPtr && threads.length < maxTasks; i++) {
        const hex = `0x${itemPtr.toString(16)}`;
        const tcbPtr = parseNumericValue(
            await evaluateValue(reader, `((ListItem_t*)${hex})->pvOwner`)
        );
        if (tcbPtr && !visitedTCBPtrs.has(tcbPtr)) {
            visitedTCBPtrs.add(tcbPtr);
            threads.push(
                await readFreeRTOSTCBByAddress(reader, tcbPtr, undefined, false, source)
            );
        }
        itemPtr = parseNumericValue(
            await evaluateValue(reader, `((ListItem_t*)${hex})->pxNext`)
        );
    }
}

export class FreeRTOSThreadParser implements RTOSThreadParser {
    readonly type = RTOSType.FreeRTOS;

    async parseThreads(reader: RTOSExpressionReader, options?: RTOSLoadOptions): Promise<RTOSThread[]> {
        const currentPtr = parseNumericValue(await evaluateValue(reader, 'pxCurrentTCB'));
        if (!currentPtr) {
            return [];
        }

        const gdbCurrentThreadId = defaultThreadId(options);

        // Always build the current-task entry via the well-known named expression so the
        // existing GDB symbol path continues to work on minimal targets.
        const currentStackPointer = parseNumericValue(
            await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->pxTopOfStack')
        );
        const currentThread: RTOSThread = {
            id: gdbCurrentThreadId,
            gdbThreadId: gdbCurrentThreadId,
            isCurrent: true,
            name:
                parseThreadName(await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->pcTaskName')) ||
                `FreeRTOS Task ${gdbCurrentThreadId}`,
            priority: parseNumericValue(await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->uxPriority')),
            stackPointer: currentStackPointer,
            stackInfo: calculateStackInfo(
                parseNumericValue(await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->pxStack')),
                parseNumericValue(await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->pxEndOfStack')),
                currentStackPointer
            ),
            state: mapFreeRTOSState(
                await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->eCurrentState'),
                true
            ),
            source: this.type,
        };

        const threads: RTOSThread[] = [currentThread];
        const visitedTCBPtrs = new Set<number>([currentPtr]);

        // Try to enumerate all tasks by walking the scheduler lists.
        // Falls back gracefully when expressions are unavailable.
        const totalTasks =
            parseNumericValue(await evaluateValue(reader, 'uxCurrentNumberOfTasks')) ?? 0;
        if (totalTasks <= 1) {
            return threads;
        }

        // Walk ready task lists (one circular list per priority level).
        for (let prio = 0; prio < 32 && threads.length < totalTasks; prio++) {
            const itemCount = parseNumericValue(
                await evaluateValue(reader, `pxReadyTasksLists[${prio}].uxNumberOfItems`)
            );
            if (!itemCount) {
                continue;
            }

            let itemPtr = parseNumericValue(
                await evaluateValue(reader, `pxReadyTasksLists[${prio}].xListEnd.pxNext`)
            );

            for (let i = 0; i < itemCount && itemPtr; i++) {
                const hex = `0x${itemPtr.toString(16)}`;
                const tcbPtr = parseNumericValue(
                    await evaluateValue(reader, `((ListItem_t*)${hex})->pvOwner`)
                );
                if (tcbPtr && !visitedTCBPtrs.has(tcbPtr)) {
                    visitedTCBPtrs.add(tcbPtr);
                    threads.push(
                        await readFreeRTOSTCBByAddress(reader, tcbPtr, undefined, false, this.type)
                    );
                }
                itemPtr = parseNumericValue(
                    await evaluateValue(reader, `((ListItem_t*)${hex})->pxNext`)
                );
            }
        }

        // Walk suspended and delayed task lists.
        for (const listName of ['xSuspendedTaskList', 'xDelayedTaskList1', 'xDelayedTaskList2']) {
            if (threads.length >= totalTasks) {
                break;
            }
            await walkFreeRTOSStateList(
                reader,
                listName,
                visitedTCBPtrs,
                threads,
                totalTasks,
                this.type
            );
        }

        return threads;
    }
}

export class ThreadXThreadParser implements RTOSThreadParser {
    readonly type = RTOSType.ThreadX;

    async parseThreads(reader: RTOSExpressionReader, options?: RTOSLoadOptions): Promise<RTOSThread[]> {
        const currentPtr = parseNumericValue(await evaluateValue(reader, '_tx_thread_current_ptr'));
        if (!currentPtr) {
            return [];
        }

        const gdbCurrentThreadId = defaultThreadId(options);

        // Try to walk the full created-thread circular linked list.
        const listHeadPtr = parseNumericValue(await evaluateValue(reader, '_tx_thread_created_ptr'));
        if (listHeadPtr) {
            const threads: RTOSThread[] = [];
            const visitedPtrs = new Set<number>();
            let threadPtr: number | undefined = listHeadPtr;
            let safety = 0;

            while (threadPtr && !visitedPtrs.has(threadPtr) && safety++ < 64) {
                visitedPtrs.add(threadPtr);
                const hex = `0x${threadPtr.toString(16)}`;
                const isCurrent = threadPtr === currentPtr;
                // Use the symbolic pointer expression for the current thread to remain
                // compatible with targets that only expose _tx_thread_current_ptr.
                const expr = isCurrent ? '_tx_thread_current_ptr' : `(TX_THREAD*)${hex}`;

                const stackPointer = parseNumericValue(
                    await evaluateValue(reader, `${expr}->tx_thread_stack_ptr`)
                );
                const stackBase = parseNumericValue(
                    await evaluateValue(reader, `${expr}->tx_thread_stack_start`)
                );
                const stackEnd = parseNumericValue(
                    await evaluateValue(reader, `${expr}->tx_thread_stack_end`)
                );
                const priority = parseNumericValue(
                    await evaluateValue(reader, `${expr}->tx_thread_priority`)
                );
                const stateValue = await evaluateValue(reader, `${expr}->tx_thread_state`);
                const name =
                    parseThreadName(await evaluateValue(reader, `${expr}->tx_thread_name`)) ||
                    `ThreadX Thread ${isCurrent ? gdbCurrentThreadId : threadPtr}`;

                threads.push({
                    id: isCurrent ? gdbCurrentThreadId : threadPtr,
                    gdbThreadId: isCurrent ? gdbCurrentThreadId : undefined,
                    isCurrent,
                    name,
                    priority,
                    stackPointer,
                    stackInfo: calculateStackInfo(stackBase, stackEnd, stackPointer),
                    state: mapThreadXState(stateValue, isCurrent),
                    source: this.type,
                });

                // tx_thread_created_next forms a circular list; the visited-set detects wrap-around.
                threadPtr = parseNumericValue(
                    await evaluateValue(reader, `((TX_THREAD*)${hex})->tx_thread_created_next`)
                );
            }

            if (threads.length > 0) {
                return threads;
            }
        }

        // Fallback: return only the current thread via the existing named expressions.
        const stackPointer = parseNumericValue(
            await evaluateValue(reader, '_tx_thread_current_ptr->tx_thread_stack_ptr')
        );
        const stackBase = parseNumericValue(
            await evaluateValue(reader, '_tx_thread_current_ptr->tx_thread_stack_start')
        );
        const stackEnd = parseNumericValue(
            await evaluateValue(reader, '_tx_thread_current_ptr->tx_thread_stack_end')
        );
        const priority = parseNumericValue(
            await evaluateValue(reader, '_tx_thread_current_ptr->tx_thread_priority')
        );
        const stateValue = await evaluateValue(reader, '_tx_thread_current_ptr->tx_thread_state');
        const name =
            parseThreadName(await evaluateValue(reader, '_tx_thread_current_ptr->tx_thread_name')) ||
            `ThreadX Thread ${gdbCurrentThreadId}`;

        return [
            {
                id: gdbCurrentThreadId,
                gdbThreadId: gdbCurrentThreadId,
                isCurrent: true,
                name,
                priority,
                stackPointer,
                stackInfo: calculateStackInfo(stackBase, stackEnd, stackPointer),
                state: mapThreadXState(stateValue, true),
                source: this.type,
            },
        ];
    }
}

export class ZephyrThreadParser implements RTOSThreadParser {
    readonly type = RTOSType.Zephyr;

    async parseThreads(reader: RTOSExpressionReader, options?: RTOSLoadOptions): Promise<RTOSThread[]> {
        const currentPtr = parseNumericValue(await evaluateValue(reader, '_kernel.current'));
        if (!currentPtr) {
            return [];
        }

        const gdbCurrentThreadId = defaultThreadId(options);

        // Try to walk the full NULL-terminated thread list via _kernel.threads.
        const listHeadPtr = parseNumericValue(await evaluateValue(reader, '_kernel.threads'));
        if (listHeadPtr) {
            const threads: RTOSThread[] = [];
            const visitedPtrs = new Set<number>();
            let threadPtr: number | undefined = listHeadPtr;
            let safety = 0;

            while (threadPtr && !visitedPtrs.has(threadPtr) && safety++ < 64) {
                visitedPtrs.add(threadPtr);
                const hex = `0x${threadPtr.toString(16)}`;
                const isCurrent = threadPtr === currentPtr;
                // Use the symbolic pointer expression for the current thread for compat.
                const expr = isCurrent
                    ? '(struct k_thread *)_kernel.current'
                    : `(struct k_thread*)${hex}`;

                const stackPointer = parseNumericValue(
                    await evaluateValue(reader, `${expr}->callee_saved.psp`)
                );
                const priority = parseNumericValue(await evaluateValue(reader, `${expr}->base.prio`));
                const stateValue = await evaluateValue(reader, `${expr}->base.thread_state`);
                const name =
                    parseThreadName(await evaluateValue(reader, `${expr}->name`)) ||
                    `Zephyr Thread ${isCurrent ? gdbCurrentThreadId : threadPtr}`;

                threads.push({
                    id: isCurrent ? gdbCurrentThreadId : threadPtr,
                    gdbThreadId: isCurrent ? gdbCurrentThreadId : undefined,
                    isCurrent,
                    name,
                    priority,
                    stackPointer,
                    state: mapZephyrState(stateValue, isCurrent),
                    source: this.type,
                });

                threadPtr = parseNumericValue(
                    await evaluateValue(reader, `((struct k_thread*)${hex})->next_thread`)
                );
            }

            if (threads.length > 0) {
                return threads;
            }
        }

        // Fallback: return only the current thread via the existing named expressions.
        const stackPointer = parseNumericValue(
            await evaluateValue(reader, '((struct k_thread *)_kernel.current)->callee_saved.psp')
        );
        const priority = parseNumericValue(
            await evaluateValue(reader, '((struct k_thread *)_kernel.current)->base.prio')
        );
        const stateValue = await evaluateValue(
            reader,
            '((struct k_thread *)_kernel.current)->base.thread_state'
        );
        const name =
            parseThreadName(
                await evaluateValue(reader, '((struct k_thread *)_kernel.current)->name')
            ) || `Zephyr Thread ${gdbCurrentThreadId}`;

        return [
            {
                id: gdbCurrentThreadId,
                gdbThreadId: gdbCurrentThreadId,
                isCurrent: true,
                name,
                priority,
                stackPointer,
                state: mapZephyrState(stateValue, true),
                source: this.type,
            },
        ];
    }
}

export class RTOSManager {
    private parsers = new Map<RTOSType, RTOSThreadParser>();

    constructor(private detector: RTOSDetector = new RTOSDetector()) {
        const supportedParsers: RTOSThreadParser[] = [
            new FreeRTOSThreadParser(),
            new ThreadXThreadParser(),
            new ZephyrThreadParser(),
        ];

        supportedParsers.forEach((parser) => {
            this.parsers.set(parser.type, parser);
        });
    }

    async load(reader: MI2 | RTOSExpressionReader, options?: RTOSLoadOptions): Promise<RTOSLoadResult> {
        if (options?.enabled === false) {
            return { type: RTOSType.None, threads: [] };
        }

        const requestedType = normalizeRequestedType(options?.requestedType);
        const resolvedType =
            requestedType === 'auto' ? await this.detector.detect(reader as RTOSExpressionReader) : requestedType;
        const parser = this.parsers.get(resolvedType);

        if (!parser) {
            return { type: resolvedType, threads: [] };
        }

        const threads = await parser.parseThreads(reader as RTOSExpressionReader, options);
        return { type: resolvedType, threads };
    }
}