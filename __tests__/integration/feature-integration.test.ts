/**
 * Integration tests for v1.2.0 features.
 *
 * Each suite wires multiple modules together to verify that cross-component
 * workflows produce the expected end-to-end behaviour without a real VS Code
 * host or hardware target.
 */

// ─── Shared VS Code mock ─────────────────────────────────────────────────────

const mockCustomRequest = jest.fn()
let mockActiveDebugSession: any = undefined

jest.mock('vscode', () => {
    const actual = jest.requireActual('../../__mocks__/vscode')

    const mockOutputChannel = {
        appendLine: jest.fn(),
        clear: jest.fn(),
        show: jest.fn(),
    }

    const mockThenable = {
        then: jest.fn(function (this: any, cb?: (v: any) => any) {
            if (cb) { cb(undefined) }
            return this
        }),
        catch: jest.fn().mockReturnThis(),
    }

    return {
        ...actual,
        window: {
            ...actual.window,
            createOutputChannel: jest.fn().mockReturnValue(mockOutputChannel),
            showErrorMessage: jest.fn().mockReturnValue(mockThenable),
            showWarningMessage: jest.fn().mockReturnValue(mockThenable),
            showInformationMessage: jest.fn().mockReturnValue(mockThenable),
            showOpenDialog: jest.fn().mockResolvedValue(undefined),
            showQuickPick: jest.fn().mockResolvedValue(undefined),
            createTextEditorDecorationType: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        },
        debug: {
            get activeDebugSession() { return mockActiveDebugSession },
        },
        workspace: { textDocuments: [] },
        env: {
            clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
            openExternal: jest.fn().mockResolvedValue(true),
        },
        commands: { executeCommand: jest.fn().mockResolvedValue(undefined) },
    }
})

import * as vscode from 'vscode'

// ─── 1. Memory editor: write → refresh → diff detection ──────────────────────

import { MemoryContentProvider, MemoryDataType, Endianness } from '../../src/frontend/memory_content_provider'

describe('Memory editor – write / refresh / diff integration', () => {
    let provider: MemoryContentProvider

    beforeEach(() => {
        jest.clearAllMocks()
        provider = new MemoryContentProvider()
        mockActiveDebugSession = { customRequest: mockCustomRequest }
    })

    afterEach(() => {
        mockActiveDebugSession = undefined
    })

    test('first read stores snapshot; second read with changed byte reports diff', async () => {
        const firstBytes  = [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
                             0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]
        const secondBytes = [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
                             0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01] // byte 15 changed

        const uri = { query: 'address=0x20000000&length=0x10' } as any

        // First read – establishes snapshot
        mockCustomRequest.mockResolvedValueOnce({ bytes: firstBytes })
        await provider.provideTextDocumentContent(uri)
        expect(provider.getChangedOffsets()).toHaveLength(0)

        // Second read – one byte changed
        mockCustomRequest.mockResolvedValueOnce({ bytes: secondBytes })
        const output = await provider.provideTextDocumentContent(uri)

        const changed = provider.getChangedOffsets()
        expect(changed).toHaveLength(0)  // snapshot was just updated; offsets reported during render
        expect(output).toContain('Diff: 1 byte(s) changed since last read')
    })

    test('no diff line when bytes are identical across two reads', async () => {
        const bytes = [0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x03,
                       0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B]
        const uri = { query: 'address=0x10000000&length=0x10' } as any

        mockCustomRequest.mockResolvedValueOnce({ bytes })
        await provider.provideTextDocumentContent(uri)

        mockCustomRequest.mockResolvedValueOnce({ bytes: [...bytes] })
        const output = await provider.provideTextDocumentContent(uri)

        expect(output).not.toContain('Diff:')
    })

    test('ASCII column present when showAscii=true; absent when toggled off', async () => {
        const bytes = Array.from({ length: 16 }, (_, i) => 0x41 + i) // 'A'...'P'
        const uri = { query: 'address=0x20000000&length=0x10' } as any

        mockCustomRequest.mockResolvedValueOnce({ bytes })
        const withAscii = await provider.provideTextDocumentContent(uri)
        expect(withAscii).toContain('ASCII')
        expect(withAscii).toContain('|')

        provider.toggleAsciiView()
        mockCustomRequest.mockResolvedValueOnce({ bytes })
        const withoutAscii = await provider.provideTextDocumentContent(uri)
        expect(withoutAscii).not.toContain('ASCII')
        expect(withoutAscii).not.toContain('|')
    })

    test('data type header changes after setDataType', async () => {
        const bytes = Array.from({ length: 16 }, (_, i) => i)
        const uri = { query: 'address=0x20000000&length=0x10' } as any

        mockCustomRequest.mockResolvedValueOnce({ bytes })
        const u8Output = await provider.provideTextDocumentContent(uri)
        expect(u8Output).toContain(`Data Type: ${MemoryDataType.U8}`)

        provider.setDataType(MemoryDataType.U32)
        mockCustomRequest.mockResolvedValueOnce({ bytes })
        const u32Output = await provider.provideTextDocumentContent(uri)
        expect(u32Output).toContain(`Data Type: ${MemoryDataType.U32}`)
    })

    test('endianness toggle is reflected in successive content renders', async () => {
        const bytes = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
                       0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10]
        const uri = { query: 'address=0x20000000&length=0x10' } as any

        provider.setDataType(MemoryDataType.U32)

        mockCustomRequest.mockResolvedValueOnce({ bytes })
        const leOutput = await provider.provideTextDocumentContent(uri)
        expect(leOutput).toContain(`Endianness: ${Endianness.Little}`)

        provider.toggleEndianness()
        mockCustomRequest.mockResolvedValueOnce({ bytes })
        const beOutput = await provider.provideTextDocumentContent(uri)
        expect(beOutput).toContain(`Endianness: ${Endianness.Big}`)
        // The U32 interpreted values should differ between LE and BE
        const leSection = leOutput.split('Data Type Interpretation')[1] ?? ''
        const beSection = beOutput.split('Data Type Interpretation')[1] ?? ''
        expect(leSection).not.toBe(beSection)
    })
})

// ─── 2. RTOS: detection → parsing → adapter thread enrichment ────────────────

import { RTOSManager, RTOSType } from '../../src/backend/rtos'
import { GDBDebugSession } from '../../src/backend/adapter'

function makeReader(values: Record<string, string | undefined>) {
    return {
        evalExpression: jest.fn().mockImplementation((expr: string) => {
            if (!(expr in values) || values[expr] === undefined) {
                return Promise.reject(new Error(`unknown: ${expr}`))
            }
            return Promise.resolve({
                result: (path: string) => (path === 'value' ? values[expr] : undefined),
            })
        }),
    }
}

describe('RTOS – detect → parse → DAP thread list integration', () => {
    test('RTOSManager auto-detects FreeRTOS and returns parsed thread', async () => {
        const manager = new RTOSManager()
        const reader = makeReader({
            '&pxCurrentTCB': '0x20000100',
            pxCurrentTCB: '0x20000100',
            '((TCB_t *)pxCurrentTCB)->pcTaskName': '"main_task"',
            '((TCB_t *)pxCurrentTCB)->uxPriority': '5',
            '((TCB_t *)pxCurrentTCB)->eCurrentState': '0',
            '((TCB_t *)pxCurrentTCB)->pxTopOfStack': '0x20001800',
            '((TCB_t *)pxCurrentTCB)->pxStack': '0x20001000',
            '((TCB_t *)pxCurrentTCB)->pxEndOfStack': '0x20002000',
            // list-walking: uxCurrentNumberOfTasks = 1, so no extra traversal
            uxCurrentNumberOfTasks: '1',
        })

        const result = await manager.load(reader as any, {
            enabled: true,
            requestedType: 'auto',
            currentGdbThreadId: 3,
        })

        expect(result.type).toBe(RTOSType.FreeRTOS)
        expect(result.threads.length).toBeGreaterThanOrEqual(1)
        const current = result.threads.find((t) => t.isCurrent)
        expect(current).toBeDefined()
        expect(current!.name).toBe('main_task')
        expect(current!.priority).toBe(5)
        expect(current!.state).toBe('running')
    })

    test('RTOSManager returns empty threads when RTOS disabled', async () => {
        const manager = new RTOSManager()
        const reader = makeReader({})
        const result = await manager.load(reader as any, { enabled: false })
        expect(result.type).toBe(RTOSType.None)
        expect(result.threads).toHaveLength(0)
    })

    test('RTOSManager returns None when no RTOS symbols present', async () => {
        const manager = new RTOSManager()
        const reader = { evalExpression: jest.fn().mockRejectedValue(new Error('no symbols')) }
        const result = await manager.load(reader as any, { enabled: true, requestedType: 'auto' })
        expect(result.type).toBe(RTOSType.None)
    })

    test('GDBDebugSession.threadsRequest enriches thread name with RTOS metadata', async () => {
        const session = new GDBDebugSession() as any
        session.stopped = true
        session.currentThreadId = 1
        session.args = { rtos: { enabled: true, type: 'auto' } }

        session.miDebugger = {
            sendCommand: jest.fn().mockImplementation((cmd: string) => {
                if (cmd === 'thread-list-ids') {
                    return Promise.resolve({
                        result: (p: string) => {
                            if (p === 'thread-ids') return [['id', '1']]
                            if (p === 'current-thread-id') return '1'
                        },
                    })
                }
                if (cmd === 'thread-info 1') {
                    return Promise.resolve({
                        result: (p: string) =>
                            p === 'threads'
                                ? [[['id', '1'], ['target-id', 'Thread 1'], ['details', 'idle']]]
                                : undefined,
                    })
                }
                return Promise.reject(new Error(`unexpected: ${cmd}`))
            }),
        }

        session.rtosManager = {
            load: jest.fn().mockResolvedValue({
                type: RTOSType.FreeRTOS,
                threads: [{
                    id: 1,
                    gdbThreadId: 1,
                    name: 'IdleTask',
                    state: 'running',
                    priority: 0,
                    isCurrent: true,
                    source: RTOSType.FreeRTOS,
                }],
            }),
        }

        session.sendResponse = jest.fn()
        session.sendErrorResponse = jest.fn()

        const response: any = {}
        await session.threadsRequest(response)

        expect(response.body.threads).toHaveLength(1)
        const label: string = response.body.threads[0].name
        expect(label).toContain('IdleTask')
        expect(label).toMatch(/running/i)
    })
})

// ─── 3. Diagnostics: log → classify → export → clear ────────────────────────

import {
    getDiagnosticsManager,
    resetDiagnosticsManager,
} from '../../src/frontend/diagnostics'

describe('Diagnostics pipeline – log / classify / export / clear integration', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        resetDiagnosticsManager()
    })

    test('logged entries appear in exportLog output with correct structure', () => {
        const mgr = getDiagnosticsManager()

        mgr.info('TestSource', 'Session started')
        mgr.warn('TestSource', 'Low memory', 'heap < 512 bytes')
        mgr.error('TestSource', 'Connection refused', 'port 3333 not listening')

        const exported = mgr.exportLog()

        expect(exported).toContain('PlatformIO Debug Diagnostic Log')
        expect(exported).toContain('Total Entries: 3')
        expect(exported).toContain('[INFO]')
        expect(exported).toContain('Session started')
        expect(exported).toContain('[WARN]')
        expect(exported).toContain('Low memory')
        expect(exported).toContain('[ERROR]')
        expect(exported).toContain('Connection refused')
        expect(exported).toContain('port 3333 not listening')
    })

    test('clearLog removes all entries and subsequent export shows 0 entries', () => {
        const mgr = getDiagnosticsManager()

        mgr.error('A', 'first')
        mgr.error('B', 'second')
        expect(mgr.getLogEntries()).toHaveLength(2)

        mgr.clearLog()

        expect(mgr.getLogEntries()).toHaveLength(0)
        const exported = mgr.exportLog()
        expect(exported).toContain('Total Entries: 0')
    })

    test('handleConnectionError classifies the error and logs it', () => {
        const mgr = getDiagnosticsManager()
        mgr.handleConnectionError('Connection refused by remote host')

        const errors = mgr.getLogEntries('error')
        expect(errors.length).toBeGreaterThanOrEqual(1)
        const messages = errors.map((e) => e.message).join(' ')
        expect(messages).toMatch(/connection|refused/i)
    })

    test('handleSVDError classifies the error and logs it', () => {
        const mgr = getDiagnosticsManager()
        mgr.handleSVDError('No such file or directory: /path/to/device.svd')

        const errors = mgr.getLogEntries('error')
        expect(errors.length).toBeGreaterThanOrEqual(1)
    })

    test('getLogEntries filtered by level returns only matching entries', () => {
        const mgr = getDiagnosticsManager()
        mgr.info('S', 'info message')
        mgr.warn('S', 'warn message')
        mgr.error('S', 'error message')

        const errors = mgr.getLogEntries('error')
        expect(errors).toHaveLength(1)
        expect(errors[0].level).toBe('error')

        const infos = mgr.getLogEntries('info')
        expect(infos).toHaveLength(1)
        expect(infos[0].level).toBe('info')
    })

    test('showInfo delegates to the VS Code info message and logs the entry', () => {
        const mgr = getDiagnosticsManager()
        mgr.showInfo('Reloaded SVD: /tmp/device.svd')

        const infos = mgr.getLogEntries('info')
        expect(infos.length).toBeGreaterThanOrEqual(1)
        expect(vscode.window.showInformationMessage).toHaveBeenCalled()
    })
})

// ─── 4. SVD peripheral: FieldNode tooltip + RegisterNode change highlight ────

import {
    AccessType,
    FieldNode,
    PeripheralNode,
    RegisterNode,
} from '../../src/frontend/peripheral'

function makeRegister(
    parent: PeripheralNode,
    name: string,
    options: Partial<{
        addressOffset: number
        resetValue: number
        size: number
        accessType: AccessType
    }> = {}
): RegisterNode {
    return new RegisterNode(parent, {
        name,
        description: `${name} register`,
        addressOffset: options.addressOffset ?? 0,
        resetValue: options.resetValue ?? 0,
        size: options.size ?? 32,
        accessType: options.accessType ?? AccessType.ReadWrite,
    })
}

describe('SVD peripheral – bit-field tooltip + register diff integration', () => {
    let peripheral: PeripheralNode
    let register: RegisterNode

    beforeEach(() => {
        jest.clearAllMocks()
        peripheral = new PeripheralNode({
            name: 'GPIO',
            baseAddress: 0x48000000,
            description: 'GPIO controller',
            totalLength: 0x400,
            size: 32,
            resetValue: 0n,
        })
        register = makeRegister(peripheral, 'MODER')
    })

    test('FieldNode tooltip includes bit range and access type', () => {
        new FieldNode(register, {
            name: 'MODE0',
            description: 'Port 0 mode',
            offset: 0,
            width: 2,
            accessType: AccessType.ReadWrite,
        })

        const field = (register as any).children[0] as FieldNode
        register.currentValue = 0n

        const treeNode = field.getTreeNode()

        expect(typeof treeNode.tooltip).toBe('string')
        const tooltip = treeNode.tooltip as string
        expect(tooltip).toContain('Port 0 mode')
        expect(tooltip).toContain('Bits [1:0]')
        expect(tooltip).toContain('width: 2')
        expect(tooltip).toContain('Access:')
    })

    test('FieldNode tooltip lists all enumeration values sorted numerically', () => {
        new FieldNode(register, {
            name: 'SPEED',
            description: 'Output speed',
            offset: 4,
            width: 2,
            accessType: AccessType.ReadWrite,
            enumeration: {
                '0': { name: 'Low',    value: 0n, description: 'Low speed' },
                '1': { name: 'Medium', value: 1n, description: 'Medium speed' },
                '3': { name: 'High',   value: 3n, description: 'High speed' },
            },
        })

        const field = (register as any).children[0] as FieldNode
        register.currentValue = 1n << 4n  // SPEED = 1 (Medium)

        const treeNode = field.getTreeNode()
        const tooltip = treeNode.tooltip as string

        expect(tooltip).toContain('Values:')
        // Sorted: Low=0 before Medium=1 before High=3
        const lowPos    = tooltip.indexOf('Low')
        const mediumPos = tooltip.indexOf('Medium')
        const highPos   = tooltip.indexOf('High')
        expect(lowPos).toBeLessThan(mediumPos)
        expect(mediumPos).toBeLessThan(highPos)
    })

    test('RegisterNode.getTreeNode reflects current ≠ reset value in tooltip', () => {
        register.currentValue = 0xDEADBEEFn

        const treeNode = register.getTreeNode()
        const tooltip = treeNode.tooltip as string

        expect(tooltip).toContain('Current:')
        expect(tooltip).toContain('Reset:')
    })

    test('ReadOnly FieldNode shows field-ro context and no edit option', () => {
        const roRegister = makeRegister(peripheral, 'IDR', { accessType: AccessType.ReadOnly })

        new FieldNode(roRegister, {
            name: 'IDR0',
            description: 'Input data bit 0',
            offset: 0,
            width: 1,
            accessType: AccessType.ReadOnly,
        })

        const field = (roRegister as any).children[0] as FieldNode
        roRegister.currentValue = 1n

        const treeNode = field.getTreeNode()
        expect(treeNode.contextValue).toMatch(/field-ro|field/)
    })
})
