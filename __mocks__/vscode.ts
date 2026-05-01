/**
 * Mock for vscode module used in tests
 */

const mockOutputChannel = {
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
    replace: jest.fn()
}

const mockClipboard = {
    writeText: jest.fn().mockResolvedValue(undefined),
    readText: jest.fn().mockResolvedValue('')
}

const mockUri = {
    parse: jest.fn((uri: string) => ({ fsPath: uri, toString: () => uri })),
    file: jest.fn((path: string) => ({ fsPath: path, toString: () => `file://${path}` }))
}

// Helper to create a proper Thenable mock backed by a real Promise so that
// callers get standard async scheduling, chaining and error semantics.
const createMockThenable = (resolvedValue?: any): Promise<any> => {
    return Promise.resolve(resolvedValue)
}

export const window = {
    createOutputChannel: jest.fn().mockReturnValue(mockOutputChannel),
    showErrorMessage: jest.fn().mockImplementation(() => createMockThenable(undefined)),
    showWarningMessage: jest.fn().mockImplementation(() => createMockThenable(undefined)),
    showInformationMessage: jest.fn().mockImplementation(() => createMockThenable(undefined)),
    showOpenDialog: jest.fn().mockImplementation(() => Promise.resolve(undefined)),
    showQuickPick: jest.fn().mockImplementation(() => Promise.resolve(undefined)),
    showInputBox: jest.fn().mockImplementation(() => Promise.resolve(undefined)),
    activeTextEditor: undefined,
    visibleTextEditors: [],
    onDidChangeActiveTextEditor: jest.fn().mockReturnValue({ dispose: jest.fn() })
}

export const env = {
    clipboard: mockClipboard,
    openExternal: jest.fn().mockResolvedValue(true),
    appName: 'vscode-test',
    appRoot: '/test',
    appHost: 'desktop',
    uiKind: 1
}

export const Uri = mockUri

export const commands = {
    executeCommand: jest.fn().mockResolvedValue(undefined),
    registerCommand: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    getCommands: jest.fn().mockResolvedValue([])
}

export const debug = {
    activeDebugSession: undefined,
    onDidChangeActiveDebugSession: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    onDidStartDebugSession: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    onDidTerminateDebugSession: jest.fn().mockReturnValue({ dispose: jest.fn() })
}

export const workspace = {
    workspaceFolders: undefined,
    onDidChangeWorkspaceFolders: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    getConfiguration: jest.fn().mockReturnValue({
        get: jest.fn(),
        has: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined)
    }),
    registerTextDocumentContentProvider: jest.fn().mockReturnValue({ dispose: jest.fn() })
}

export const EventEmitter = jest.fn().mockImplementation(() => ({
    event: jest.fn(),
    fire: jest.fn(),
    dispose: jest.fn()
}))

export const TreeItemCollapsibleState = {
    None: 0,
    Collapsed: 1,
    Expanded: 2
}

export const OverviewRulerLane = {
    Left: 1,
    Center: 2,
    Right: 4,
    Full: 7
}

export const Position = jest.fn().mockImplementation((line: number, character: number) => ({
    line,
    character,
    compareTo: jest.fn(),
    isAfter: jest.fn(),
    isAfterOrEqual: jest.fn(),
    isBefore: jest.fn(),
    isBeforeOrEqual: jest.fn(),
    isEqual: jest.fn(),
    translate: jest.fn(),
    with: jest.fn()
}))

export const Range = jest.fn().mockImplementation((startLine: number, startChar: number, endLine: number, endChar: number) => ({
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
    isEmpty: jest.fn(),
    isSingleLine: jest.fn(),
    contains: jest.fn(),
    intersection: jest.fn(),
    union: jest.fn(),
    with: jest.fn()
}))

// Default export
export default {
    window,
    env,
    Uri,
    commands,
    debug,
    workspace,
    EventEmitter,
    TreeItemCollapsibleState,
    OverviewRulerLane,
    Position,
    Range
}
