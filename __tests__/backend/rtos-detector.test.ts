import {
    FreeRTOSThreadParser,
    RTOSDetector,
    RTOSManager,
    RTOSType,
    ThreadXThreadParser,
    ZephyrThreadParser,
} from '../../src/backend/rtos'

function createReader(values: Record<string, any>) {
    return {
        evalExpression: jest.fn().mockImplementation((expression: string) => {
            if (!(expression in values)) {
                return Promise.reject(new Error(`missing ${expression}`))
            }
            return Promise.resolve({
                result: (path: string) => (path === 'value' ? values[expression] : undefined),
            })
        }),
    }
}

describe('RTOSDetector', () => {
    test('detects FreeRTOS using pxCurrentTCB symbol', async () => {
        const detector = new RTOSDetector()
        const reader = createReader({ '&pxCurrentTCB': '0x20000000' })

        await expect(detector.detect(reader as any)).resolves.toBe(RTOSType.FreeRTOS)
    })

    test('detects ThreadX using _tx_thread_current_ptr symbol', async () => {
        const detector = new RTOSDetector()
        const reader = createReader({ '&_tx_thread_current_ptr': '0x24000000' })

        await expect(detector.detect(reader as any)).resolves.toBe(RTOSType.ThreadX)
    })

    test('detects Zephyr using _kernel.current symbol', async () => {
        const detector = new RTOSDetector()
        const reader = createReader({ '_kernel.current': '0x20003000' })

        await expect(detector.detect(reader as any)).resolves.toBe(RTOSType.Zephyr)
    })

    test('returns none when no RTOS markers are available', async () => {
        const detector = new RTOSDetector()
        const reader = {
            evalExpression: jest.fn().mockRejectedValue(new Error('missing')),
        }

        await expect(detector.detect(reader as any)).resolves.toBe(RTOSType.None)
    })
})

describe('RTOS parsers', () => {
    test('parses the current FreeRTOS task metadata', async () => {
        const parser = new FreeRTOSThreadParser()
        const reader = createReader({
            pxCurrentTCB: '0x20000000',
            '((TCB_t *)pxCurrentTCB)->pcTaskName': '"IdleTask"',
            '((TCB_t *)pxCurrentTCB)->uxPriority': '3',
            '((TCB_t *)pxCurrentTCB)->eCurrentState': '0',
            '((TCB_t *)pxCurrentTCB)->pxTopOfStack': '0x20001000',
            '((TCB_t *)pxCurrentTCB)->pxStack': '0x20000000',
            '((TCB_t *)pxCurrentTCB)->pxEndOfStack': '0x20002000',
        })

        const threads = await parser.parseThreads(reader as any, { currentGdbThreadId: 7 })

        expect(threads).toHaveLength(1)
        expect(threads[0]).toMatchObject({
            id: 7,
            gdbThreadId: 7,
            name: 'IdleTask',
            priority: 3,
            state: 'running',
            source: RTOSType.FreeRTOS,
        })
        expect(threads[0].stackInfo).toMatchObject({
            base: 0x20000000,
            size: 0x2000,
            used: 0x1000,
        })
    })

    test('parses ThreadX current thread metadata', async () => {
        const parser = new ThreadXThreadParser()
        const reader = createReader({
            _tx_thread_current_ptr: '0x24000000',
            '_tx_thread_current_ptr->tx_thread_name': '"control"',
            '_tx_thread_current_ptr->tx_thread_priority': '9',
            '_tx_thread_current_ptr->tx_thread_state': '4',
            '_tx_thread_current_ptr->tx_thread_stack_ptr': '0x24001000',
            '_tx_thread_current_ptr->tx_thread_stack_start': '0x24000000',
            '_tx_thread_current_ptr->tx_thread_stack_end': '0x24002000',
        })

        const threads = await parser.parseThreads(reader as any, { currentGdbThreadId: 2 })

        expect(threads[0]).toMatchObject({
            id: 2,
            name: 'control',
            priority: 9,
            state: 'blocked',
            source: RTOSType.ThreadX,
        })
    })

    test('parses Zephyr current thread metadata', async () => {
        const parser = new ZephyrThreadParser()
        const reader = createReader({
            '_kernel.current': '0x20003000',
            '((struct k_thread *)_kernel.current)->name': '"shell"',
            '((struct k_thread *)_kernel.current)->base.prio': '-1',
            '((struct k_thread *)_kernel.current)->base.thread_state': '0',
            '((struct k_thread *)_kernel.current)->callee_saved.psp': '0x20003100',
        })

        const threads = await parser.parseThreads(reader as any, { currentGdbThreadId: 4 })

        expect(threads[0]).toMatchObject({
            id: 4,
            name: 'shell',
            priority: -1,
            state: 'running',
            source: RTOSType.Zephyr,
        })
    })
})

describe('RTOSManager', () => {
    test('respects explicit RTOS type selection', async () => {
        const manager = new RTOSManager()
        const reader = createReader({
            _tx_thread_current_ptr: '0x24000000',
            '_tx_thread_current_ptr->tx_thread_name': '"worker"',
            '_tx_thread_current_ptr->tx_thread_priority': '2',
            '_tx_thread_current_ptr->tx_thread_state': '3',
            '_tx_thread_current_ptr->tx_thread_stack_ptr': '0x24000100',
            '_tx_thread_current_ptr->tx_thread_stack_start': '0x24000000',
            '_tx_thread_current_ptr->tx_thread_stack_end': '0x24001000',
        })

        const result = await manager.load(reader as any, {
            requestedType: 'threadx',
            currentGdbThreadId: 5,
        })

        expect(result.type).toBe(RTOSType.ThreadX)
        expect(result.threads[0]).toMatchObject({ id: 5, name: 'worker' })
    })
})