import * as fs from 'fs';
import * as path from 'path';
import { core as pioCore, installer as pioInstaller, proc as pioProc } from 'pioarduino-node-helpers';
import {
    chipArch,
    detectElfArch,
    isTraceSupportedChip,
    KNOWN_CHIPS,
    ChipArch,
} from './chip';
import { ResolveTraceContextOptions, TraceContext, TraceTargetArch } from './types';
import {
    findIdfAddr2linePath,
    findIdfGdbPath,
    findIdfOpenOcdPath,
    findIdfRomElfPath,
    getIdfToolsDir,
    isEspIdfWorkspace,
    resolveEspIdfContext,
} from './espIdfIntegration';
import * as ini from './platformioIni';

export interface PioElfCandidate {
    environmentName: string;
    name: string;
    elfPath: string;
    board?: string;
    platform?: string;
    chip?: string;
    targetArch?: TraceTargetArch;
}

function getPioCoreDir(): string | undefined {
    try {
        const coreDir = pioCore.getCoreDir();
        return coreDir || undefined;
    } catch {
        return undefined;
    }
}

export function getPioPackagesDir(projectCoreDir?: string): string | undefined {
    const coreDir = projectCoreDir ?? getPioCoreDir();
    if (!coreDir) {
        return undefined;
    }
    const packagesDir = path.join(coreDir, 'packages');
    return fs.existsSync(packagesDir) ? packagesDir : undefined;
}

let pioCoreInitialization: Promise<void> | undefined;

/**
 * Initialize the bundled pioarduino-node-helpers core state when PlatformIO
 * Python-backed APIs are required. This mirrors ESP-Decoder's approach but
 * stays free of vscode imports.
 */
async function ensurePioCoreInitialized(): Promise<void> {
    try {
        await pioCore.getCorePythonExe();
        return;
    } catch {
        // Load the installed Core state below.
    }

    if (!pioCoreInitialization) {
        const configuredBuiltin = process.env.PIOARDUINO_USE_BUILTIN_CORE;
        const useBuiltinPIOCore = configuredBuiltin
            ? configuredBuiltin !== '0' && configuredBuiltin.toLowerCase() !== 'false'
            : fs.existsSync(path.join(pioCore.getCoreDir(), 'penv'));
        const stage = new pioInstaller.pioarduinoCoreStage({}, () => {}, {
            useBuiltinPIOCore,
            disableAutoUpdates: true,
            pythonPrompt: { STATUS_TRY_AGAIN: 0 },
        });

        pioCoreInitialization = stage.loadCoreState().then(() => undefined).catch((error: unknown) => {
            pioCoreInitialization = undefined;
            throw error;
        });
    }

    await pioCoreInitialization;
}

async function resolveBuildDirWithPlatformIO(workspaceFolder: string): Promise<string | undefined> {
    await ensurePioCoreInitialized();
    const script = [
        'import json',
        'from platformio.public import ProjectConfig',
        'config = ProjectConfig()',
        'print(json.dumps(config.get("platformio", "build_dir")))',
    ].join('\n');
    const output = await pioCore.getCorePythonCommandOutput(['-c', script], { projectDir: workspaceFolder });
    const resolved = JSON.parse(output.trim());
    if (typeof resolved === 'string' && resolved) {
        return path.isAbsolute(resolved) ? resolved : path.resolve(workspaceFolder, resolved);
    }
    return undefined;
}

function readBoardMcu(boardName: string, workspaceFolder?: string, projectCoreDir?: string): string | undefined {
    const boardsDirs: string[] = [];

    if (workspaceFolder) {
        boardsDirs.push(path.join(workspaceFolder, 'boards'));
    }

    const coreDir = projectCoreDir ?? getPioCoreDir();
    if (coreDir) {
        boardsDirs.push(path.join(coreDir, 'boards'));
        const platformsDir = path.join(coreDir, 'platforms');
        if (fs.existsSync(platformsDir)) {
            try {
                for (const plat of fs.readdirSync(platformsDir, { withFileTypes: true })) {
                    if (plat.isDirectory()) {
                        boardsDirs.push(path.join(platformsDir, plat.name, 'boards'));
                    }
                }
            } catch {
                // ignore
            }
        }
    }

    for (const dir of boardsDirs) {
        const boardJson = path.join(dir, boardName + '.json');
        if (fs.existsSync(boardJson)) {
            try {
                const data = JSON.parse(fs.readFileSync(boardJson, 'utf8'));
                const mcu = data?.build?.mcu;
                if (typeof mcu === 'string' && mcu) {
                    return mcu;
                }
            } catch {
                // ignore parse errors
            }
        }
    }

    return undefined;
}

function getChipName(boardName: string | undefined, workspaceFolder?: string, coreDir?: string): string | undefined {
    if (!boardName) {
        return undefined;
    }

    const mcu = readBoardMcu(boardName, workspaceFolder, coreDir);
    if (mcu) {
        const mcuNorm = mcu.toLowerCase().replace(/[-_]/g, '');
        for (const key of KNOWN_CHIPS) {
            if (mcuNorm.includes(key)) {
                return key;
            }
        }
    }

    const nameNorm = boardName.toLowerCase().replace(/[-_]/g, '');
    for (const key of KNOWN_CHIPS) {
        if (nameNorm.includes(key)) {
            return key;
        }
    }

    return undefined;
}

export function findRomElf(packagesDir: string, chipName: string): string | undefined {
    const romElfsDir = path.join(packagesDir, 'tool-esp-rom-elfs');
    if (!fs.existsSync(romElfsDir)) {
        return undefined;
    }

    try {
        const entries = fs.readdirSync(romElfsDir);
        // Patterns are in priority order: the first group with any match wins,
        // so a loose fallback cannot displace an exact `_revN` file.
        const patterns = [
            new RegExp(`^${chipName}_rev\\d+_rom\\.elf$`),
            new RegExp(`^${chipName}_rev\\d+\\.elf$`),
            new RegExp(`^${chipName}.*_rom\\.elf$`),
            new RegExp(`^${chipName}.*\\.elf$`),
        ];

        for (const pattern of patterns) {
            const matches = entries.filter((entry) => pattern.test(entry));
            if (matches.length === 0) {
                continue;
            }
            matches.sort((a, b) => {
                const revA = a.match(/_rev(\d+)/);
                const revB = b.match(/_rev(\d+)/);
                return (revA ? parseInt(revA[1]) : 1e9) - (revB ? parseInt(revB[1]) : 1e9);
            });
            return path.join(romElfsDir, matches[0]);
        }
        return undefined;
    } catch {
        return undefined;
    }
}

const XTENSA_GDB_NAMES = [
    'xtensa-esp-elf-gdb',
    'xtensa-esp32-elf-gdb',
    'xtensa-esp32s3-elf-gdb',
    'xtensa-esp32s2-elf-gdb',
    'xtensa-lx106-elf-gdb',
];

function listPackageDirs(packagesDir: string, pattern: RegExp): string[] {
    try {
        return fs
            .readdirSync(packagesDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && pattern.test(d.name))
            .map((d) => d.name)
            .sort((a, b) => {
                const aGdb = a.includes('gdb') ? 0 : 1;
                const bGdb = b.includes('gdb') ? 0 : 1;
                return aGdb - bGdb || a.localeCompare(b);
            });
    } catch {
        return [];
    }
}

export function findPioGdbToolPath(
    packagesDir: string,
    arch: ChipArch,
    chipName?: string,
): string | undefined {
    const ext = process.platform === 'win32' ? '.exe' : '';

    let pkgDirs: string[] = [];
    const preferredNames: string[] = [];
    let genericNames: string[] = [];
    let chipPrefix: string | undefined;
    const isEsp8266 = chipName?.toLowerCase() === 'esp8266';

    if (arch === 'riscv') {
        pkgDirs = listPackageDirs(packagesDir, /riscv32/);
        genericNames = [`riscv32-esp-elf-gdb${ext}`];
    } else {
        pkgDirs = listPackageDirs(packagesDir, /^(tool|toolchain)-xtensa/);
        const chipHint = isEsp8266 ? 'lx106' : chipName;
        if (chipHint) {
            preferredNames.push(`xtensa-${chipHint}-elf-gdb${ext}`);
            chipPrefix = `xtensa-${chipHint}-`;
        }
        genericNames = XTENSA_GDB_NAMES
            .filter((name) => isEsp8266 || name !== 'xtensa-lx106-elf-gdb')
            .map((n) => n + ext);
    }

    for (const name of preferredNames) {
        if (!isEsp8266 && /^xtensa-lx106-elf-gdb(?:\.exe)?$/i.test(name)) {
            continue;
        }
        for (const pkgDir of pkgDirs) {
            const candidate = path.join(packagesDir, pkgDir, 'bin', name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    for (const pkgDir of pkgDirs) {
        const binDir = path.join(packagesDir, pkgDir, 'bin');
        for (const name of genericNames) {
            const candidate = path.join(binDir, name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    const gdbPattern = arch === 'riscv'
        ? /^riscv32-.*-elf-gdb(\.exe)?$/
        : /^xtensa-.*-elf-gdb(\.exe)?$/;
    const scan = (predicate: (entry: string) => boolean): string | undefined => {
        for (const pkgDir of pkgDirs) {
            const binDir = path.join(packagesDir, pkgDir, 'bin');
            try {
                for (const entry of fs.readdirSync(binDir)) {
                    if (predicate(entry)) {
                        return path.join(binDir, entry);
                    }
                }
            } catch {
                // bin dir missing or unreadable
            }
        }
        return undefined;
    };

    const allowedGdb = (entry: string): boolean =>
        gdbPattern.test(entry) && (isEsp8266 || !/^xtensa-lx106-elf-gdb(?:\.exe)?$/i.test(entry));

    if (chipPrefix) {
        const chipMatch = scan((entry) => entry.startsWith(chipPrefix) && allowedGdb(entry));
        if (chipMatch) {
            return chipMatch;
        }
    }
    return scan(allowedGdb);
}

function whereIsProgram(name: string): string | undefined {
    try {
        return pioProc.whereIsProgram(name) || undefined;
    } catch {
        return undefined;
    }
}

function deriveAddr2linePathFromGdb(gdbPath: string | undefined): string | undefined {
    if (!gdbPath) {
        return undefined;
    }
    const dir = path.dirname(gdbPath);
    const base = path.basename(gdbPath);
    const match = base.match(/^(.*)-gdb(\.exe)?$/i);
    if (!match) {
        return undefined;
    }
    const candidate = path.join(dir, `${match[1]}-addr2line${match[2] ?? ''}`);
    return fs.existsSync(candidate) ? candidate : undefined;
}

function addr2lineToolNames(arch: ChipArch): string[] {
    const ext = process.platform === 'win32' ? '.exe' : '';
    if (arch === 'riscv') {
        return [
            `riscv32-esp-elf-addr2line${ext}`,
            `riscv32-unknown-elf-addr2line${ext}`,
        ];
    }
    return [
        `xtensa-esp-elf-addr2line${ext}`,
        `xtensa-esp32-elf-addr2line${ext}`,
        `xtensa-esp32s3-elf-addr2line${ext}`,
    ];
}

export function findPioAddr2linePath(
    packagesDir: string | undefined,
    arch: ChipArch,
    gdbPath?: string,
): string | undefined {
    const derived = deriveAddr2linePathFromGdb(gdbPath);
    if (derived) {
        return derived;
    }

    if (packagesDir) {
        const pkgDirs = listPackageDirs(
            packagesDir,
            arch === 'riscv' ? /riscv32/ : /^(tool|toolchain)-xtensa/
        );
        const preferred = addr2lineToolNames(arch);
        for (const pkgDir of pkgDirs) {
            const binDir = path.join(packagesDir, pkgDir, 'bin');
            for (const name of preferred) {
                const candidate = path.join(binDir, name);
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }

        const addr2linePattern = arch === 'riscv'
            ? /^(riscv32-.*-addr2line|addr2line)(\.exe)?$/
            : /^(xtensa-.*-addr2line|addr2line)(\.exe)?$/;
        for (const pkgDir of pkgDirs) {
            const binDir = path.join(packagesDir, pkgDir, 'bin');
            try {
                const match = fs.readdirSync(binDir)
                    .filter((entry) => addr2linePattern.test(entry))
                    .sort()[0];
                if (match) {
                    return path.join(binDir, match);
                }
            } catch {
                // ignore
            }
        }
    }

    for (const name of addr2lineToolNames(arch)) {
        const found = whereIsProgram(name);
        if (found) {
            return found;
        }
    }
    return whereIsProgram('addr2line');
}

export function findPioOpenOcdPath(packagesDir: string | undefined): string | undefined {
    const ext = process.platform === 'win32' ? '.exe' : '';
    if (packagesDir) {
        const preferred = [
            path.join(packagesDir, 'tool-openocd-esp32', 'bin', `openocd${ext}`),
            path.join(packagesDir, 'tool-openocd-esp32', 'bin', 'openocd'),
        ];
        for (const candidate of preferred) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        const pkgDirs = listPackageDirs(packagesDir, /openocd/);
        for (const pkgDir of pkgDirs) {
            const binDir = path.join(packagesDir, pkgDir, 'bin');
            for (const name of [`openocd${ext}`, 'openocd']) {
                const candidate = path.join(binDir, name);
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    }
    return whereIsProgram(`openocd${ext}`) ?? whereIsProgram('openocd');
}

export async function findPioElfCandidates(
    workspaceFolder: string,
    options: { usePlatformIOConfig?: boolean; buildDir?: string } = {}
): Promise<PioElfCandidate[]> {
    const candidates: PioElfCandidate[] = [];
    const sections = ini.readPlatformioSections(workspaceFolder);
    if (!sections) {
        return candidates;
    }

    const parsedEnvs = ini.parseEnvironments(sections);
    const parsedEnvMap = new Map(parsedEnvs.map((e) => [e.name, e]));
    const coreDir = sections['platformio']?.['core_dir']
        ? ini.normalizePioPath(sections['platformio']['core_dir'], workspaceFolder)
        : undefined;
    const projectName = ini.getProjectName(workspaceFolder, sections);
    const pioBuildDir = options.buildDir
        ? resolvePathFromWorkspace(workspaceFolder, options.buildDir)
        : await ini.resolveBuildDir(workspaceFolder, sections, {
        resolvePlatformIOBuildDir: options.usePlatformIOConfig ? resolveBuildDirWithPlatformIO : undefined,
    });

    if (!pioBuildDir || !fs.existsSync(pioBuildDir)) {
        return candidates;
    }

    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(pioBuildDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return candidates;
    }

    for (const entry of entries) {
        const envName = entry.name;
        const envBuildDir = path.join(pioBuildDir, envName);
        const elfFiles = ini.findElfFilesInDir(envBuildDir, projectName);
        if (elfFiles.length === 0) {
            continue;
        }

        const parsed = parsedEnvMap.get(envName);
        const board = parsed?.board;
        const chip = getChipName(board || envName, workspaceFolder, coreDir);

        for (let i = 0; i < elfFiles.length; i++) {
            const elfPath = elfFiles[i];
            const elfName = path.basename(elfPath, '.elf');
            const elfArch = detectElfArch(elfPath);
            const targetArch = elfArch ?? (chip ? chipArch(chip) : undefined);
            candidates.push({
                environmentName: envName,
                name: i === 0 ? envName : `${envName}:${elfName}`,
                elfPath,
                board,
                platform: parsed?.platform,
                chip,
                targetArch,
            });
        }
    }

    return candidates;
}

function resolvePathFromWorkspace(workspaceFolder: string, value: string): string {
    return path.isAbsolute(value) ? value : path.resolve(workspaceFolder, value);
}

function pathsEqual(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    return path.normalize(a) === path.normalize(b);
}

function envNameFromElfPath(buildDir: string | undefined, elfPath: string | undefined): string | undefined {
    if (!buildDir || !elfPath) {
        return undefined;
    }
    const relative = path.relative(buildDir, elfPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return undefined;
    }
    const [envName] = relative.split(path.sep);
    return envName || undefined;
}

function selectPioCandidate(
    candidates: PioElfCandidate[],
    options: ResolveTraceContextOptions,
    elfPath: string | undefined,
    buildDir: string | undefined,
): PioElfCandidate | undefined {
    const requestedEnv = options.projectEnvName ?? options.envName ?? envNameFromElfPath(buildDir, elfPath);
    let pool = candidates;

    if (requestedEnv) {
        pool = pool.filter((candidate) => candidate.environmentName === requestedEnv);
    }

    if (elfPath) {
        const exact = pool.find((candidate) => pathsEqual(candidate.elfPath, elfPath));
        if (exact) {
            return exact;
        }
        const sameEnv = pool.filter((candidate) => candidate.environmentName === requestedEnv);
        if (sameEnv.length > 0) {
            return sameEnv[0];
        }
    }

    // A lone candidate is only trustworthy when nothing pinned the choice: an
    // explicit ELF outside the build dir must not adopt an unrelated env's ELF.
    // An env-filtered pool is fine because requestedEnv already scoped it.
    if (pool.length === 1 && (!elfPath || requestedEnv !== undefined)) {
        return pool[0];
    }

    return undefined;
}

export async function resolveTraceContext(
    options: ResolveTraceContextOptions
): Promise<TraceContext> {
    const warnings: string[] = [];
    const workspaceFolder = options.workspaceFolder;
    const sections = ini.readPlatformioSections(workspaceFolder);

    const configuredCoreDir = sections?.['platformio']?.['core_dir']
        ? ini.normalizePioPath(sections['platformio']['core_dir'], workspaceFolder)
        : undefined;
    const coreDir = options.coreDir ?? configuredCoreDir ?? getPioCoreDir();
    const packagesDir = options.packagesDir ?? getPioPackagesDir(coreDir);

    const buildDir = options.buildDir
        ? resolvePathFromWorkspace(workspaceFolder, options.buildDir)
        : (sections
        ? await ini.resolveBuildDir(workspaceFolder, sections, {
            resolvePlatformIOBuildDir: options.usePlatformIOConfig ? resolveBuildDirWithPlatformIO : undefined,
        })
        : undefined);

    const candidates = await findPioElfCandidates(workspaceFolder, {
        usePlatformIOConfig: options.usePlatformIOConfig,
        buildDir,
    });

    const requestedElf = options.elfPath ?? options.executable;
    const resolvedElf = requestedElf ? resolvePathFromWorkspace(workspaceFolder, requestedElf) : undefined;
    const candidate = selectPioCandidate(candidates, options, resolvedElf, buildDir);

    let effectiveBuildDir = buildDir;
    let elfPath = resolvedElf ?? candidate?.elfPath;
    let chip = options.chip;
    let idfPath: string | undefined = process.env.IDF_PATH?.trim() || undefined;
    let idfToolsDir: string | undefined;

    const useIdfFallback = !sections || (!elfPath && !candidate);
    const hasConfiguredPioBuildDir = Boolean(
        options.buildDir ||
        sections?.['platformio']?.['build_dir'] ||
        sections?.['platformio']?.['workspace_dir']
    );
    const idfBuildDir = hasConfiguredPioBuildDir ? buildDir : undefined;
    if (useIdfFallback && isEspIdfWorkspace(workspaceFolder, idfBuildDir)) {
        const idfCtx = resolveEspIdfContext(workspaceFolder, {
            buildDir: idfBuildDir,
            elfPath,
            chip,
        });
        effectiveBuildDir = idfCtx.buildDir;
        elfPath = elfPath ?? idfCtx.elfPath;
        chip = chip ?? idfCtx.chip;
        idfPath = idfCtx.idfPath ?? idfPath;
        idfToolsDir = idfCtx.toolsDir;
    }

    if (requestedElf && resolvedElf && !fs.existsSync(resolvedElf)) {
        warnings.push(`ELF path does not exist: ${resolvedElf}`);
    }
    if (!elfPath) {
        warnings.push('No firmware ELF found for trace decoding.');
    }

    // options.chip wins. Otherwise the chip must describe the ELF actually
    // used: an explicit ELF may belong to a different env than the selected
    // candidate, so match candidates by path regardless of requested env.
    if (chip === undefined && elfPath) {
        const elfCandidate = candidates.find((c) => pathsEqual(c.elfPath, elfPath));
        chip = elfCandidate?.chip;
        if (chip === undefined) {
            const envName =
                envNameFromElfPath(effectiveBuildDir, elfPath) ??
                path.basename(elfPath, path.extname(elfPath));
            chip = getChipName(envName, workspaceFolder, coreDir);
        }
    }
    const targetArch = options.targetArch
        ?? (elfPath ? detectElfArch(elfPath) : undefined)
        ?? (chip ? chipArch(chip) : candidate?.targetArch);

    if (targetArch === 'xtensa') {
        warnings.push('Trace decoding requires a RISC-V target; Xtensa firmware is not supported.');
    } else if (!targetArch) {
        warnings.push('Could not determine target architecture from ELF or board.');
    }

    if (chip && !isTraceSupportedChip(chip)) {
        warnings.push(`Chip '${chip}' is not in the supported trace chip list.`);
    }

    const context: TraceContext = {
        workspaceFolder,
        elfPath,
        chip,
        targetArch,
        packagesDir,
        coreDir,
        buildDir: effectiveBuildDir,
        idfPath,
        warnings,
    };

    if (targetArch === 'xtensa') {
        return context;
    }

    const toolsDir = idfToolsDir ?? getIdfToolsDir();
    const toolArch: ChipArch = 'riscv';
    context.gdbPath = options.gdbPath
        ?? (packagesDir ? findPioGdbToolPath(packagesDir, toolArch, chip) : undefined)
        ?? findIdfGdbPath(toolsDir, toolArch)
        ?? whereIsProgram('riscv32-esp-elf-gdb');
    context.addr2linePath = options.addr2linePath
        ?? findPioAddr2linePath(packagesDir, toolArch, context.gdbPath)
        ?? findIdfAddr2linePath(toolsDir, toolArch);
    context.openocdPath = options.openocdPath
        ?? findPioOpenOcdPath(packagesDir)
        ?? findIdfOpenOcdPath(toolsDir);
    context.romElfPath = options.romElfPath
        ?? (packagesDir && chip ? findRomElf(packagesDir, chip) : undefined)
        ?? (chip ? findIdfRomElfPath(toolsDir, chip) : undefined);

    if (!context.gdbPath) {
        warnings.push('RISC-V GDB was not found in PlatformIO/ESP-IDF tools or PATH.');
    }
    if (!context.addr2linePath) {
        warnings.push('addr2line was not found in the RISC-V toolchain.');
    }
    if (!context.openocdPath) {
        warnings.push('OpenOCD was not found in PlatformIO/ESP-IDF tools or PATH.');
    }
    if (chip && !context.romElfPath) {
        warnings.push(`ROM ELF for chip '${chip}' was not found.`);
    }

    return context;
}
