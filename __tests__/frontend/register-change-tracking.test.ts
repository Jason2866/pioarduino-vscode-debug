/**
 * Tests for register value change highlighting (Phase 3 SVD Enhancements).
 *
 * Verifies that RegisterNode tracks previousValue/valueChanged across reads
 * and exposes a tree icon when the register differs from its reset value.
 */

jest.mock('vscode', () => ({
    ...jest.requireActual('../../__mocks__/vscode'),
}))

import {
    PeripheralNode,
    RegisterNode,
    AccessType,
} from '../../src/frontend/peripheral'

function makeRegister(reset: bigint = 0n): {
    peripheral: PeripheralNode
    register: RegisterNode
} {
    const peripheral = new PeripheralNode({
        name: 'P',
        baseAddress: 0,
        description: '',
        totalLength: 16,
        size: 32,
        resetValue: 0n,
    })
    const register = new RegisterNode(peripheral, {
        name: 'R',
        addressOffset: 0,
        size: 32,
        resetValue: reset,
        accessType: AccessType.ReadWrite,
    })
    return { peripheral, register }
}

function setBytes(peripheral: PeripheralNode, bytes: number[]): void {
    peripheral.currentValue = bytes
}

describe('Register Change Tracking', () => {
    test('initialises with currentValue and previousValue equal to resetValue', () => {
        const { register } = makeRegister(0xDEADBEEFn)
        expect(register.currentValue).toBe(0xDEADBEEFn)
        expect(register.previousValue).toBe(0xDEADBEEFn)
        expect(register.valueChanged).toBe(false)
    })

    test('flags valueChanged when the read produces a new value', async () => {
        const { peripheral, register } = makeRegister(0n)

        setBytes(peripheral, [0x78, 0x56, 0x34, 0x12])
        await register.update()

        expect(register.currentValue).toBe(0x12345678n)
        expect(register.previousValue).toBe(0n)
        expect(register.valueChanged).toBe(true)
    })

    test('clears valueChanged when consecutive reads yield the same value', async () => {
        const { peripheral, register } = makeRegister(0n)

        setBytes(peripheral, [0x01, 0x00, 0x00, 0x00])
        await register.update()
        expect(register.valueChanged).toBe(true)

        // Second read produces the same value — change flag must clear.
        await register.update()
        expect(register.currentValue).toBe(1n)
        expect(register.previousValue).toBe(1n)
        expect(register.valueChanged).toBe(false)
    })

    test('tree node carries an icon when current value differs from reset', () => {
        const { peripheral, register } = makeRegister(0n)
        register.currentValue = 0x42n

        const node = register.getTreeNode()
        expect(node.iconPath).toBeDefined()
        expect((node.iconPath as any).id).toBe('circle-filled')
        expect(typeof node.tooltip).toBe('string')
        expect(node.tooltip as string).toMatch(/Reset:/)
        expect(node.tooltip as string).toMatch(/Current:/)
    })

    test('tree node has no change icon when value matches reset value', () => {
        const { register } = makeRegister(0xCAFEn)
        // currentValue still equals resetValue from constructor
        const node = register.getTreeNode()
        expect(node.iconPath).toBeUndefined()
    })
})
