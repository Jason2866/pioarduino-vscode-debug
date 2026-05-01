/**
 * Tests for memory write operations.
 */

import { MemoryContentProvider } from '../../src/frontend/memory_content_provider'

// Mock vscode with controllable debug session
const mockCustomRequest = jest.fn()
let hasActiveDebugSession = false

jest.mock('vscode', () => ({
    window: {
        createTextEditorDecorationType: jest.fn().mockReturnValue({
            dispose: jest.fn()
        }),
        showErrorMessage: jest.fn().mockResolvedValue(undefined),
        showInformationMessage: jest.fn().mockResolvedValue(undefined)
    },
    debug: {
        get activeDebugSession() {
            return hasActiveDebugSession ? {
                customRequest: mockCustomRequest
            } : undefined
        }
    },
    EventEmitter: jest.fn().mockImplementation(() => ({
        event: jest.fn(),
        fire: jest.fn()
    })),
    Position: jest.fn().mockImplementation((line: number, character: number) => ({
        line,
        character
    })),
    Range: jest.fn(),
    OverviewRulerLane: {
        Right: 4
    },
    Uri: {
        parse: jest.fn()
    },
    workspace: {
        textDocuments: []
    }
}))

describe('Memory Write Operations', () => {
    let provider: MemoryContentProvider

    beforeEach(() => {
        provider = new MemoryContentProvider()
        hasActiveDebugSession = true
        mockCustomRequest.mockClear()
    })

    afterEach(() => {
        hasActiveDebugSession = false
    })

    describe('writeByte', () => {
        test('should write single byte successfully', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            const success = await provider.writeByte(0x20000000, 0xAB)

            expect(success).toBe(true)
            expect(mockCustomRequest).toHaveBeenCalledWith('write-memory', {
                address: 0x20000000,
                data: 'ab'
            })
        })

        test('should write byte 0x00', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            const success = await provider.writeByte(0x20000000, 0x00)

            expect(success).toBe(true)
            expect(mockCustomRequest).toHaveBeenCalledWith('write-memory', {
                address: 0x20000000,
                data: '00'
            })
        })

        test('should write byte 0xFF', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            const success = await provider.writeByte(0x20000000, 0xFF)

            expect(success).toBe(true)
            expect(mockCustomRequest).toHaveBeenCalledWith('write-memory', {
                address: 0x20000000,
                data: 'ff'
            })
        })

        test('should reject value > 0xFF with an error', async () => {
            const success = await provider.writeByte(0x20000000, 0x1AB)

            expect(success).toBe(false)
            expect(mockCustomRequest).not.toHaveBeenCalled()
        })

        test('should return false when no debug session', async () => {
            hasActiveDebugSession = false

            const success = await provider.writeByte(0x20000000, 0xAB)

            expect(success).toBe(false)
            expect(mockCustomRequest).not.toHaveBeenCalled()
        })

        test('should return false on write error', async () => {
            mockCustomRequest.mockRejectedValue(new Error('Memory access denied'))

            const success = await provider.writeByte(0x20000000, 0xAB)

            expect(success).toBe(false)
        })

        test('should write to different addresses', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            // Test various addresses
            const addresses = [
                0x00000000,
                0x20000000,
                0x40000000,
                0x08000000,
                0xFFFFFFFF
            ]

            for (const address of addresses) {
                mockCustomRequest.mockClear()
                const success = await provider.writeByte(address, 0x42)
                expect(success).toBe(true)
                expect(mockCustomRequest).toHaveBeenCalledWith('write-memory', {
                    address,
                    data: '42'
                })
            }
        })
    })

    describe('writeBytes', () => {
        test('should write multiple bytes successfully', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            const success = await provider.writeBytes(0x20000000, [0x12, 0x34, 0x56, 0x78])

            expect(success).toBe(true)
            expect(mockCustomRequest).toHaveBeenCalledWith('write-memory', {
                address: 0x20000000,
                data: '12345678'
            })
        })

        test('should write single byte array', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            const success = await provider.writeBytes(0x20000000, [0xAB])

            expect(success).toBe(true)
            expect(mockCustomRequest).toHaveBeenCalledWith('write-memory', {
                address: 0x20000000,
                data: 'ab'
            })
        })

        test('should write empty array', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            const success = await provider.writeBytes(0x20000000, [])

            expect(success).toBe(true)
            expect(mockCustomRequest).toHaveBeenCalledWith('write-memory', {
                address: 0x20000000,
                data: ''
            })
        })

        test('should reject array containing values > 0xFF with an error', async () => {
            const success = await provider.writeBytes(0x20000000, [0x1FF, 0x2AB, 0x3CD])

            expect(success).toBe(false)
            expect(mockCustomRequest).not.toHaveBeenCalled()
        })

        test('should return false when no debug session', async () => {
            hasActiveDebugSession = false

            const success = await provider.writeBytes(0x20000000, [0x12, 0x34])

            expect(success).toBe(false)
            expect(mockCustomRequest).not.toHaveBeenCalled()
        })

        test('should return false on write error', async () => {
            mockCustomRequest.mockRejectedValue(new Error('Target not halted'))

            const success = await provider.writeBytes(0x20000000, [0x12, 0x34])

            expect(success).toBe(false)
        })

        test('should write large byte arrays', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            const largeArray = new Array(256).fill(0).map((_, i) => i)
            const success = await provider.writeBytes(0x20000000, largeArray)

            expect(success).toBe(true)
            expect(mockCustomRequest).toHaveBeenCalledWith('write-memory', {
                address: 0x20000000,
                data: largeArray.map(v => v.toString(16).padStart(2, '0')).join('')
            })
        })
    })

    describe('Hex Formatting', () => {
        test('should format bytes as lowercase hex', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            await provider.writeByte(0x20000000, 0xAB)

            const callArgs = mockCustomRequest.mock.calls[0]
            expect(callArgs[1].data).toBe('ab')
        })

        test('should pad single hex digit with zero', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            await provider.writeByte(0x20000000, 0x5)

            const callArgs = mockCustomRequest.mock.calls[0]
            expect(callArgs[1].data).toBe('05')
        })

        test('should handle 0x00 correctly', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            await provider.writeByte(0x20000000, 0x00)

            const callArgs = mockCustomRequest.mock.calls[0]
            expect(callArgs[1].data).toBe('00')
        })

        test('should handle 0xFF correctly', async () => {
            mockCustomRequest.mockResolvedValue({ success: true })

            await provider.writeByte(0x20000000, 0xFF)

            const callArgs = mockCustomRequest.mock.calls[0]
            expect(callArgs[1].data).toBe('ff')
        })
    })
})
