import * as vscode from 'vscode'

/**
 * Represents an action that can be taken when an error occurs.
 */
export interface ErrorAction {
    label: string
    callback: () => void
}

/**
 * Log entry for diagnostic output.
 */
export interface LogEntry {
    timestamp: Date
    level: 'debug' | 'info' | 'warn' | 'error'
    source: string
    message: string
    details?: string
}

/**
 * Error patterns for common GDB/MI errors with suggested actions.
 */
interface ErrorPattern {
    pattern: RegExp
    message: string
    actions: ErrorAction[]
    severity: 'error' | 'warning'
}

/**
 * Centralized diagnostics and error handling for the debug extension.
 * Provides structured error messages, logging, and actionable error recovery.
 */
export class DiagnosticsManager {
    private outputChannel: vscode.OutputChannel
    private logEntries: LogEntry[] = []
    private maxLogEntries: number = 1000
    private errorPatterns: ErrorPattern[] = []
    private showDevDebugOutput: boolean = false

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('PlatformIO Debug Diagnostics')
        this.initializeErrorPatterns()
    }

    /**
     * Sets whether to show detailed debug output.
     */
    setShowDevDebugOutput(enabled: boolean): void {
        this.showDevDebugOutput = enabled
    }

    /**
     * Logs a message to the diagnostic output.
     */
    log(level: LogEntry['level'], source: string, message: string, details?: string): void {
        const entry: LogEntry = {
            timestamp: new Date(),
            level,
            source,
            message,
            details
        }

        this.logEntries.push(entry)

        // Maintain log size limit
        if (this.logEntries.length > this.maxLogEntries) {
            this.logEntries.shift()
        }

        // Always log errors and warnings, only log debug if enabled
        if (level === 'error' || level === 'warn' || this.showDevDebugOutput) {
            const timestamp = entry.timestamp.toISOString().split('T')[1].split('.')[0]
            const logLine = `[${timestamp}] [${level.toUpperCase()}] [${source}] ${message}`
            this.outputChannel.appendLine(logLine)
            if (details && this.showDevDebugOutput) {
                this.outputChannel.appendLine(`  Details: ${details}`)
            }
        }
    }

    /**
     * Logs a debug message.
     */
    debug(source: string, message: string, details?: string): void {
        this.log('debug', source, message, details)
    }

    /**
     * Logs an informational message.
     */
    info(source: string, message: string, details?: string): void {
        this.log('info', source, message, details)
    }

    /**
     * Logs a warning message.
     */
    warn(source: string, message: string, details?: string): void {
        this.log('warn', source, message, details)
    }

    /**
     * Logs an error message.
     */
    error(source: string, message: string, details?: string): void {
        this.log('error', source, message, details)
    }

    /**
     * Shows the diagnostic output channel.
     */
    showOutputChannel(): void {
        this.outputChannel.show()
    }

    /**
     * Clears the diagnostic log.
     */
    clearLog(): void {
        this.logEntries = []
        this.outputChannel.clear()
    }

    /**
     * Gets all log entries, optionally filtered by level.
     */
    getLogEntries(level?: LogEntry['level']): LogEntry[] {
        if (level) {
            return this.logEntries.filter(entry => entry.level === level)
        }
        return [...this.logEntries]
    }

    /**
     * Exports the diagnostic log to a string for bug reports.
     */
    exportLog(): string {
        const lines: string[] = [
            'PlatformIO Debug Diagnostic Log',
            `Generated: ${new Date().toISOString()}`,
            `Total Entries: ${this.logEntries.length}`,
            '---'
        ]

        for (const entry of this.logEntries) {
            const timestamp = entry.timestamp.toISOString()
            lines.push(`[${timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`)
            if (entry.details) {
                lines.push(`  Details: ${entry.details}`)
            }
        }

        return lines.join('\n')
    }

    /**
     * Shows an error message with optional actions.
     */
    showError(message: string, actions?: ErrorAction[]): void {
        this.error('DiagnosticsManager', `Showing error: ${message}`)

        if (actions && actions.length > 0) {
            const actionLabels = actions.map(a => a.label)
            vscode.window.showErrorMessage(message, ...actionLabels)
                .then(selected => {
                    if (selected) {
                        const action = actions.find(a => a.label === selected)
                        if (action) {
                            this.info('DiagnosticsManager', `Executing action: ${action.label}`)
                            action.callback()
                        }
                    }
                })
        } else {
            vscode.window.showErrorMessage(message)
        }
    }

    /**
     * Shows a warning message with optional actions.
     */
    showWarning(message: string, actions?: ErrorAction[]): void {
        this.warn('DiagnosticsManager', `Showing warning: ${message}`)

        if (actions && actions.length > 0) {
            const actionLabels = actions.map(a => a.label)
            vscode.window.showWarningMessage(message, ...actionLabels)
                .then(selected => {
                    if (selected) {
                        const action = actions.find(a => a.label === selected)
                        if (action) {
                            action.callback()
                        }
                    }
                })
        } else {
            vscode.window.showWarningMessage(message)
        }
    }

    /**
     * Shows an informational message with optional actions.
     */
    showInfo(message: string, actions?: ErrorAction[]): void {
        this.info('DiagnosticsManager', `Showing info: ${message}`)

        if (actions && actions.length > 0) {
            const actionLabels = actions.map(a => a.label)
            vscode.window.showInformationMessage(message, ...actionLabels)
                .then(selected => {
                    if (selected) {
                        const action = actions.find(a => a.label === selected)
                        if (action) {
                            action.callback()
                        }
                    }
                })
        } else {
            vscode.window.showInformationMessage(message)
        }
    }

    /**
     * Handles a GDB/MI error by matching against known patterns.
     * Returns true if the error was handled by a pattern, false otherwise.
     */
    handleGDBError(errorMessage: string): boolean {
        this.error('GDB', 'Error received', errorMessage)

        for (const pattern of this.errorPatterns) {
            if (pattern.pattern.test(errorMessage)) {
                this.info('DiagnosticsManager', `Matched error pattern: ${pattern.message}`)

                if (pattern.severity === 'error') {
                    this.showError(pattern.message, pattern.actions)
                } else {
                    this.showWarning(pattern.message, pattern.actions)
                }
                return true
            }
        }

        // No pattern matched, show generic error
        this.showError(`Debug error: ${errorMessage}`, [
            {
                label: 'Show Diagnostics',
                callback: () => this.showOutputChannel()
            },
            {
                label: 'Copy Error',
                callback: () => {
                    vscode.env.clipboard.writeText(errorMessage)
                    this.showInfo('Error message copied to clipboard')
                }
            }
        ])

        return false
    }

    /**
     * Handles connection errors with specific troubleshooting steps.
     */
    handleConnectionError(error: string, host?: string, port?: number): void {
        this.error('Connection', `Connection error to ${host}:${port}`, error)

        this.showError(
            `Failed to connect to debug server${host && port ? ` at ${host}:${port}` : ''}.`,
            [
                {
                    label: 'Check Connection',
                    callback: () => {
                        this.showInfo(
                            'Troubleshooting:\n' +
                            '1. Verify target device is connected\n' +
                            '2. Check OpenOCD/GDB server is running\n' +
                            '3. Verify port and host settings\n' +
                            '4. Check firewall settings'
                        )
                    }
                },
                {
                    label: 'Restart Debug',
                    callback: () => {
                        vscode.commands.executeCommand('workbench.action.debug.restart')
                    }
                },
                {
                    label: 'Show Diagnostics',
                    callback: () => this.showOutputChannel()
                }
            ]
        )
    }

    /**
     * Handles SVD file loading errors.
     */
    handleSVDError(error: string, svdPath?: string): void {
        this.error('SVD', `SVD file error${svdPath ? ` for ${svdPath}` : ''}`, error)

        const message = svdPath
            ? `Failed to load SVD file: ${svdPath}`
            : 'Failed to load SVD file'

        this.showError(message, [
            {
                label: 'Locate SVD File',
                callback: () => {
                    vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        filters: {
                            'SVD Files': ['svd'],
                            'All Files': ['*']
                        }
                    }).then(uri => {
                        if (uri && uri[0]) {
                            // Notify extension to reload with new SVD path
                            vscode.commands.executeCommand('platformio-debug.reloadSVD', uri[0].fsPath)
                        }
                    })
                }
            },
            {
                label: 'Skip SVD Load',
                callback: () => {
                    this.showInfo('SVD loading skipped. Peripheral view will not be available.')
                }
            }
        ])
    }

    /**
     * Handles memory access errors.
     */
    handleMemoryError(error: string, address?: number): void {
        this.error('Memory', `Memory access error${address !== undefined ? ` at 0x${address.toString(16)}` : ''}`, error)

        const message = address !== undefined
            ? `Cannot access memory at address 0x${address.toString(16)}`
            : 'Cannot access memory'

        this.showError(message, [
            {
                label: 'Target May Not Be Halted',
                callback: () => {
                    this.showInfo(
                        'To access memory, the target must be halted.\n' +
                        'Try pausing execution first (F6) or setting a breakpoint.'
                    )
                }
            },
            {
                label: 'Check Address',
                callback: () => {
                    this.showInfo(
                        'Verify the memory address is valid:\n' +
                        '1. Check device memory map\n' +
                        '2. Verify address is accessible\n' +
                        '3. Check if region requires special permissions'
                    )
                }
            }
        ])
    }

    /**
     * Initializes the error pattern matchers.
     */
    private initializeErrorPatterns(): void {
        this.errorPatterns = [
            {
                pattern: /connection\s+(refused|failed|timed\s+out)/i,
                message: 'Debug server connection failed. The target may not be connected.',
                severity: 'error',
                actions: [
                    {
                        label: 'Check Connection',
                        callback: () => this.showConnectionTroubleshooting()
                    },
                    {
                        label: 'Retry',
                        callback: () => vscode.commands.executeCommand('workbench.action.debug.restart')
                    }
                ]
            },
            {
                pattern: /no\s+such\s+file\s+or\s+directory/i,
                message: 'Required file not found. Check your project configuration.',
                severity: 'error',
                actions: [
                    {
                        label: 'Open Settings',
                        callback: () => vscode.commands.executeCommand('workbench.action.openSettings', 'platformio')
                    }
                ]
            },
            {
                pattern: /cannot\s+access\s+memory/i,
                message: 'Cannot access target memory. The target may not be halted.',
                severity: 'error',
                actions: [
                    {
                        label: 'Pause Target',
                        callback: () => vscode.commands.executeCommand('workbench.action.debug.pause')
                    },
                    {
                        label: 'Set Breakpoint',
                        callback: () => vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint')
                    }
                ]
            },
            {
                pattern: /remote\s+replied\s+with\s+error/i,
                message: 'GDB server protocol error. There may be a version mismatch.',
                severity: 'warning',
                actions: [
                    {
                        label: 'Show Diagnostics',
                        callback: () => this.showOutputChannel()
                    }
                ]
            },
            {
                pattern: /unrecognized\s+command/i,
                message: 'Unrecognized GDB command. Check GDB server compatibility.',
                severity: 'warning',
                actions: [
                    {
                        label: 'Check GDB Version',
                        callback: () => this.showInfo('Ensure GDB version is compatible with your target.')
                    }
                ]
            }
        ]
    }

    /**
     * Shows connection troubleshooting information.
     */
    private showConnectionTroubleshooting(): void {
        this.showInfo(
            'Connection Troubleshooting:\n\n' +
            '1. Verify target device is connected via USB/JTAG\n' +
            '2. Check OpenOCD or GDB server is running\n' +
            '3. Verify port settings in launch.json\n' +
            '4. Check for driver issues (Zadig for Windows)\n' +
            '5. Ensure correct permissions (Linux: udev rules)',
            [
                {
                    label: 'Open Documentation',
                    callback: () => {
                        vscode.env.openExternal(vscode.Uri.parse('https://docs.platformio.org/en/latest/plus/debugging.html'))
                    }
                }
            ]
        )
    }
}

/**
 * Singleton instance of the diagnostics manager.
 */
let diagnosticsManager: DiagnosticsManager | null = null

/**
 * Gets the singleton diagnostics manager instance.
 * Creates the instance on first call.
 */
export function getDiagnosticsManager(): DiagnosticsManager {
    if (!diagnosticsManager) {
        diagnosticsManager = new DiagnosticsManager()
    }
    return diagnosticsManager
}

/**
 * Resets the singleton instance (useful for testing).
 */
export function resetDiagnosticsManager(): void {
    diagnosticsManager = null
}
