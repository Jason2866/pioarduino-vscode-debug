import { GDBDebugSession } from '../../src/backend/adapter'

function makeThreadInfo(id: number, label: string) {
    return [
        [
            'id',
            String(id),
        ],
        [
            'target-id',
            `Thread ${id}`,
        ],
        [
            'details',
            label,
        ],
    ]
}

describe('RTOS thread mapping', () => {
    test('threadsRequest enriches thread labels with RTOS metadata', async () => {
        const session = new GDBDebugSession() as any
        session.stopped = true
        session.currentThreadId = 2
        session.args = { rtos: { enabled: true, type: 'auto' } }
        session.miDebugger = {
            sendCommand: jest.fn().mockImplementation((command: string) => {
                if (command === 'thread-list-ids') {
                    return Promise.resolve({
                        result: (path: string) => {
                            if (path === 'thread-ids') return [['id', '1'], ['id', '2']]
                            if (path === 'current-thread-id') return '2'
                            return undefined
                        },
                    })
                }

                if (command === 'thread-info 1') {
                    return Promise.resolve({ result: (path: string) => (path === 'threads' ? [makeThreadInfo(1, 'main')] : undefined) })
                }

                if (command === 'thread-info 2') {
                    return Promise.resolve({ result: (path: string) => (path === 'threads' ? [makeThreadInfo(2, 'worker')] : undefined) })
                }

                return Promise.reject(new Error(`unexpected ${command}`))
            }),
        }
        session.rtosManager = {
            load: jest.fn().mockResolvedValue({
                type: 'freertos',
                threads: [
                    {
                        id: 2,
                        gdbThreadId: 2,
                        name: 'IdleTask',
                        state: 'running',
                        priority: 1,
                        source: 'freertos',
                    },
                ],
            }),
        }
        session.sendResponse = jest.fn()
        session.sendErrorResponse = jest.fn()

        const response: any = {}
        await session.threadsRequest(response)

        expect(response.body.threads).toHaveLength(2)
        expect(response.body.threads[0]).toMatchObject({ id: 1, name: 'main' })
        expect(response.body.threads[1]).toMatchObject({
            id: 2,
            name: expect.stringContaining('IdleTask'),
        })
        expect(response.body.threads[1].name).toContain('running')
        expect(response.body.threads[1].name).toContain('prio 1')
    })

    test('stackTraceRequest resolves DAP thread ids through the RTOS map', async () => {
        const session = new GDBDebugSession() as any
        session.miDebugger = {
            getStack: jest.fn().mockResolvedValue([
                {
                    level: '0',
                    address: '0x1000',
                    function: 'main',
                    fileName: 'main.c',
                    file: '/tmp/main.c',
                    line: 42,
                },
            ]),
        }
        session.checkFileExists = jest.fn().mockResolvedValue(true)
        session.symbolTable = { getFunctionByName: jest.fn().mockReturnValue(undefined) }
        session.dapThreadIdMap = new Map([[1001, 2]])
        session.sendResponse = jest.fn()
        session.sendErrorResponse = jest.fn()

        const response: any = {}
        await session.stackTraceRequest(response, { threadId: 1001, startFrame: 0, levels: 20 })

        expect(session.miDebugger.getStack).toHaveBeenCalledWith(2, 0, 20)
        expect(response.body.stackFrames).toHaveLength(1)
        expect(response.body.stackFrames[0].name).toBe('main@0x1000')
    })
})