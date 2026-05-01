/**
 * Tests for the peripheral search/filter QuickPick (Phase 3 SVD Enhancements).
 *
 * Verifies that PeripheralTreeProvider.search builds QuickPick items from the
 * loaded peripherals, expands the chosen entry, and refreshes the tree view.
 */

jest.mock('vscode', () => ({
    ...jest.requireActual('../../__mocks__/vscode'),
}))

import * as vscode from 'vscode'
import {
    PeripheralTreeProvider,
    PeripheralNode,
} from '../../src/frontend/peripheral'

function makePeripheral(name: string, baseAddress: number, description = ''): PeripheralNode {
    return new PeripheralNode({
        name,
        baseAddress,
        description,
        totalLength: 0x100,
        size: 32,
        resetValue: 0n,
    })
}

describe('Peripheral Search/Filter', () => {
    let provider: PeripheralTreeProvider

    beforeEach(() => {
        provider = new PeripheralTreeProvider()
        // Inject peripherals via the parsing pipeline test seam.
        ;(provider as any).peripherials = [
            makePeripheral('TIMER1', 0x40000000, 'General-purpose timer'),
            makePeripheral('GPIO_A', 0x50000000, 'GPIO Port A'),
            makePeripheral('UART2', 0x60000000, 'Universal Async RX/TX'),
        ]
        ;(vscode.window.showQuickPick as jest.Mock).mockReset()
        ;(vscode.window.showInformationMessage as jest.Mock).mockReset()
    })

    test('passes peripheral metadata as QuickPick items', async () => {
        ;(vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined)

        await provider.search()

        const call = (vscode.window.showQuickPick as jest.Mock).mock.calls[0]
        const items = call[0] as Array<{ label: string; description: string; detail: string }>
        expect(items.map((i) => i.label)).toEqual(['TIMER1', 'GPIO_A', 'UART2'])
        expect(items[0].description).toMatch(/0x40000000/i)
        expect(items[1].detail).toBe('GPIO Port A')

        const options = call[1]
        expect(options).toMatchObject({
            matchOnDescription: true,
            matchOnDetail: true,
        })
    })

    test('expands the chosen peripheral and refreshes the tree', async () => {
        ;(vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
            label: 'GPIO_A',
            description: '0x50000000',
            detail: 'GPIO Port A',
        })

        const refreshSpy = jest.spyOn(provider as any, 'refresh')
        await provider.search()

        const target = (provider as any).peripherials.find(
            (p: PeripheralNode) => p.name === 'GPIO_A'
        )
        expect(target.expanded).toBe(true)
        expect(refreshSpy).toHaveBeenCalled()
    })

    test('handles user cancellation without expanding', async () => {
        ;(vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined)

        await provider.search()

        for (const p of (provider as any).peripherials as PeripheralNode[]) {
            expect(p.expanded).toBe(false)
        }
    })

    test('shows an info message when no peripherals are loaded', async () => {
        ;(provider as any).peripherials = []
        await provider.search()
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('No peripherals')
        )
        expect(vscode.window.showQuickPick).not.toHaveBeenCalled()
    })

    test('reveals the selected peripheral when a TreeView is attached', async () => {
        const reveal = jest.fn().mockResolvedValue(undefined)
        provider.setTreeView({ reveal } as any)

        ;(vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
            label: 'UART2',
            description: '0x60000000',
            detail: 'Universal Async RX/TX',
        })

        await provider.search()

        expect(reveal).toHaveBeenCalledTimes(1)
        const [, options] = reveal.mock.calls[0]
        expect(options).toEqual({ select: true, focus: true, expand: true })
    })
})
