import { getDiagnosticsManager, resetDiagnosticsManager } from '../../src/frontend/diagnostics'

// Mock vscode - factory function to avoid hoisting issues
jest.mock('vscode', () => {
    const mockThenable = {
        then: jest.fn(function(this: any, callback?: (value: any) => any) {
            if (callback) callback(undefined)
            return this
        }),
        catch: jest.fn().mockReturnThis()
    }

    return {
        window: {
            createOutputChannel: jest.fn().mockReturnValue({
                appendLine: jest.fn(),
                clear: jest.fn(),
                show: jest.fn()
            }),
            showErrorMessage: jest.fn().mockReturnValue(mockThenable),
            showWarningMessage: jest.fn().mockReturnValue(mockThenable),
            showInformationMessage: jest.fn().mockReturnValue(mockThenable)
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
        }
    }
})

import * as vscode from 'vscode'

describe('Error Pattern Matching', () => {
    let manager: ReturnType<typeof getDiagnosticsManager>

    beforeEach(() => {
        resetDiagnosticsManager()
        manager = getDiagnosticsManager()
        jest.clearAllMocks()
    })

    describe('Connection Errors', () => {
        const connectionErrors = [
            'Connection refused',
            'Connection failed',
            'Connection timed out',
            'connection refused by peer',
            'CONNECTION FAILED'
        ]

        connectionErrors.forEach(error => {
            test(`should match "${error}"`, () => {
                const handled = manager.handleGDBError(error)
                expect(handled).toBe(true)
                expect(vscode.window.showErrorMessage).toHaveBeenCalled()
            })
        })
    })

    describe('File Not Found Errors', () => {
        const fileErrors = [
            'No such file or directory'
        ]

        fileErrors.forEach(error => {
            test(`should match "${error}"`, () => {
                const handled = manager.handleGDBError(error)
                expect(handled).toBe(true)
            })
        })
    })

    describe('Memory Access Errors', () => {
        const memoryErrors = [
            'Cannot access memory',
            'cannot access memory at address 0x20000000'
        ]

        memoryErrors.forEach(error => {
            test(`should match "${error}"`, () => {
                const handled = manager.handleGDBError(error)
                expect(handled).toBe(true)
            })
        })
    })

    describe('Remote Protocol Errors', () => {
        const remoteErrors = [
            'Remote replied with error'
        ]

        remoteErrors.forEach(error => {
            test(`should match "${error}"`, () => {
                const handled = manager.handleGDBError(error)
                expect(handled).toBe(true)
                // These should show as warnings
                expect(vscode.window.showWarningMessage).toHaveBeenCalled()
            })
        })
    })

    describe('Command Errors', () => {
        const commandErrors = [
            'Unrecognized command'
        ]

        commandErrors.forEach(error => {
            test(`should match "${error}"`, () => {
                const handled = manager.handleGDBError(error)
                expect(handled).toBe(true)
            })
        })
    })

    describe('Unmatched Errors', () => {
        const unmatchedErrors = [
            'Something unexpected happened',
            'Random error message',
            'Custom user error'
        ]

        unmatchedErrors.forEach(error => {
            test(`should not match "${error}" and show generic error`, () => {
                const handled = manager.handleGDBError(error)
                expect(handled).toBe(false)
                expect(vscode.window.showErrorMessage).toHaveBeenCalled()
                // Should include actions
                const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
                expect(call.length).toBeGreaterThan(1)
            })
        })
    })

    describe('Error Severity Classification', () => {
        test('connection errors should be classified as error severity', () => {
            manager.handleGDBError('Connection refused')
            expect(vscode.window.showErrorMessage).toHaveBeenCalled()
            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
        })

        test('remote protocol errors should be classified as warning severity', () => {
            manager.handleGDBError('Remote replied with error')
            expect(vscode.window.showWarningMessage).toHaveBeenCalled()
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
        })
    })

    describe('Error Message Content', () => {
        test('should include user-friendly message for connection errors', () => {
            manager.handleGDBError('Connection refused')
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            expect(call[0]).toContain('target')
            expect(call[0]).toContain('connected')
        })

        test('should include user-friendly message for file errors', () => {
            manager.handleGDBError('No such file or directory')
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            expect(call[0]).toContain('configuration')
        })

        test('should include user-friendly message for memory errors', () => {
            manager.handleGDBError('Cannot access memory')
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            expect(call[0]).toContain('halted')
        })
    })

    describe('Action Labels by Error Type', () => {
        test('connection errors should have Check Connection action', () => {
            manager.handleGDBError('Connection refused')
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            const labels = call.slice(1)
            expect(labels).toContain('Check Connection')
        })

        test('memory errors should have Pause Target action', () => {
            manager.handleGDBError('Cannot access memory')
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            const labels = call.slice(1)
            expect(labels).toContain('Pause Target')
        })

        test('connection errors should have Retry action', () => {
            manager.handleGDBError('Connection refused')
            const call = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0]
            const labels = call.slice(1)
            expect(labels).toContain('Retry')
        })
    })

    describe('Case Insensitivity', () => {
        test('should match errors regardless of case', () => {
            const variations = [
                'CONNECTION REFUSED',
                'connection refused',
                'Connection Refused',
                'CoNnEcTiOn ReFuSeD'
            ]

            variations.forEach(error => {
                const handled = manager.handleGDBError(error)
                expect(handled).toBe(true)
                jest.clearAllMocks()
            })
        })
    })
})
