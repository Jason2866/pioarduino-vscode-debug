/**
 * Tests for the connection troubleshooting wizard diagnostic flow.
 *
 * Verifies that the domain-specific error handlers produce the right
 * error messages and actionable recovery steps, and that action callbacks
 * trigger the expected VS Code commands.
 */

import { getDiagnosticsManager, resetDiagnosticsManager } from '../../src/frontend/diagnostics'

// Capture the action callbacks passed to showErrorMessage so we can invoke them
let capturedActions: Array<{ label: string; callback: () => void }> = []

jest.mock('vscode', () => {
    // Track the last set of ErrorAction labels that were shown
    const capturedLabels: string[] = []

    return {
        window: {
            createOutputChannel: jest.fn().mockReturnValue({
                appendLine: jest.fn(),
                clear: jest.fn(),
                show: jest.fn(),
            }),
            // Resolve with the first action label to simulate the user clicking it
            showErrorMessage: jest.fn().mockImplementation((_msg: string, ...labels: string[]) => {
                capturedLabels.splice(0, capturedLabels.length, ...labels)
                return Promise.resolve(labels[0])
            }),
            showWarningMessage: jest.fn().mockImplementation((_msg: string, ...labels: string[]) =>
                Promise.resolve(labels[0])
            ),
            showInformationMessage: jest.fn().mockImplementation((_msg: string, ...labels: string[]) =>
                Promise.resolve(labels[0])
            ),
            showOpenDialog: jest.fn().mockResolvedValue([{ fsPath: '/path/to/file.svd' }]),
        },
        env: {
            clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
            openExternal: jest.fn().mockResolvedValue(true),
        },
        Uri: {
            parse: jest.fn((s: string) => ({ toString: () => s })),
        },
        commands: {
            executeCommand: jest.fn().mockResolvedValue(undefined),
        },
    }
})

import * as vscode from 'vscode'

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function getManager() {
    return getDiagnosticsManager()
}

// -------------------------------------------------------------------------
// Test suites
// -------------------------------------------------------------------------

describe('Troubleshooting Wizard — handleConnectionError', () => {
    beforeEach(() => {
        resetDiagnosticsManager()
        jest.clearAllMocks()
        capturedActions = []
    })

    test('shows an error message mentioning the host:port when provided', () => {
        getManager().handleConnectionError('refused', 'localhost', 3333)
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('localhost:3333'),
            expect.any(String),
            expect.any(String),
            expect.any(String)
        )
    })

    test('shows an error message without host:port when omitted', () => {
        getManager().handleConnectionError('refused')
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('debug server'),
            expect.any(String),
            expect.any(String),
            expect.any(String)
        )
    })

    test('offers "Check Connection", "Restart Debug" and "Show Diagnostics" actions', () => {
        getManager().handleConnectionError('timed out', '192.168.1.1', 2331)
        const callArgs = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
        const actionLabels: string[] = callArgs.slice(1)
        expect(actionLabels).toContain('Check Connection')
        expect(actionLabels).toContain('Restart Debug')
        expect(actionLabels).toContain('Show Diagnostics')
    })

    test('"Restart Debug" action triggers workbench.action.debug.restart command', async () => {
        // The mock resolves with the first label; simulate selecting "Restart Debug" by
        // overriding the mock for this specific call.
        ;(vscode.window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Restart Debug')
        getManager().handleConnectionError('refused', 'localhost', 3333)
        // Allow the promise chain to settle
        await Promise.resolve()
        await Promise.resolve()
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.action.debug.restart'
        )
    })

    test('logs the error at "error" level', () => {
        const mgr = getManager()
        mgr.handleConnectionError('refused', 'localhost', 3333)
        const errors = mgr.getLogEntries('error')
        expect(errors.length).toBeGreaterThan(0)
        expect(errors[0].source).toBe('Connection')
    })
})

// -------------------------------------------------------------------------

describe('Troubleshooting Wizard — handleSVDError', () => {
    beforeEach(() => {
        resetDiagnosticsManager()
        jest.clearAllMocks()
    })

    test('includes the SVD path in the error message when provided', () => {
        getManager().handleSVDError('parse failed', '/project/device.svd')
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('device.svd'),
            expect.any(String),
            expect.any(String)
        )
    })

    test('shows a generic message when no path is provided', () => {
        getManager().handleSVDError('not found')
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('SVD file'),
            expect.any(String),
            expect.any(String)
        )
    })

    test('offers "Locate SVD File" and "Skip SVD Load" actions', () => {
        getManager().handleSVDError('invalid', '/bad.svd')
        const callArgs = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
        const actionLabels: string[] = callArgs.slice(1)
        expect(actionLabels).toContain('Locate SVD File')
        expect(actionLabels).toContain('Skip SVD Load')
    })

    test('"Locate SVD File" action opens a file dialog and reloads SVD', async () => {
        ;(vscode.window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Locate SVD File')
        getManager().handleSVDError('bad', '/bad.svd')
        await Promise.resolve()
        await Promise.resolve()
        expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(
            expect.objectContaining({ canSelectFiles: true })
        )
    })

    test('logs the error at "error" level with SVD source', () => {
        const mgr = getManager()
        mgr.handleSVDError('corrupt', '/a.svd')
        const errors = mgr.getLogEntries('error')
        expect(errors.length).toBeGreaterThan(0)
        expect(errors[0].source).toBe('SVD')
    })
})

// -------------------------------------------------------------------------

describe('Troubleshooting Wizard — handleMemoryError', () => {
    beforeEach(() => {
        resetDiagnosticsManager()
        jest.clearAllMocks()
    })

    test('includes the hex address in the message when provided', () => {
        getManager().handleMemoryError('fault', 0x20000000)
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringMatching(/20000000/i),
            expect.any(String),
            expect.any(String)
        )
    })

    test('shows a generic message when address is omitted', () => {
        getManager().handleMemoryError('fault')
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('memory'),
            expect.any(String),
            expect.any(String)
        )
    })

    test('offers "Target May Not Be Halted" and "Check Address" actions', () => {
        getManager().handleMemoryError('access denied', 0x00)
        const callArgs = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
        const actionLabels: string[] = callArgs.slice(1)
        expect(actionLabels).toContain('Target May Not Be Halted')
        expect(actionLabels).toContain('Check Address')
    })

    test('logs the error at "error" level with Memory source', () => {
        const mgr = getManager()
        mgr.handleMemoryError('bus error', 0x40000000)
        const errors = mgr.getLogEntries('error')
        expect(errors.length).toBeGreaterThan(0)
        expect(errors[0].source).toBe('Memory')
    })
})

// -------------------------------------------------------------------------

describe('Troubleshooting Wizard — handleGDBError generic fallback', () => {
    beforeEach(() => {
        resetDiagnosticsManager()
        jest.clearAllMocks()
    })

    test('returns false and offers "Show Diagnostics" and "Copy Error" for unknown errors', () => {
        const handled = getManager().handleGDBError('some unknown gdb error xyz')
        expect(handled).toBe(false)
        const callArgs = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
        const actionLabels: string[] = callArgs.slice(1)
        expect(actionLabels).toContain('Show Diagnostics')
        expect(actionLabels).toContain('Copy Error')
    })

    test('"Copy Error" action copies the error message to the clipboard', async () => {
        ;(vscode.window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Copy Error')
        getManager().handleGDBError('unknown fatal error')
        await Promise.resolve()
        await Promise.resolve()
        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
            expect.stringContaining('unknown fatal error')
        )
    })

    test('"Show Diagnostics" action opens the output channel', async () => {
        ;(vscode.window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Show Diagnostics')
        // Create the manager first so createOutputChannel has been called
        const mgr = getManager()
        const mockChannel = (vscode.window.createOutputChannel as jest.Mock).mock.results[0].value
        mgr.handleGDBError('unknown error')
        await Promise.resolve()
        await Promise.resolve()
        expect(mockChannel.show).toHaveBeenCalled()
    })
})

// -------------------------------------------------------------------------

describe('Troubleshooting Wizard — exportLog', () => {
    beforeEach(() => {
        resetDiagnosticsManager()
    })

    test('exported log contains all logged entries', () => {
        const mgr = getManager()
        mgr.error('SrcA', 'msg1')
        mgr.warn('SrcB', 'msg2')
        mgr.info('SrcC', 'msg3')
        const log = mgr.exportLog()
        expect(log).toContain('msg1')
        expect(log).toContain('msg2')
        expect(log).toContain('msg3')
    })

    test('exported log contains a header with entry count', () => {
        const mgr = getManager()
        mgr.error('S', 'e1')
        mgr.error('S', 'e2')
        const log = mgr.exportLog()
        expect(log).toContain('Total Entries: 2')
    })
})
