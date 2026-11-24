import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getPioBuildDir,
    parseEnvironments,
    parsePlatformioIni,
    readPlatformioSections,
    resolveBuildDir,
} from '../../src/trace/platformioIni';

describe('platformioIni', () => {
    let workspace: string;
    const originalWorkspaceDir = process.env.PLATFORMIO_WORKSPACE_DIR;
    const originalBuildDir = process.env.PLATFORMIO_BUILD_DIR;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ini-'));
        delete process.env.PLATFORMIO_WORKSPACE_DIR;
        delete process.env.PLATFORMIO_BUILD_DIR;
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
        if (originalWorkspaceDir === undefined) {
            delete process.env.PLATFORMIO_WORKSPACE_DIR;
        } else {
            process.env.PLATFORMIO_WORKSPACE_DIR = originalWorkspaceDir;
        }
        if (originalBuildDir === undefined) {
            delete process.env.PLATFORMIO_BUILD_DIR;
        } else {
            process.env.PLATFORMIO_BUILD_DIR = originalBuildDir;
        }
    });

    test('parses sections, envs, extends, and interpolation', () => {
        fs.writeFileSync(path.join(workspace, 'platformio.ini'), [
            '[platformio]',
            'name = demo',
            'build_dir = ${platformio.workspace_dir}/build-output',
            'workspace_dir = .pio-workspace',
            '',
            '[env]',
            'platform = espressif32_riscv',
            'board = esp32c6',
            '',
            '[env:extra]',
            'extends = env',
            'build_flags = -DTRACE=1',
        ].join('\n'));

        const sections = readPlatformioSections(workspace);
        expect(sections).toBeDefined();
        expect(sections!['platformio']?.['name']).toBe('demo');
        expect(sections!['platformio']?.['build_dir']).toBe(
            `${path.join('.pio-workspace')}/build-output`
        );

        const envs = parseEnvironments(sections!);
        expect(envs).toEqual([
            expect.objectContaining({ name: 'extra', platform: 'espressif32_riscv', board: 'esp32c6' }),
        ]);
    });

    test('merges extra_configs before interpolation', () => {
        fs.writeFileSync(path.join(workspace, 'extra.ini'), [
            '[env:from-extra]',
            'board = esp32c5',
            'platform = ${platformio.default_platform}',
        ].join('\n'));
        fs.writeFileSync(path.join(workspace, 'platformio.ini'), [
            '[platformio]',
            'default_platform = espressif32_riscv',
            'extra_configs = extra.ini',
            '',
            '[env:main]',
            'board = esp32c6',
        ].join('\n'));

        const sections = readPlatformioSections(workspace);
        const envs = parseEnvironments(sections!);
        expect(envs).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'from-extra', platform: 'espressif32_riscv' }),
            expect.objectContaining({ name: 'main' }),
        ]));
    });

    test('resolves default and custom build directories', async () => {
        fs.writeFileSync(path.join(workspace, 'platformio.ini'), [
            '[env:demo]',
            'board = esp32c6',
        ].join('\n'));
        const sections = readPlatformioSections(workspace)!;
        await expect(resolveBuildDir(workspace, sections)).resolves.toBe(
            path.join(workspace, '.pio', 'build')
        );
        await expect(getPioBuildDir(workspace)).resolves.toBe(path.join(workspace, '.pio', 'build'));

        fs.writeFileSync(path.join(workspace, 'platformio.ini'), [
            '[platformio]',
            'workspace_dir = custom-workspace',
            'build_dir = ${platformio.workspace_dir}/out',
            '',
            '[env:demo]',
            'board = esp32c6',
        ].join('\n'));
        const customSections = readPlatformioSections(workspace)!;
        await expect(resolveBuildDir(workspace, customSections)).resolves.toBe(
            path.join(workspace, 'custom-workspace', 'out')
        );
    });

    test('uses the PlatformIO resolver only for PROJECT_HASH paths', async () => {
        const resolvedBuildDir = path.join(workspace, 'resolved-hash', 'build');
        fs.writeFileSync(path.join(workspace, 'platformio.ini'), [
            '[platformio]',
            'workspace_dir = ${PROJECT_DIR}/.pio/${PROJECT_HASH}',
            '',
            '[env:demo]',
            'board = esp32c6',
        ].join('\n'));
        const sections = readPlatformioSections(workspace)!;
        const resolver = jest.fn().mockResolvedValue(resolvedBuildDir);

        await expect(resolveBuildDir(workspace, sections, { resolvePlatformIOBuildDir: resolver }))
            .resolves.toBe(resolvedBuildDir);
        expect(resolver).toHaveBeenCalledWith(workspace);

        await expect(resolveBuildDir(workspace, sections)).resolves.toBeUndefined();
    });

    test('does not resolve PROJECT_HASH without a resolver', async () => {
        fs.writeFileSync(path.join(workspace, 'platformio.ini'), [
            '[platformio]',
            'build_dir = ${PROJECT_DIR}/.pio/${PROJECT_HASH}/build',
            '',
            '[env:demo]',
            'board = esp32c6',
        ].join('\n'));
        const sections = parsePlatformioIni(fs.readFileSync(path.join(workspace, 'platformio.ini'), 'utf8'));
        await expect(resolveBuildDir(workspace, sections)).resolves.toBeUndefined();
    });
});
