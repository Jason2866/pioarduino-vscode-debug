import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { core as pioCore, proc as pioProc } from 'pioarduino-node-helpers';
import {
    findPioElfCandidates,
    findRomElf,
    resolveTraceContext,
} from '../../src/trace/pioToolchain';

jest.mock('pioarduino-node-helpers', () => ({
    core: {
        getCoreDir: jest.fn(),
        getCoreState: jest.fn(() => ({})),
        setCoreState: jest.fn(),
        getCorePythonExe: jest.fn(),
        getCorePythonCommandOutput: jest.fn(),
    },
    proc: {
        IS_WINDOWS: false,
        whereIsProgram: jest.fn(() => null),
        getCommandOutput: jest.fn(),
        runCommand: jest.fn(),
        patchOSEnviron: jest.fn(),
        extendOSEnvironPath: jest.fn(),
        terminateCmdsInQueue: jest.fn(),
        getSysType: jest.fn(() => 'linux_x86_64'),
    },
    installer: {
        pioarduinoCoreStage: jest.fn(),
    },
    project: {},
    misc: {},
    home: {},
}));

function writeElf(filePath: string, machine: number): void {
    const elf = Buffer.alloc(52, 0);
    elf.writeUInt32BE(0x7f454c46, 0);
    elf[4] = 1;
    elf[5] = 1;
    elf.writeUInt16LE(machine, 18);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, elf);
}

describe('pioToolchain trace context', () => {
    let root: string;
    let workspace: string;
    let coreDir: string;
    let packagesDir: string;
    const originalWorkspaceDir = process.env.PLATFORMIO_WORKSPACE_DIR;
    const originalBuildDir = process.env.PLATFORMIO_BUILD_DIR;

    beforeEach(() => {
        // PlatformIO env vars would redirect build/workspace discovery away
        // from the fixture tree.
        delete process.env.PLATFORMIO_WORKSPACE_DIR;
        delete process.env.PLATFORMIO_BUILD_DIR;
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-pio-'));
        workspace = path.join(root, 'workspace');
        coreDir = path.join(root, 'core');
        packagesDir = path.join(coreDir, 'packages');
        fs.mkdirSync(workspace, { recursive: true });
        fs.mkdirSync(packagesDir, { recursive: true });
        jest.clearAllMocks();
        jest.mocked(pioCore.getCoreDir).mockReturnValue(coreDir);
        jest.mocked(pioCore.getCorePythonExe).mockResolvedValue('/mock/pio/python');
        jest.mocked(pioProc.whereIsProgram).mockReturnValue(null);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
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

    function writeRiscvToolchain(chip = 'esp32c6'): void {
        const gdbBin = path.join(packagesDir, 'tool-riscv32-esp-elf-gdb', 'bin');
        fs.mkdirSync(gdbBin, { recursive: true });
        fs.writeFileSync(path.join(gdbBin, 'riscv32-esp-elf-gdb'), '');
        fs.writeFileSync(path.join(gdbBin, 'riscv32-esp-elf-addr2line'), '');

        const openocdBin = path.join(packagesDir, 'tool-openocd-esp32', 'bin');
        fs.mkdirSync(openocdBin, { recursive: true });
        fs.writeFileSync(path.join(openocdBin, 'openocd'), '');

        const romDir = path.join(packagesDir, 'tool-esp-rom-elfs');
        fs.mkdirSync(romDir, { recursive: true });
        fs.writeFileSync(path.join(romDir, `${chip}_rev3_rom.elf`), '');

        const boardDir = path.join(coreDir, 'boards');
        fs.mkdirSync(boardDir, { recursive: true });
        fs.writeFileSync(path.join(boardDir, `${chip}.json`), JSON.stringify({ build: { mcu: chip } }));
    }

    test('resolves a RISC-V PlatformIO trace context', async () => {
        writeRiscvToolchain('esp32c6');
        fs.writeFileSync(path.join(workspace, 'platformio.ini'), [
            '[env:demo]',
            'platform = espressif32_riscv',
            'board = esp32c6',
        ].join('\n'));
        const elfPath = path.join(workspace, '.pio', 'build', 'demo', 'firmware.elf');
        writeElf(elfPath, 243);

        const context = await resolveTraceContext({ workspaceFolder: workspace, projectEnvName: 'demo' });

        expect(context.elfPath).toBe(elfPath);
        expect(context.chip).toBe('esp32c6');
        expect(context.targetArch).toBe('riscv');
        expect(context.packagesDir).toBe(packagesDir);
        expect(context.coreDir).toBe(coreDir);
        expect(context.buildDir).toBe(path.join(workspace, '.pio', 'build'));
        expect(context.gdbPath).toBe(path.join(packagesDir, 'tool-riscv32-esp-elf-gdb', 'bin', 'riscv32-esp-elf-gdb'));
        expect(context.addr2linePath).toBe(path.join(packagesDir, 'tool-riscv32-esp-elf-gdb', 'bin', 'riscv32-esp-elf-addr2line'));
        expect(context.openocdPath).toBe(path.join(packagesDir, 'tool-openocd-esp32', 'bin', 'openocd'));
        expect(context.romElfPath).toBe(path.join(packagesDir, 'tool-esp-rom-elfs', 'esp32c6_rev3_rom.elf'));
        expect(context.warnings).toEqual([]);
    });

    test('rejects Xtensa firmware for trace decoding', async () => {
        const elfPath = path.join(workspace, 'firmware.elf');
        writeElf(elfPath, 94);

        const context = await resolveTraceContext({
            workspaceFolder: workspace,
            elfPath,
            chip: 'esp32',
        });

        expect(context.targetArch).toBe('xtensa');
        expect(context.gdbPath).toBeUndefined();
        expect(context.addr2linePath).toBeUndefined();
        expect(context.openocdPath).toBeUndefined();
        expect(context.warnings).toEqual(expect.arrayContaining([
            expect.stringContaining('RISC-V'),
            expect.stringContaining('not in the supported trace chip list'),
        ]));
    });

    test('honors a custom build_dir', async () => {
        writeRiscvToolchain('esp32c5');
        fs.writeFileSync(path.join(workspace, 'platformio.ini'), [
            '[platformio]',
            'build_dir = ${PROJECT_DIR}/custom-build',
            '',
            '[env:demo]',
            'board = esp32c5',
        ].join('\n'));
        const elfPath = path.join(workspace, 'custom-build', 'demo', 'firmware.elf');
        writeElf(elfPath, 243);

        const candidates = await findPioElfCandidates(workspace);
        expect(candidates).toEqual(expect.arrayContaining([
            expect.objectContaining({ environmentName: 'demo', elfPath, chip: 'esp32c5', targetArch: 'riscv' }),
        ]));

        const context = await resolveTraceContext({ workspaceFolder: workspace, projectEnvName: 'demo' });
        expect(context.elfPath).toBe(elfPath);
        expect(context.buildDir).toBe(path.join(workspace, 'custom-build'));
        expect(context.chip).toBe('esp32c5');
    });

    test('uses PlatformIO Python config only for PROJECT_HASH build paths', async () => {
        writeRiscvToolchain('esp32c6');
        const resolvedBuildDir = path.join(workspace, 'resolved-hash', 'build');
        const elfPath = path.join(resolvedBuildDir, 'demo', 'firmware.elf');
        writeElf(elfPath, 243);
        fs.writeFileSync(path.join(workspace, 'platformio.ini'), [
            '[platformio]',
            'workspace_dir = ${PROJECT_DIR}/.pio/${PROJECT_HASH}',
            '',
            '[env:demo]',
            'board = esp32c6',
        ].join('\n'));
        jest.mocked(pioCore.getCorePythonCommandOutput).mockResolvedValue(JSON.stringify(resolvedBuildDir));

        const context = await resolveTraceContext({
            workspaceFolder: workspace,
            projectEnvName: 'demo',
            usePlatformIOConfig: true,
        });

        expect(pioCore.getCorePythonCommandOutput).toHaveBeenCalled();
        expect(context.buildDir).toBe(resolvedBuildDir);
        expect(context.elfPath).toBe(elfPath);
    });

    test('findRomElf prefers the lowest revision', () => {
        const romDir = path.join(packagesDir, 'tool-esp-rom-elfs');
        fs.mkdirSync(romDir, { recursive: true });
        fs.writeFileSync(path.join(romDir, 'esp32c6_rev9_rom.elf'), '');
        fs.writeFileSync(path.join(romDir, 'esp32c6_rev2_rom.elf'), '');
        fs.writeFileSync(path.join(romDir, 'esp32c6_other.elf'), '');

        expect(findRomElf(packagesDir, 'esp32c6')).toBe(path.join(romDir, 'esp32c6_rev2_rom.elf'));
    });
});
