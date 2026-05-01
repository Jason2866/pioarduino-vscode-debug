/**
 * Tests for SVD file discovery (Phase 3 SVD Enhancements).
 *
 * Verifies that PeripheralTreeProvider.findSVDFile searches the configured
 * locations in the expected order and prefers files matching a device name.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

jest.mock('vscode', () => ({
    ...jest.requireActual('../../__mocks__/vscode'),
}))

let mockHome: string | undefined
jest.mock('os', () => {
    const actual = jest.requireActual('os')
    return {
        ...actual,
        homedir: () => mockHome ?? actual.homedir(),
    }
})

import * as vscode from 'vscode'
import { PeripheralTreeProvider } from '../../src/frontend/peripheral'

describe('SVD File Discovery', () => {
    let tmpRoot: string
    let workspaceDir: string
    let fakeHome: string

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-discovery-'))
        workspaceDir = path.join(tmpRoot, 'workspace')
        fs.mkdirSync(workspaceDir, { recursive: true })

        // Redirect homedir so PlatformIO discovery does not touch a real install
        fakeHome = path.join(tmpRoot, 'fakehome')
        fs.mkdirSync(fakeHome, { recursive: true })
        mockHome = fakeHome

        ;(vscode.workspace as any).workspaceFolders = [
            { uri: { fsPath: workspaceDir }, name: 'ws', index: 0 },
        ]
    })

    afterEach(() => {
        mockHome = undefined
        ;(vscode.workspace as any).workspaceFolders = undefined
        fs.rmSync(tmpRoot, { recursive: true, force: true })
    })

    test('returns undefined when no SVD files exist', () => {
        const provider = new PeripheralTreeProvider()
        expect(provider.findSVDFile()).toBeUndefined()
    })

    test('discovers .svd file at the workspace root', () => {
        const svd = path.join(workspaceDir, 'device.svd')
        fs.writeFileSync(svd, '<device/>')
        const provider = new PeripheralTreeProvider()
        expect(provider.findSVDFile()).toBe(svd)
    })

    test('prefers .vscode/*.svd over workspace root', () => {
        const vscodeDir = path.join(workspaceDir, '.vscode')
        fs.mkdirSync(vscodeDir)
        const dotSvd = path.join(vscodeDir, 'a.svd')
        const rootSvd = path.join(workspaceDir, 'b.svd')
        fs.writeFileSync(dotSvd, '<device/>')
        fs.writeFileSync(rootSvd, '<device/>')
        const provider = new PeripheralTreeProvider()
        expect(provider.findSVDFile()).toBe(dotSvd)
    })

    test('discovers SVDs under ~/.platformio/packages/<pkg>/svd', () => {
        const pkgSvdDir = path.join(
            fakeHome,
            '.platformio',
            'packages',
            'framework-arduinoespressif32',
            'svd'
        )
        fs.mkdirSync(pkgSvdDir, { recursive: true })
        const svd = path.join(pkgSvdDir, 'esp32.svd')
        fs.writeFileSync(svd, '<device/>')
        const provider = new PeripheralTreeProvider()
        expect(provider.findSVDFile()).toBe(svd)
    })

    test('prefers a candidate matching the device name', () => {
        fs.writeFileSync(path.join(workspaceDir, 'random.svd'), '<device/>')
        const target = path.join(workspaceDir, 'esp32.svd')
        fs.writeFileSync(target, '<device/>')
        const provider = new PeripheralTreeProvider()
        expect(provider.findSVDFile('esp32')).toBe(target)
    })

    test('falls back to first candidate when device name has no match', () => {
        const a = path.join(workspaceDir, 'a.svd')
        const b = path.join(workspaceDir, 'b.svd')
        fs.writeFileSync(a, '<device/>')
        fs.writeFileSync(b, '<device/>')
        const provider = new PeripheralTreeProvider()
        expect(provider.findSVDFile('does-not-exist')).toBe(a)
    })

    test('ignores files without .svd extension', () => {
        fs.writeFileSync(path.join(workspaceDir, 'notes.txt'), 'hello')
        fs.writeFileSync(path.join(workspaceDir, 'config.json'), '{}')
        const provider = new PeripheralTreeProvider()
        expect(provider.findSVDFile()).toBeUndefined()
    })
})
