/**
 * Tests for memory data type interpretation and endianness handling.
 * These tests verify that values are correctly read from byte arrays
 * with various data types and endianness settings.
 */

import { MemoryContentProvider, MemoryDataType, Endianness } from '../../src/frontend/memory_content_provider'

// Mock vscode
jest.mock('vscode', () => ({
    window: {
        createTextEditorDecorationType: jest.fn().mockReturnValue({
            dispose: jest.fn()
        }),
        showErrorMessage: jest.fn().mockResolvedValue(undefined),
        showInformationMessage: jest.fn().mockResolvedValue(undefined)
    },
    debug: {
        activeDebugSession: undefined
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

describe('Memory Data Type Interpretation', () => {
    let provider: MemoryContentProvider

    beforeEach(() => {
        provider = new MemoryContentProvider()
    })

    describe('Unsigned Integer Types', () => {
        test('U8: should read single byte value', () => {
            provider.setDataType(MemoryDataType.U8)
            provider.setEndianness(Endianness.Little)

            // Single byte 0xAB = 171
            expect((provider as any).readValue([0xAB], 0, MemoryDataType.U8, Endianness.Little)).toBe(171)
            // Single byte 0x00 = 0
            expect((provider as any).readValue([0x00], 0, MemoryDataType.U8, Endianness.Little)).toBe(0)
            // Single byte 0xFF = 255
            expect((provider as any).readValue([0xFF], 0, MemoryDataType.U8, Endianness.Little)).toBe(255)
        })

        test('U16: should read 16-bit value little endian', () => {
            provider.setDataType(MemoryDataType.U16)
            provider.setEndianness(Endianness.Little)

            // Bytes [0x12, 0x34] in LE = 0x3412 = 13330
            expect((provider as any).readValue([0x12, 0x34], 0, MemoryDataType.U16, Endianness.Little)).toBe(0x3412)

            // Bytes [0x01, 0x00] in LE = 0x0001 = 1
            expect((provider as any).readValue([0x01, 0x00], 0, MemoryDataType.U16, Endianness.Little)).toBe(1)

            // Bytes [0x00, 0xFF] in LE = 0xFF00 = 65280
            expect((provider as any).readValue([0x00, 0xFF], 0, MemoryDataType.U16, Endianness.Little)).toBe(0xFF00)
        })

        test('U16: should read 16-bit value big endian', () => {
            provider.setDataType(MemoryDataType.U16)
            provider.setEndianness(Endianness.Big)

            // 0x1234 in BE: bytes [0x12, 0x34] = 0x1234 = 4660
            expect((provider as any).readValue([0x12, 0x34], 0, MemoryDataType.U16, Endianness.Big)).toBe(0x1234)

            // 0x0100 in BE: bytes [0x01, 0x00] = 0x0100 = 256
            expect((provider as any).readValue([0x01, 0x00], 0, MemoryDataType.U16, Endianness.Big)).toBe(0x0100)
        })

        test('U32: should read 32-bit value little endian', () => {
            provider.setDataType(MemoryDataType.U32)

            // 0x78563412 in LE: bytes [0x12, 0x34, 0x56, 0x78]
            const value = (provider as any).readValue([0x12, 0x34, 0x56, 0x78], 0, MemoryDataType.U32, Endianness.Little)
            expect(value).toBe(0x78563412)
        })

        test('U32: should read 32-bit value big endian', () => {
            provider.setDataType(MemoryDataType.U32)

            // 0x12345678 in BE: bytes [0x12, 0x34, 0x56, 0x78]
            const value = (provider as any).readValue([0x12, 0x34, 0x56, 0x78], 0, MemoryDataType.U32, Endianness.Big)
            expect(value).toBe(0x12345678)
        })

        test('U64: should read 64-bit value little endian', () => {
            provider.setDataType(MemoryDataType.U64)

            // 0xEFCDAB8967452301 in LE
            const bytes = [0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF]
            const value = (provider as any).readValue(bytes, 0, MemoryDataType.U64, Endianness.Little)
            expect(value).toBe(BigInt('0xEFCDAB8967452301'))
        })

        test('U64: should read 64-bit value big endian', () => {
            provider.setDataType(MemoryDataType.U64)

            // 0x0123456789ABCDEF in BE
            const bytes = [0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF]
            const value = (provider as any).readValue(bytes, 0, MemoryDataType.U64, Endianness.Big)
            expect(value).toBe(BigInt('0x0123456789ABCDEF'))
        })
    })

    describe('Signed Integer Types', () => {
        test('I8: should read signed byte value', () => {
            provider.setDataType(MemoryDataType.I8)

            // 0x7F = 127 (positive max)
            expect((provider as any).readValue([0x7F], 0, MemoryDataType.I8, Endianness.Little)).toBe(127)

            // 0x80 = -128 (negative)
            expect((provider as any).readValue([0x80], 0, MemoryDataType.I8, Endianness.Little)).toBe(-128)

            // 0xFF = -1
            expect((provider as any).readValue([0xFF], 0, MemoryDataType.I8, Endianness.Little)).toBe(-1)

            // 0x00 = 0
            expect((provider as any).readValue([0x00], 0, MemoryDataType.I8, Endianness.Little)).toBe(0)
        })

        test('I16: should read signed 16-bit value', () => {
            provider.setDataType(MemoryDataType.I16)

            // 0x7FFF = 32767 (positive max)
            expect((provider as any).readValue([0xFF, 0x7F], 0, MemoryDataType.I16, Endianness.Little)).toBe(32767)

            // 0x8000 = -32768 (negative)
            expect((provider as any).readValue([0x00, 0x80], 0, MemoryDataType.I16, Endianness.Little)).toBe(-32768)

            // 0xFFFF = -1
            expect((provider as any).readValue([0xFF, 0xFF], 0, MemoryDataType.I16, Endianness.Little)).toBe(-1)
        })

        test('I32: should read signed 32-bit value', () => {
            provider.setDataType(MemoryDataType.I32)

            // 0x7FFFFFFF = 2147483647 (positive max)
            expect((provider as any).readValue([0xFF, 0xFF, 0xFF, 0x7F], 0, MemoryDataType.I32, Endianness.Little))
                .toBe(2147483647)

            // 0x80000000 = -2147483648 (negative)
            expect((provider as any).readValue([0x00, 0x00, 0x00, 0x80], 0, MemoryDataType.I32, Endianness.Little))
                .toBe(-2147483648)

            // 0xFFFFFFFF = -1
            expect((provider as any).readValue([0xFF, 0xFF, 0xFF, 0xFF], 0, MemoryDataType.I32, Endianness.Little))
                .toBe(-1)
        })

        test('I64: should read signed 64-bit value', () => {
            provider.setDataType(MemoryDataType.I64)

            // 0x7FFFFFFFFFFFFFFF = max positive
            const maxBytes = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F]
            const maxValue = (provider as any).readValue(maxBytes, 0, MemoryDataType.I64, Endianness.Little)
            expect(maxValue).toBe(BigInt('9223372036854775807'))

            // 0xFFFFFFFFFFFFFFFF = -1
            const negBytes = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]
            const negValue = (provider as any).readValue(negBytes, 0, MemoryDataType.I64, Endianness.Little)
            expect(negValue).toBe(BigInt(-1))
        })
    })

    describe('Floating Point Types', () => {
        test('Float: should read 32-bit float little endian', () => {
            provider.setDataType(MemoryDataType.Float)

            // IEEE 754: 0x3F800000 = 1.0
            const value1 = (provider as any).readValue([0x00, 0x00, 0x80, 0x3F], 0, MemoryDataType.Float, Endianness.Little)
            expect(value1).toBeCloseTo(1.0, 6)

            // IEEE 754: 0x40400000 = 3.0
            const value2 = (provider as any).readValue([0x00, 0x00, 0x40, 0x40], 0, MemoryDataType.Float, Endianness.Little)
            expect(value2).toBeCloseTo(3.0, 6)

            // IEEE 754: 0x00000000 = 0.0
            const value3 = (provider as any).readValue([0x00, 0x00, 0x00, 0x00], 0, MemoryDataType.Float, Endianness.Little)
            expect(value3).toBeCloseTo(0.0, 6)
        })

        test('Float: should read 32-bit float big endian', () => {
            provider.setDataType(MemoryDataType.Float)

            // IEEE 754: 0x3F800000 = 1.0 in BE
            const value = (provider as any).readValue([0x3F, 0x80, 0x00, 0x00], 0, MemoryDataType.Float, Endianness.Big)
            expect(value).toBeCloseTo(1.0, 6)
        })

        test('Double: should read 64-bit double little endian', () => {
            provider.setDataType(MemoryDataType.Double)

            // IEEE 754: 0x3FF0000000000000 = 1.0
            const bytes = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF0, 0x3F]
            const value = (provider as any).readValue(bytes, 0, MemoryDataType.Double, Endianness.Little)
            expect(value).toBeCloseTo(1.0, 10)

            // IEEE 754: 0x4008000000000000 = 3.0
            const bytes3 = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x40]
            const value3 = (provider as any).readValue(bytes3, 0, MemoryDataType.Double, Endianness.Little)
            expect(value3).toBeCloseTo(3.0, 10)
        })

        test('Double: should read 64-bit double big endian', () => {
            provider.setDataType(MemoryDataType.Double)

            // IEEE 754: 0x3FF0000000000000 = 1.0 in BE
            const bytes = [0x3F, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
            const value = (provider as any).readValue(bytes, 0, MemoryDataType.Double, Endianness.Big)
            expect(value).toBeCloseTo(1.0, 10)
        })
    })

    describe('Type Size Helper', () => {
        test('should return correct type sizes', () => {
            expect((provider as any).getTypeSize(MemoryDataType.U8)).toBe(1)
            expect((provider as any).getTypeSize(MemoryDataType.I8)).toBe(1)
            expect((provider as any).getTypeSize(MemoryDataType.U16)).toBe(2)
            expect((provider as any).getTypeSize(MemoryDataType.I16)).toBe(2)
            expect((provider as any).getTypeSize(MemoryDataType.U32)).toBe(4)
            expect((provider as any).getTypeSize(MemoryDataType.I32)).toBe(4)
            expect((provider as any).getTypeSize(MemoryDataType.Float)).toBe(4)
            expect((provider as any).getTypeSize(MemoryDataType.U64)).toBe(8)
            expect((provider as any).getTypeSize(MemoryDataType.I64)).toBe(8)
            expect((provider as any).getTypeSize(MemoryDataType.Double)).toBe(8)
        })
    })
})
