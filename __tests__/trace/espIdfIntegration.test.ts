import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    findIdfAddr2linePath,
    findIdfElfPath,
    findIdfGdbPath,
    findIdfOpenOcdPath,
    findIdfRomElfPath,
    isEspIdfWorkspace,
    readIdfProjectDescription,
    readIdfSdkconfigTarget,
    resolveEspIdfContext,
} from '../../src/trace/espIdfIntegration';
import { resolveTraceContext } from '../../src/trace/pioToolchain';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'esp-idf-trace-'));
}

function makeElf32Riscv(): Buffer {
    const buf = Buffer.alloc(52);
    buf[0] = 0x7f;
    buf[1] = 0x45;
    buf[2] = 0x4c;
    buf[3] = 0x46;
    buf[4] = 1; // ELFCLASS32
    buf[5] = 1; // ELFDATA2LSB
    buf.writeUInt16LE(0xf3, 18); // EM_RISCV
    return buf;
}

describe('espIdfIntegration', () => {
    const temps: string[] = [];

    afterEach(() => {
        for (const dir of temps) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        temps.length = 0;
    });

    test('detects ESP-IDF workspace and reads project_description.json + sdkconfig', () => {
        const root = makeTempDir();
        temps.push(root);
        const buildDir = path.join(root, 'build');
        fs.mkdirSync(buildDir, { recursive: true });
        const elfPath = path.join(buildDir, 'blink.elf');
        fs.writeFileSync(elfPath, makeElf32Riscv());
        fs.writeFileSync(
            path.join(buildDir, 'project_description.json'),
            JSON.stringify({
                project_name: 'blink',
                app_elf: 'blink.elf',
                target: 'esp32c6',
                idf_path: '/opt/esp/idf',
            })
        );
        fs.writeFileSync(path.join(root, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32c6"\n');

        expect(isEspIdfWorkspace(root)).toBe(true);
        const desc = readIdfProjectDescription(buildDir);
        expect(desc).toEqual({
            target: 'esp32c6',
            appElfPath: elfPath,
            idfPath: '/opt/esp/idf',
            buildDir,
        });
        expect(findIdfElfPath(buildDir)).toBe(elfPath);
        expect(readIdfSdkconfigTarget(root)).toBe('esp32c6');
    });

    test('finds newest ESP-IDF toolchain binaries and ROM ELF under toolsDir', () => {
        const root = makeTempDir();
        temps.push(root);
        const ext = process.platform === 'win32' ? '.exe' : '';

        const gdbOld = path.join(root, 'tools', 'riscv32-esp-elf-gdb', '14.1_2024', 'riscv32-esp-elf-gdb', 'bin', `riscv32-esp-elf-gdb${ext}`);
        const gdbNew = path.join(root, 'tools', 'riscv32-esp-elf-gdb', '15.2_2025', 'riscv32-esp-elf-gdb', 'bin', `riscv32-esp-elf-gdb${ext}`);
        const a2l = path.join(root, 'tools', 'riscv32-esp-elf', 'esp-14.2.0', 'riscv32-esp-elf', 'bin', `riscv32-esp-elf-addr2line${ext}`);
        const ocd = path.join(root, 'tools', 'openocd-esp32', 'v0.12.0', 'openocd-esp32', 'bin', `openocd${ext}`);
        const rom = path.join(root, 'tools', 'esp-rom-elfs', '20241011', 'esp32c6_rev0_rom.elf');

        for (const p of [gdbOld, gdbNew, a2l, ocd, rom]) {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, '');
        }

        expect(findIdfGdbPath(root, 'riscv')).toBe(gdbNew);
        expect(findIdfAddr2linePath(root, 'riscv')).toBe(a2l);
        expect(findIdfOpenOcdPath(root)).toBe(ocd);
        expect(findIdfRomElfPath(root, 'esp32c6')).toBe(rom);
    });

    test('resolveTraceContext falls back to ESP-IDF when no platformio.ini exists', async () => {
        const root = makeTempDir();
        temps.push(root);
        const buildDir = path.join(root, 'build');
        fs.mkdirSync(buildDir, { recursive: true });
        const elfPath = path.join(buildDir, 'app.elf');
        fs.writeFileSync(elfPath, makeElf32Riscv());
        fs.writeFileSync(
            path.join(buildDir, 'project_description.json'),
            JSON.stringify({
                project_name: 'app',
                app_elf: 'app.elf',
                target: 'esp32c5',
                idf_path: '/opt/esp/idf',
            })
        );

        const ctx = await resolveTraceContext({
            workspaceFolder: root,
            coreDir: path.join(root, 'empty-pio-core'),
            packagesDir: path.join(root, 'empty-pio-packages'),
        });

        expect(ctx.elfPath).toBe(elfPath);
        expect(ctx.chip).toBe('esp32c5');
        expect(ctx.targetArch).toBe('riscv');
        expect(ctx.buildDir).toBe(buildDir);
        expect(ctx.idfPath).toBe('/opt/esp/idf');

        const direct = resolveEspIdfContext(root);
        expect(direct.elfPath).toBe(elfPath);
        expect(direct.chip).toBe('esp32c5');
    });

    test('does not adopt workspace chip when an external ELF is provided', async () => {
        const root = makeTempDir();
        temps.push(root);
        const buildDir = path.join(root, 'build');
        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, 'app.elf'), makeElf32Riscv());
        fs.writeFileSync(
            path.join(buildDir, 'project_description.json'),
            JSON.stringify({ project_name: 'app', app_elf: 'app.elf', target: 'esp32c5' })
        );
        const externalElf = path.join(root, 'esp32c6.elf');
        fs.writeFileSync(externalElf, makeElf32Riscv());

        const ctx = await resolveTraceContext({
            workspaceFolder: root,
            elfPath: externalElf,
            coreDir: path.join(root, 'empty-pio-core'),
            packagesDir: path.join(root, 'empty-pio-packages'),
        });

        expect(ctx.elfPath).toBe(externalElf);
        expect(ctx.chip).toBe('esp32c6');
    });

    test('uses native build/ when platformio.ini has no configured build_dir or PIO ELF', async () => {
        const root = makeTempDir();
        temps.push(root);
        fs.writeFileSync(path.join(root, 'platformio.ini'), '[env:default]\nplatform = espressif32\n');
        const buildDir = path.join(root, 'build');
        fs.mkdirSync(buildDir, { recursive: true });
        const elfPath = path.join(buildDir, 'idf_app.elf');
        fs.writeFileSync(elfPath, makeElf32Riscv());
        fs.writeFileSync(
            path.join(buildDir, 'project_description.json'),
            JSON.stringify({ project_name: 'idf_app', app_elf: 'idf_app.elf', target: 'esp32c6' })
        );

        const ctx = await resolveTraceContext({
            workspaceFolder: root,
            usePlatformIOConfig: false,
            coreDir: path.join(root, 'empty-pio-core'),
            packagesDir: path.join(root, 'empty-pio-packages'),
        });

        expect(ctx.elfPath).toBe(elfPath);
        expect(ctx.chip).toBe('esp32c6');
        expect(ctx.buildDir).toBe(buildDir);
    });
});
