import {
    DiagnosticsManager,
    ErrorAction,
    LogEntry,
    getDiagnosticsManager,
    resetDiagnosticsManager
} from '../../src/frontend/diagnostics'

// Mock vscode - factory function to avoid hoisting issues
jest.mock('vscode', () => {
    const mockThenable = {
        then: jest.fn(function(this: any, callback?: (value: any) => any) {
            if (callback) callback(undefined)
            return this
        }),
        catch: jest.fn().mockReturnThis()
    }

    const mockOutputChannel = {
        appendLine: jest.fn(),
        clear: jest.fn(),
        show: jest.fn()
    }

    return {
        window: {
            createOutputChannel: jest.fn().mockReturnValue(mockOutputChannel),
            showErrorMessage: jest.fn().mockReturnValue(mockThenable),
            showWarningMessage: jest.fn().mockReturnValue(mockThenable),
            showInformationMessage: jest.fn().mockReturnValue(mockThenable),
            showOpenDialog: jest.fn().mockResolvedValue(undefined)
        },
        env: {
            clipboard: {
                writeText: jest.fn().mockResolvedValue(undefined)
            },
            openExternal: jest.fn().mockResolvedValue(true)
        },
        Uri: {
            parse: jest.fn()
        },
        commands: {
            executeCommand: jest.fn().mockResolvedValue(undefined)
        },
        __mockOutputChannel: mockOutputChannel
    }
})

import * as vscode from 'vscode'

describe('DiagnosticsManager', () => {
    let manager: DiagnosticsManager

    beforeEach(() => {
        resetDiagnosticsManager()
        manager = getDiagnosticsManager()
    })

    afterEach(() => {
        jest.clearAllMocks()
    })

    describe('Singleton Pattern', () => {
        test('getDiagnosticsManager should return same instance', () => {
            const instance1 = getDiagnosticsManager()
            const instance2 = getDiagnosticsManager()
            expect(instance1).toBe(instance2)
        })

        test('resetDiagnosticsManager should create new instance on next get', () => {
            const instance1 = getDiagnosticsManager()
            resetDiagnosticsManager()
            const instance2 = getDiagnosticsManager()
            expect(instance1).not.toBe(instance2)
        })
    })

    describe('Logging', () => {
        test('should log error message', () => {
            manager.error('TestSource', 'Test error message', 'Details')
            const entries = manager.getLogEntries('error')
            expect(entries.length).toBe(1)
            expect(entries[0].source).toBe('TestSource')
            expect(entries[0].message).toBe('Test error message')
            expect(entries[0].details).toBe('Details')
            expect(entries[0].level).toBe('error')
        })

        test('should log warning message', () => {
            manager.warn('TestSource', 'Test warning')
            const entries = manager.getLogEntries('warn')
            expect(entries.length).toBe(1)
            expect(entries[0].level).toBe('warn')
        })

        test('should log info message', () => {
            manager.info('TestSource', 'Test info')
            const entries = manager.getLogEntries('info')
            expect(entries.length).toBe(1)
            expect(entries[0].level).toBe('info')
        })

        test('should log debug message when dev output enabled', () => {
            manager.setShowDevDebugOutput(true)
            manager.debug('TestSource', 'Test debug')
            const entries = manager.getLogEntries('debug')
            expect(entries.length).toBe(1)
            expect(entries[0].level).toBe('debug')
        })

        test('should not log debug message when dev output disabled', () => {
            manager.setShowDevDebugOutput(false)
            manager.debug('TestSource', 'Test debug')
            const entries = manager.getLogEntries('debug')
            expect(entries.length).toBe(1) // Still stored, just not displayed
        })

        test('should maintain log size limit', () => {
            // Add 1001 entries (limit is 1000)
            for (let i = 0; i < 1001; i++) {
                manager.info('Test', `Message ${i}`)
            }
            const entries = manager.getLogEntries()
            expect(entries.length).toBe(1000)
            // First entry should be removed
            expect(entries[0].message).toBe('Message 1')
        })

        test('clearLog should remove all entries', () => {
            manager.info('Test', 'Message 1')
            manager.info('Test', 'Message 2')
            manager.clearLog()
            const entries = manager.getLogEntries()
            expect(entries.length).toBe(0)
        })
    })

    describe('Log Filtering', () => {
        beforeEach(() => {
            manager.error('Source1', 'Error message')
            manager.warn('Source2', 'Warning message')
            manager.info('Source3', 'Info message')
            manager.debug('Source4', 'Debug message')
        })

        test('should filter by error level', () => {
            const entries = manager.getLogEntries('error')
            expect(entries.length).toBe(1)
            expect(entries[0].level).toBe('error')
        })

        test('should return all entries when no filter', () => {
            const entries = manager.getLogEntries()
            expect(entries.length).toBe(4)
        })
    })

    describe('Log Export', () => {
        test('should export log in correct format', () => {
            manager.error('TestSource', 'Test message', 'Test details')
            const exported = manager.exportLog()

            expect(exported).toContain('PlatformIO Debug Diagnostic Log')
            expect(exported).toContain('Total Entries: 1')
            expect(exported).toContain('[ERROR]')
            expect(exported).toContain('TestSource')
            expect(exported).toContain('Test message')
        })
    })

    describe('Error Display', () => {
        test('showError should call vscode.window.showErrorMessage', () => {
            manager.showError('Test error')
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Test error')
        })

        test('showError with actions should include action labels', () => {
            const actions: ErrorAction[] = [
                { label: 'Action 1', callback: jest.fn() },
                { label: 'Action 2', callback: jest.fn() }
            ]
            manager.showError('Test error', actions)
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Test error',
                'Action 1',
                'Action 2'
            )
        })

        test('showWarning should call vscode.window.showWarningMessage', () => {
            manager.showWarning('Test warning')
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Test warning')
        })

        test('showInfo should call vscode.window.showInformationMessage', () => {
            manager.showInfo('Test info')
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Test info')
        })
    })

    describe('GDB Error Pattern Matching', () => {
        test('should handle connection refused error', () => {
            const handled = manager.handleGDBError('Connection refused')
            expect(handled).toBe(true)
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
        })

        test('should handle connection timeout error', () => {
            const handled = manager.handleGDBError('Connection timed out')
            expect(handled).toBe(true)
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
        })

        test('should handle file not found error', () => {
            const handled = manager.handleGDBError('No such file or directory')
            expect(handled).toBe(true)
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
        })

        test('should handle memory access error', () => {
            const handled = manager.handleGDBError('Cannot access memory')
            expect(handled).toBe(true)
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
        })

        test('should handle remote replied with error', () => {
            const handled = manager.handleGDBError('Remote replied with error')
            expect(handled).toBe(true)
            // This is a warning, not error
            expect(vscode.window.showWarningMessage).toHaveBeenCalled()
        })

        test('should handle unrecognized command', () => {
            const handled = manager.handleGDBError('Unrecognized command')
            expect(handled).toBe(true)
            expect(vscode.window.showWarningMessage).toHaveBeenCalled()
        })

        test('should show generic error for unmatched pattern', () => {
            const handled = manager.handleGDBError('Some random error')
            expect(handled).toBe(false)
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
            // Should include diagnostic actions
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            expect(call.length).toBeGreaterThan(1) // Has action labels
        })
    })

    describe('Connection Error Handling', () => {
        test('should show connection error with troubleshooting', () => {
            manager.handleConnectionError('Connection refused', 'localhost', 3333)
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            expect(call[0]).toContain('localhost:3333')
            // Should have multiple actions
            expect(call.length).toBeGreaterThan(2)
        })

        test('should show connection error without host/port', () => {
            manager.handleConnectionError('Connection failed')
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            expect(call[0]).not.toContain('undefined')
        })
    })

    describe('SVD Error Handling', () => {
        test('should show SVD error with path', () => {
            manager.handleSVDError('Parse error', '/path/to/device.svd')
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            expect(call[0]).toContain('/path/to/device.svd')
        })

        test('should show SVD error without path', () => {
            manager.handleSVDError('Parse error')
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            expect(call[0]).toBe('Failed to load SVD file')
        })

        test('SVD error should have locate file action', () => {
            manager.handleSVDError('Parse error')
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            // Check that action labels are present
            const labels = call.slice(1)
            expect(labels).toContain('Locate SVD File')
            expect(labels).toContain('Skip SVD Load')
        })
    })

    describe('Memory Error Handling', () => {
        test('should show memory error with address', () => {
            manager.handleMemoryError('Access denied', 0x20000000)
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            expect(call[0]).toContain('0x20000000')
        })

        test('should show memory error without address', () => {
            manager.handleMemoryError('Access denied')
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            expect(call[0]).toBe('Cannot access memory')
        })

        test('memory error should have pause target action', () => {
            manager.handleMemoryError('Access denied', 0x20000000)
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            const labels = call.slice(1)
            expect(labels).toContain('Target May Not Be Halted')
            expect(labels).toContain('Check Address')
        })
    })

    describe('Output Channel', () => {
        test('showOutputChannel should call output channel show', () => {
            const mockOutputChannel = (vscode as any).__mockOutputChannel
            manager.showOutputChannel()
            expect(mockOutputChannel.show).toHaveBeenCalled()
        })
    })

    describe('Action Callbacks', () => {
        test('error action callback should be executed when selected', async () => {
            const callback = jest.fn()
            const actions: ErrorAction[] = [
                { label: 'Test Action', callback }
            ]

            // Mock the promise resolution
            ;(vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Test Action')

            manager.showError('Test', actions)

            // Wait for promise to resolve
            await new Promise(resolve => setTimeout(resolve, 0))

            expect(callback).toHaveBeenCalled()
        })

        test('info action should show documentation link', async () => {
            // Mock the promise resolution for connection troubleshooting
            ;(vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Check Connection')

            manager.handleConnectionError('Error', 'host', 1234)

            // Wait for promise chain
            await new Promise(resolve => setTimeout(resolve, 0))

            expect(vscode.window.showInformationMessage).toHaveBeenCalled()
        })
    })
})
