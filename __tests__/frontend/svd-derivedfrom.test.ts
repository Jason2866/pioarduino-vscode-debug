/**
 * Tests for SVD <derivedFrom> inheritance (Phase 3 SVD Enhancements).
 *
 * Verifies that PeripheralTreeProvider correctly resolves derivedFrom
 * references on peripherals, registers, clusters, and fields, including
 * transitive chains and circular-reference protection.
 */

jest.mock('vscode', () => ({
    ...jest.requireActual('../../__mocks__/vscode'),
}))

import { PeripheralTreeProvider } from '../../src/frontend/peripheral'

describe('SVD derivedFrom', () => {
    let provider: PeripheralTreeProvider

    beforeEach(() => {
        provider = new PeripheralTreeProvider()
    })

    test('peripheral inherits registers and properties from base', () => {
        const map: Record<string, any> = {
            UART1: {
                name: 'UART1',
                baseAddress: 0x40000000,
                size: 32,
                registers: {
                    register: [
                        { name: 'CR', addressOffset: 0x0, size: 32 },
                    ],
                },
            },
            UART2: {
                name: 'UART2',
                baseAddress: 0x40001000,
                '@_derivedFrom': 'UART1',
            },
        }

        ;(provider as any)._resolvePeripheralDerivedFrom(map)

        expect(map.UART2.registers.register[0].name).toBe('CR')
        // Derived peripheral keeps its own baseAddress
        expect(map.UART2.baseAddress).toBe(0x40001000)
        // Marker is removed after resolution
        expect(map.UART2['@_derivedFrom']).toBeUndefined()
    })

    test('derived peripheral with extra register keeps all base registers', () => {
        const map: Record<string, any> = {
            UART1: {
                name: 'UART1',
                baseAddress: 0x40000000,
                registers: {
                    register: [
                        { name: 'CR', addressOffset: 0x0, size: 32 },
                        { name: 'DR', addressOffset: 0x4, size: 32 },
                    ],
                },
            },
            UART2: {
                name: 'UART2',
                baseAddress: 0x40001000,
                '@_derivedFrom': 'UART1',
                // Derived peripheral overrides one register and adds a new one
                registers: {
                    register: [
                        { name: 'CR', addressOffset: 0x0, size: 32, access: 'read-write' },
                        { name: 'SR', addressOffset: 0x8, size: 32 },
                    ],
                },
            },
        }

        ;(provider as any)._resolvePeripheralDerivedFrom(map)

        const names = map.UART2.registers.register.map((r: any) => r.name)
        // Base register DR must be preserved
        expect(names).toContain('DR')
        // Overridden register CR must be present with derived properties
        expect(names).toContain('CR')
        const cr = map.UART2.registers.register.find((r: any) => r.name === 'CR')
        expect(cr.access).toBe('read-write')
        // New register from derived
        expect(names).toContain('SR')
    })

    test('resolves transitive derivedFrom chains', () => {
        const map: Record<string, any> = {
            A: { name: 'A', baseAddress: 0x100, value: 'fromA' },
            B: { name: 'B', baseAddress: 0x200, '@_derivedFrom': 'A' },
            C: { name: 'C', baseAddress: 0x300, '@_derivedFrom': 'B' },
        }

        ;(provider as any)._resolvePeripheralDerivedFrom(map)

        expect(map.C.value).toBe('fromA')
        expect(map.C.baseAddress).toBe(0x300)
    })

    test('throws on circular peripheral derivedFrom references', () => {
        const map: Record<string, any> = {
            A: { name: 'A', '@_derivedFrom': 'B' },
            B: { name: 'B', '@_derivedFrom': 'A' },
        }

        expect(() =>
            (provider as any)._resolvePeripheralDerivedFrom(map)
        ).toThrow(/Circular derivedFrom/)
    })

    test('register-level derivedFrom inherits fields from base register', () => {
        const periph = {
            name: 'PERIPH',
            registers: {
                register: [
                    {
                        name: 'BASE',
                        addressOffset: 0x0,
                        fields: {
                            field: [
                                { name: 'EN', bitOffset: 0, bitWidth: 1 },
                            ],
                        },
                    },
                    {
                        name: 'DERIVED',
                        addressOffset: 0x4,
                        '@_derivedFrom': 'BASE',
                    },
                ],
            },
        }

        ;(provider as any)._resolveInnerDerivedFrom(periph)

        const derived = periph.registers.register.find(
            (r: any) => r.name === 'DERIVED'
        )
        expect(derived.fields.field[0].name).toBe('EN')
        expect(derived.addressOffset).toBe(0x4)
        expect(derived['@_derivedFrom']).toBeUndefined()
    })

    test('cluster-level derivedFrom inherits registers from base cluster', () => {
        const periph = {
            name: 'PERIPH',
            registers: {
                cluster: [
                    {
                        name: 'CHAN_BASE',
                        addressOffset: 0x0,
                        register: [
                            { name: 'CFG', addressOffset: 0x0 },
                        ],
                    },
                    {
                        name: 'CHAN1',
                        addressOffset: 0x10,
                        '@_derivedFrom': 'CHAN_BASE',
                    },
                ],
            },
        }

        ;(provider as any)._resolveInnerDerivedFrom(periph)

        const derived = periph.registers.cluster.find(
            (c: any) => c.name === 'CHAN1'
        )
        expect(derived.register[0].name).toBe('CFG')
        expect(derived.addressOffset).toBe(0x10)
    })

    test('field-level derivedFrom inherits properties from base field', () => {
        const periph = {
            name: 'PERIPH',
            registers: {
                register: [
                    {
                        name: 'CTRL',
                        addressOffset: 0x0,
                        fields: {
                            field: [
                                {
                                    name: 'EN',
                                    bitOffset: 0,
                                    bitWidth: 1,
                                    description: 'Enable',
                                },
                                {
                                    name: 'EN2',
                                    bitOffset: 1,
                                    '@_derivedFrom': 'EN',
                                },
                            ],
                        },
                    },
                ],
            },
        }

        ;(provider as any)._resolveInnerDerivedFrom(periph)

        const en2 = periph.registers.register[0].fields.field.find(
            (f: any) => f.name === 'EN2'
        )
        expect(en2.bitWidth).toBe(1)
        expect(en2.description).toBe('Enable')
        expect(en2.bitOffset).toBe(1)
    })

    test('throws on circular register derivedFrom references', () => {
        const periph = {
            registers: {
                register: [
                    { name: 'A', addressOffset: 0, '@_derivedFrom': 'B' },
                    { name: 'B', addressOffset: 4, '@_derivedFrom': 'A' },
                ],
            },
        }

        expect(() =>
            (provider as any)._resolveInnerDerivedFrom(periph)
        ).toThrow(/Circular derivedFrom/)
    })
})
