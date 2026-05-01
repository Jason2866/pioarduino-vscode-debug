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

export class FreeRTOSThreadParser implements RTOSThreadParser {
    readonly type = RTOSType.FreeRTOS;

    async parseThreads(reader: RTOSExpressionReader, options?: RTOSLoadOptions): Promise<RTOSThread[]> {
        const currentPtr = parseNumericValue(await evaluateValue(reader, 'pxCurrentTCB'));
        if (!currentPtr) {
            return [];
        }

        const gdbThreadId = defaultThreadId(options);
        const stackPointer = parseNumericValue(
            await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->pxTopOfStack')
        );
        const stackBase = parseNumericValue(await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->pxStack'));
        const stackEnd = parseNumericValue(await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->pxEndOfStack'));
        const priority = parseNumericValue(await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->uxPriority'));
        const stateValue = await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->eCurrentState');
        const name =
            parseThreadName(await evaluateValue(reader, '((TCB_t *)pxCurrentTCB)->pcTaskName')) ||
            `FreeRTOS Task ${gdbThreadId}`;

        return [
            {
                id: gdbThreadId,
                gdbThreadId,
                isCurrent: true,
                name,
                priority,
                stackPointer,
                stackInfo: calculateStackInfo(stackBase, stackEnd, stackPointer),
                state: mapFreeRTOSState(stateValue, true),
                source: this.type,
            },
        ];
    }
}

export class ThreadXThreadParser implements RTOSThreadParser {
    readonly type = RTOSType.ThreadX;

    async parseThreads(reader: RTOSExpressionReader, options?: RTOSLoadOptions): Promise<RTOSThread[]> {
        const currentPtr = parseNumericValue(await evaluateValue(reader, '_tx_thread_current_ptr'));
        if (!currentPtr) {
            return [];
        }

        const gdbThreadId = defaultThreadId(options);
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
            `ThreadX Thread ${gdbThreadId}`;

        return [
            {
                id: gdbThreadId,
                gdbThreadId,
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

        const gdbThreadId = defaultThreadId(options);
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
            parseThreadName(await evaluateValue(reader, '((struct k_thread *)_kernel.current)->name')) ||
            `Zephyr Thread ${gdbThreadId}`;

        return [
            {
                id: gdbThreadId,
                gdbThreadId,
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