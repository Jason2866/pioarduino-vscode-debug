import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChipArch, normalizeChipName } from './chip';

export interface IdfProjectDescription {
    target?: string;
    appElfPath?: string;
    idfPath?: string;
    buildDir: string;
}

export interface EspIdfResolvedContext {
    buildDir: string;
    elfPath?: string;
    chip?: string;
    idfPath?: string;
    toolsDir?: string;
    gdbPath?: string;
    addr2linePath?: string;
    openocdPath?: string;
    romElfPath?: string;
}

function exeSuffix(): string {
    return process.platform === 'win32' ? '.exe' : '';
}

function isFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function isDir(dirPath: string): boolean {
    try {
        return fs.statSync(dirPath).isDirectory();
    } catch {
        return false;
    }
}

/** Return the ESP-IDF tools root (`IDF_TOOLS_PATH` or `~/.espressif`). */
export function getIdfToolsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const raw = env.IDF_TOOLS_PATH?.trim();
    if (raw) {
        return raw;
    }
    const home = os.homedir();
    return home ? path.join(home, '.espressif') : undefined;
}

/**
 * Parse `<buildDir>/project_description.json` produced by `idf.py` / CMake.
 */
export function readIdfProjectDescription(buildDir: string): IdfProjectDescription | undefined {
    const descPath = path.join(buildDir, 'project_description.json');
    if (!isFile(descPath)) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(descPath, 'utf-8')) as Record<string, unknown>;
        const target = typeof parsed.target === 'string' ? normalizeChipName(parsed.target) : undefined;
        const idfPath = typeof parsed.idf_path === 'string' && parsed.idf_path.trim() !== ''
            ? parsed.idf_path
            : undefined;

        let appElfPath: string | undefined;
        if (typeof parsed.app_elf === 'string' && parsed.app_elf.trim() !== '') {
            const candidate = path.isAbsolute(parsed.app_elf)
                ? parsed.app_elf
                : path.join(buildDir, parsed.app_elf);
            if (isFile(candidate)) {
                appElfPath = candidate;
            }
        }
        if (!appElfPath && typeof parsed.project_name === 'string' && parsed.project_name.trim() !== '') {
            const candidate = path.join(buildDir, `${parsed.project_name}.elf`);
            if (isFile(candidate)) {
                appElfPath = candidate;
            }
        }

        return { target, appElfPath, idfPath, buildDir };
    } catch {
        return undefined;
    }
}

/**
 * Read `CONFIG_IDF_TARGET="..."` from `sdkconfig` in `workspaceFolder`.
 */
export function readIdfSdkconfigTarget(workspaceFolder: string): string | undefined {
    const sdkconfigPath = path.join(workspaceFolder, 'sdkconfig');
    if (!isFile(sdkconfigPath)) {
        return undefined;
    }
    try {
        const content = fs.readFileSync(sdkconfigPath, 'utf-8');
        const match = /^CONFIG_IDF_TARGET="([^"]+)"/m.exec(content);
        return match ? normalizeChipName(match[1]) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Return true if `workspaceFolder` (or `buildDir`) looks like an ESP-IDF project.
 */
export function isEspIdfWorkspace(workspaceFolder: string, buildDir?: string): boolean {
    const effectiveBuildDir = buildDir ?? path.join(workspaceFolder, 'build');
    if (isFile(path.join(effectiveBuildDir, 'project_description.json'))) {
        return true;
    }
    if (isFile(path.join(workspaceFolder, 'sdkconfig')) && isFile(path.join(workspaceFolder, 'CMakeLists.txt'))) {
        return true;
    }
    const cmakePath = path.join(workspaceFolder, 'CMakeLists.txt');
    if (isFile(cmakePath)) {
        try {
            const text = fs.readFileSync(cmakePath, 'utf-8');
            if (/tools\/cmake\/project\.cmake/i.test(text)) {
                return true;
            }
        } catch {
            // Ignore unreadable CMakeLists.txt
        }
    }
    return false;
}

/**
 * Find the application ELF inside an ESP-IDF `build` directory.
 */
export function findIdfElfPath(buildDir: string): string | undefined {
    const desc = readIdfProjectDescription(buildDir);
    if (desc?.appElfPath) {
        return desc.appElfPath;
    }
    if (!isDir(buildDir)) {
        return undefined;
    }
    try {
        const entries = fs.readdirSync(buildDir, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.elf') && e.name !== 'bootloader.elf')
            .map((e) => path.join(buildDir, e.name));
        if (entries.length === 1) {
            return entries[0];
        }
        const preferred = entries.find((p) => path.basename(p) === 'app.elf');
        return preferred;
    } catch {
        return undefined;
    }
}

function listVersionDirsDesc(parentDir: string): string[] {
    if (!isDir(parentDir)) {
        return [];
    }
    try {
        return fs.readdirSync(parentDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .map((name) => path.join(parentDir, name));
    } catch {
        return [];
    }
}

/**
 * Find a binary under `<toolsDir>/tools/<toolPackage>/<version>/<innerSubdir>/<binName>`.
 */
function findIdfToolBinary(
    toolsDir: string | undefined,
    toolPackage: string,
    innerSubdir: string,
    binNames: string[]
): string | undefined {
    if (!toolsDir) {
        return undefined;
    }
    const packageRoot = path.join(toolsDir, 'tools', toolPackage);
    for (const versionDir of listVersionDirsDesc(packageRoot)) {
        const binDir = path.join(versionDir, innerSubdir);
        for (const name of binNames) {
            const candidate = path.join(binDir, name);
            if (isFile(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}

export function findIdfGdbPath(toolsDir: string | undefined, arch: ChipArch = 'riscv'): string | undefined {
    const ext = exeSuffix();
    if (arch !== 'riscv') {
        return undefined;
    }
    return (
        findIdfToolBinary(toolsDir, 'riscv32-esp-elf-gdb', path.join('riscv32-esp-elf-gdb', 'bin'), [
            `riscv32-esp-elf-gdb${ext}`,
        ]) ??
        findIdfToolBinary(toolsDir, 'riscv32-esp-elf', path.join('riscv32-esp-elf', 'bin'), [
            `riscv32-esp-elf-gdb${ext}`,
        ])
    );
}

export function findIdfAddr2linePath(toolsDir: string | undefined, arch: ChipArch = 'riscv'): string | undefined {
    const ext = exeSuffix();
    if (arch !== 'riscv') {
        return undefined;
    }
    return findIdfToolBinary(toolsDir, 'riscv32-esp-elf', path.join('riscv32-esp-elf', 'bin'), [
        `riscv32-esp-elf-addr2line${ext}`,
    ]);
}

export function findIdfOpenOcdPath(toolsDir: string | undefined): string | undefined {
    const ext = exeSuffix();
    return findIdfToolBinary(toolsDir, 'openocd-esp32', path.join('openocd-esp32', 'bin'), [
        `openocd${ext}`,
    ]);
}

export function findIdfRomElfPath(toolsDir: string | undefined, chip: string): string | undefined {
    if (!toolsDir) {
        return undefined;
    }
    const normalized = normalizeChipName(chip) ?? chip.toLowerCase();
    const romRoot = path.join(toolsDir, 'tools', 'esp-rom-elfs');
    for (const versionDir of listVersionDirsDesc(romRoot)) {
        try {
            const matches = fs.readdirSync(versionDir)
                .filter((name) => {
                    const lower = name.toLowerCase();
                    return lower.endsWith('_rom.elf') && lower.startsWith(`${normalized}_`);
                })
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            if (matches.length > 0) {
                return path.join(versionDir, matches[0]);
            }
        } catch {
            // Continue searching older versions
        }
    }
    return undefined;
}

/**
 * Resolve build directory, ELF, chip, and ESP-IDF tool paths for an ESP-IDF workspace.
 */
export function resolveEspIdfContext(
    workspaceFolder: string,
    options: {
        buildDir?: string;
        elfPath?: string;
        chip?: string;
        toolsDir?: string;
        idfPath?: string;
    } = {},
    env: NodeJS.ProcessEnv = process.env
): EspIdfResolvedContext {
    const buildDir = options.buildDir ?? path.join(workspaceFolder, 'build');
    const desc = readIdfProjectDescription(buildDir);
    const projectElfPath = findIdfElfPath(buildDir);
    const elfPath = options.elfPath ?? projectElfPath;
    const matchesProjectElf =
        !options.elfPath ||
        (projectElfPath !== undefined && path.resolve(options.elfPath) === path.resolve(projectElfPath));
    const chip = options.chip ?? (matchesProjectElf ? (desc?.target ?? readIdfSdkconfigTarget(workspaceFolder)) : undefined);
    const idfPath = options.idfPath ?? desc?.idfPath ?? (env.IDF_PATH?.trim() || undefined);
    const toolsDir = options.toolsDir ?? getIdfToolsDir(env);

    return {
        buildDir,
        elfPath,
        chip,
        idfPath,
        toolsDir,
        gdbPath: findIdfGdbPath(toolsDir, 'riscv'),
        addr2linePath: findIdfAddr2linePath(toolsDir, 'riscv'),
        openocdPath: findIdfOpenOcdPath(toolsDir),
        romElfPath: chip ? findIdfRomElfPath(toolsDir, chip) : undefined,
    };
}
