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
    Range: jest.fn().mockImplementation((start: any, end: any) => {
        // Handle both Position objects and (line, char) numbers
        const startLine = typeof start === 'number' ? start : start?.line ?? 0
        const startChar = typeof start === 'number' ? end : start?.character ?? 0
        const endLine = typeof end === 'number' ? end : end?.line ?? 0
        const endChar = typeof end === 'number' ? 0 : end?.character ?? 0

        return {
            start: { line: startLine, character: startChar },
            end: { line: endLine, character: endChar }
        }
    }),
    OverviewRulerLane: {
        Right: 4
    },
    Uri: {
        parse: jest.fn()
    },
    workspace: {
        textDocuments: []
    },
    env: {
        clipboard: {
            writeText: jest.fn().mockResolvedValue(undefined)
        }
    }
}))

describe('MemoryContentProvider', () => {
    let provider: MemoryContentProvider

    beforeEach(() => {
        provider = new MemoryContentProvider()
    })

    describe('Display-setting isolation between provider instances', () => {
        test('setting dataType on providerA does not affect providerB', () => {
            const providerA = new MemoryContentProvider()
            const providerB = new MemoryContentProvider()

            const allTypes = [
                MemoryDataType.U8,
                MemoryDataType.U16,
                MemoryDataType.U32,
                MemoryDataType.U64,
                MemoryDataType.I8,
                MemoryDataType.I16,
                MemoryDataType.I32,
                MemoryDataType.I64,
                MemoryDataType.Float,
                MemoryDataType.Double,
            ]

            for (const type of allTypes) {
                providerA.setDataType(type)
                // providerB must remain at its own default regardless of providerA
                expect(providerB.getDataType()).toBe(MemoryDataType.U8)
            }

            // After resetting providerA to Float, providerB still at U8
            providerA.setDataType(MemoryDataType.Float)
            expect(providerB.getDataType()).toBe(MemoryDataType.U8)
        })

        test('endianness changes on providerA do not affect providerB', () => {
            const providerA = new MemoryContentProvider()
            const providerB = new MemoryContentProvider()

            // Both default to Little
            expect(providerA.getEndianness()).toBe(Endianness.Little)
            expect(providerB.getEndianness()).toBe(Endianness.Little)

            providerA.setEndianness(Endianness.Big)
            expect(providerA.getEndianness()).toBe(Endianness.Big)
            expect(providerB.getEndianness()).toBe(Endianness.Little)

            providerA.toggleEndianness()
            expect(providerA.getEndianness()).toBe(Endianness.Little)
            expect(providerB.getEndianness()).toBe(Endianness.Little)

            providerB.setEndianness(Endianness.Big)
            expect(providerA.getEndianness()).toBe(Endianness.Little)
            expect(providerB.getEndianness()).toBe(Endianness.Big)
        })

        test('per-URI settings are isolated: changing URI A settings does not affect URI B fallback', () => {
            const p = new MemoryContentProvider()
            const uriA = 'examinememory://mem?address=0x20000000&length=0x10'
            const uriB = 'examinememory://mem?address=0x30000000&length=0x10'

            // Set URI A to U32 / Big
            p.setDataTypeForUri(uriA, MemoryDataType.U32)
            p.toggleEndiannessForUri(uriA)

            // URI B must still return the global defaults (U8 / Little)
            expect(p.getDataTypeForUri(uriB)).toBe(MemoryDataType.U8)
            expect(p.getEndiannessForUri(uriB)).toBe(Endianness.Little)

            // URI A has its own values
            expect(p.getDataTypeForUri(uriA)).toBe(MemoryDataType.U32)
            expect(p.getEndiannessForUri(uriA)).toBe(Endianness.Big)
        })
    })

    describe('Data Type Settings', () => {
        test('should default to U8 data type', () => {
            expect(provider.getDataType()).toBe(MemoryDataType.U8)
        })

        test('should set and get data type', () => {
            provider.setDataType(MemoryDataType.U32)
            expect(provider.getDataType()).toBe(MemoryDataType.U32)

            provider.setDataType(MemoryDataType.Float)
            expect(provider.getDataType()).toBe(MemoryDataType.Float)
        })

        test('should support all data types', () => {
            const allTypes = [
                MemoryDataType.U8,
                MemoryDataType.U16,
                MemoryDataType.U32,
                MemoryDataType.U64,
                MemoryDataType.I8,
                MemoryDataType.I16,
                MemoryDataType.I32,
                MemoryDataType.I64,
                MemoryDataType.Float,
                MemoryDataType.Double
            ]

            allTypes.forEach(type => {
                provider.setDataType(type)
                expect(provider.getDataType()).toBe(type)
            })
        })
    })

    describe('Endianness Settings', () => {
        test('should default to little endian', () => {
            expect(provider.getEndianness()).toBe(Endianness.Little)
        })

        test('should set and get endianness', () => {
            provider.setEndianness(Endianness.Big)
            expect(provider.getEndianness()).toBe(Endianness.Big)

            provider.setEndianness(Endianness.Little)
            expect(provider.getEndianness()).toBe(Endianness.Little)
        })

        test('should toggle endianness', () => {
            // Start with little
            expect(provider.getEndianness()).toBe(Endianness.Little)

            // Toggle to big
            provider.toggleEndianness()
            expect(provider.getEndianness()).toBe(Endianness.Big)

            // Toggle back to little
            provider.toggleEndianness()
            expect(provider.getEndianness()).toBe(Endianness.Little)
        })
    })

    describe('Position/Offset Mapping', () => {
        test('should map byte offset to position', () => {
            // First row, first byte (hex column)
            const pos1 = provider.getPosition(0, false)
            expect(pos1.line).toBe(2)
            expect(pos1.character).toBe(10) // firstBytePos

            // First row, second byte
            const pos2 = provider.getPosition(1, false)
            expect(pos2.line).toBe(2)
            expect(pos2.character).toBe(13) // 10 + 3

            // Second row, first byte
            const pos3 = provider.getPosition(16, false)
            expect(pos3.line).toBe(3)
            expect(pos3.character).toBe(10)
        })

        test('should map byte offset to ASCII position', () => {
            const firstAsciiPos = (provider as any).firstAsciiPos as number

            // First row, first byte (ASCII column)
            const pos1 = provider.getPosition(0, true)
            expect(pos1.line).toBe(2)
            expect(pos1.character).toBe(firstAsciiPos)

            // Second row, first byte in ASCII
            const pos2 = provider.getPosition(16, true)
            expect(pos2.line).toBe(3)
            expect(pos2.character).toBe(firstAsciiPos)
        })

        test('should return undefined for invalid positions', () => {
            // Header lines return undefined (clicking the header has no byte meaning)
            const offset = provider.getOffset({ line: 0, character: 15 } as any)
            expect(offset).toBeUndefined()

            // Character before first byte position
            const offset2 = provider.getOffset({ line: 2, character: 5 } as any)
            expect(offset2).toBeUndefined()
        })

        test('should calculate offset for hex column positions', () => {
            // First byte position in hex column
            const offset1 = provider.getOffset({ line: 2, character: 10 } as any)
            expect(offset1).toBe(0)

            // Second byte (each byte takes 3 chars: "00 ")
            const offset2 = provider.getOffset({ line: 2, character: 13 } as any)
            expect(offset2).toBe(1)

            // Third byte
            const offset3 = provider.getOffset({ line: 2, character: 16 } as any)
            expect(offset3).toBe(2)
        })

        test('should treat the separator between hex and ASCII columns as invalid', () => {
            expect(provider.getOffset({ line: 2, character: 58 } as any)).toBeUndefined()
            expect(provider.getOffset({ line: 2, character: 59 } as any)).toBeUndefined()
        })
    })

    describe('Range Building', () => {
        test('should build ranges for single byte', () => {
            const ranges = provider.getRanges(0, 0, false)
            expect(ranges.length).toBeGreaterThan(0)
            expect(ranges[0].start.line).toBe(2)
        })

        test('should build ranges spanning multiple lines', () => {
            // Bytes 0-20 span 2 lines (16 bytes per line)
            const ranges = provider.getRanges(0, 20, false)
            expect(ranges.length).toBe(2)
            expect(ranges[0].start.line).toBe(2)
            expect(ranges[1].start.line).toBe(3)
        })
    })
})

describe('MemoryDataType Enum', () => {
    test('should have correct values', () => {
        expect(MemoryDataType.U8).toBe('u8')
        expect(MemoryDataType.U16).toBe('u16')
        expect(MemoryDataType.U32).toBe('u32')
        expect(MemoryDataType.U64).toBe('u64')
        expect(MemoryDataType.I8).toBe('i8')
        expect(MemoryDataType.I16).toBe('i16')
        expect(MemoryDataType.I32).toBe('i32')
        expect(MemoryDataType.I64).toBe('i64')
        expect(MemoryDataType.Float).toBe('float')
        expect(MemoryDataType.Double).toBe('double')
    })
})

describe('Endianness Enum', () => {
    test('should have correct values', () => {
        expect(Endianness.Little).toBe('little')
        expect(Endianness.Big).toBe('big')
    })
})
