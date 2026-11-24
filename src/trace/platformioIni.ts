import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Sections = Record<string, Record<string, string>>;

export interface ParsedEnv {
    name: string;
    board: string;
    platform: string;
}

export type BuildDirResolver = (workspaceFolder: string) => Promise<string | undefined>;

/** Minimal INI parser for platformio.ini (handles multi-line values). */
export function parsePlatformioIni(content: string): Sections {
    const sections: Sections = {};
    let currentSection: string | undefined;
    let lastKey: string | undefined;
    const lines = content.split(/\r?\n/);

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
            continue;
        }
        const sectionMatch = trimmed.match(/^\[(.+)\]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1].trim();
            sections[currentSection] = sections[currentSection] ?? {};
            lastKey = undefined;
            continue;
        }
        if (currentSection) {
            if (lastKey && /^\s/.test(rawLine) && !/^\S/.test(rawLine)) {
                sections[currentSection][lastKey] += '\n' + trimmed;
                continue;
            }
            const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
            if (kvMatch) {
                const key = kvMatch[1].trim();
                const value = kvMatch[2].trim();
                sections[currentSection][key] = value;
                lastKey = key;
            }
        }
    }
    return sections;
}

function mergeSections(target: Sections, source: Sections): void {
    for (const [sectionName, props] of Object.entries(source)) {
        if (!target[sectionName]) {
            target[sectionName] = {};
        }
        Object.assign(target[sectionName], props);
    }
}

function globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const withWildcards = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${withWildcards}$`);
}

function isGlobPattern(value: string): boolean {
    return /[*?\[\]]/.test(value);
}

function resolveExtraConfigPaths(projectPath: string, rawEntries: string[]): string[] {
    const resolved: string[] = [];
    for (const entry of rawEntries) {
        if (!entry) {
            continue;
        }
        if (isGlobPattern(entry)) {
            const globDir = path.resolve(projectPath, path.dirname(entry));
            const globBase = path.basename(entry);
            const regex = globToRegex(globBase);
            try {
                const dirEntries = fs.readdirSync(globDir);
                for (const name of dirEntries.sort()) {
                    if (regex.test(name)) {
                        resolved.push(path.join(globDir, name));
                    }
                }
            } catch {
                // ignore
            }
        } else {
            resolved.push(path.resolve(projectPath, entry));
        }
    }
    return resolved;
}

function parseExtraConfigsValue(value: string): string[] {
    return value
        .split(/\n/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function mergeExtraConfigs(projectPath: string, sections: Sections): void {
    const pioSection = sections['platformio'];
    if (!pioSection?.['extra_configs']) {
        return;
    }

    const rawEntries = parseExtraConfigsValue(pioSection['extra_configs']);
    const configPaths = resolveExtraConfigPaths(projectPath, rawEntries);

    for (const configPath of configPaths) {
        try {
            const content = fs.readFileSync(configPath, 'utf8');
            const extraSections = parsePlatformioIni(content);
            mergeSections(sections, extraSections);
        } catch {
            // ignore
        }
    }
}

const MAX_INTERPOLATION_DEPTH = 10;

function interpolateVariables(sections: Sections): void {
    const variablePattern = /\$\{([^}]+)\}/g;

    function resolve(value: string, depth: number, visited: Set<string>): string {
        if (depth > MAX_INTERPOLATION_DEPTH) {
            return value;
        }
        return value.replace(variablePattern, (match, ref: string) => {
            const dotIndex = ref.indexOf('.');
            if (dotIndex < 0) {
                return match;
            }
            const sectionName = ref.slice(0, dotIndex);
            const keyName = ref.slice(dotIndex + 1);
            const refKey = `${sectionName}.${keyName}`;
            if (visited.has(refKey)) {
                return match;
            }
            const section = sections[sectionName];
            if (!section || !(keyName in section)) {
                return match;
            }
            visited.add(refKey);
            return resolve(section[keyName], depth + 1, new Set(visited));
        });
    }

    for (const props of Object.values(sections)) {
        for (const [key, value] of Object.entries(props)) {
            if (value.includes('${')) {
                props[key] = resolve(value, 0, new Set());
            }
        }
    }
}

function resolveExtends(
    sectionName: string,
    sections: Sections,
    visited = new Set<string>()
): Record<string, string> {
    if (visited.has(sectionName)) {
        return {};
    }
    visited.add(sectionName);

    const section = sections[sectionName];
    if (!section) {
        return {};
    }

    let result: Record<string, string> = {};
    const extendsValue = section['extends'];
    if (extendsValue) {
        const parents = extendsValue.split(',').map((s) => s.trim());
        for (const parent of parents) {
            result = { ...result, ...resolveExtends(parent, sections, visited) };
        }
    }
    return { ...result, ...section };
}

export function parseEnvironments(sections: Sections): ParsedEnv[] {
    const baseEnv = sections['env'] ?? {};
    const envs: ParsedEnv[] = [];
    let hasNamedEnvs = false;

    for (const [sectionName] of Object.entries(sections)) {
        if (!sectionName.startsWith('env:')) {
            continue;
        }
        hasNamedEnvs = true;
        const envName = sectionName.slice(4);
        const resolved = resolveExtends(sectionName, sections);
        const merged = { ...baseEnv, ...resolved };
        const platform = merged['platform'] ?? '';
        const board = merged['board'] ?? '';
        if (!board) {
            continue;
        }
        envs.push({ name: envName, platform, board });
    }

    if (!hasNamedEnvs && baseEnv['board']) {
        envs.push({
            name: 'default',
            platform: baseEnv['platform'] ?? '',
            board: baseEnv['board'],
        });
    }

    return envs;
}

export function normalizePioPath(value: string, workspaceFolder: string): string {
    let expanded = value.replace(/\$\{sysenv\.([^}]+)\}/g, (_: string, varName: string) =>
        process.env[varName] ?? ''
    );

    expanded = expanded.replace(/\$\{PROJECT_DIR\}/g, workspaceFolder);

    if (expanded.startsWith('~')) {
        expanded = os.homedir() + expanded.slice(1);
    }

    return path.resolve(workspaceFolder, expanded);
}

export function expandPioPath(value: string | undefined, workspaceFolder: string): string | undefined {
    if (!value) {
        return undefined;
    }

    const resolved = normalizePioPath(value, workspaceFolder);
    return fs.existsSync(resolved) ? resolved : undefined;
}

export function findElfFilesInDir(dir: string, projectName?: string): string[] {
    if (!fs.existsSync(dir)) {
        return [];
    }

    const excluded = new Set(['bootloader.elf', 'partition-table.elf']);
    const candidates: string[] = [];

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.elf')) {
                continue;
            }
            if (excluded.has(entry.name)) {
                continue;
            }
            candidates.push(path.join(dir, entry.name));
        }
    } catch {
        return [];
    }

    candidates.sort((a, b) => {
        const aName = path.basename(a);
        const bName = path.basename(b);

        if (aName === 'firmware.elf') return -1;
        if (bName === 'firmware.elf') return 1;

        if (projectName) {
            if (aName === `${projectName}.elf`) return -1;
            if (bName === `${projectName}.elf`) return 1;
        }

        return aName.localeCompare(bName);
    });

    return candidates;
}

export function getProjectName(workspaceFolder: string, sections?: Sections): string | undefined {
    if (sections) {
        return sections['platformio']?.['name'];
    }

    const platformIniPath = path.join(workspaceFolder, 'platformio.ini');
    if (!fs.existsSync(platformIniPath)) {
        return undefined;
    }

    try {
        const content = fs.readFileSync(platformIniPath, 'utf8');
        const parsedSections = parsePlatformioIni(content);
        return parsedSections['platformio']?.['name'];
    } catch {
        return undefined;
    }
}

export async function resolveBuildDir(
    workspaceFolder: string,
    sections: Sections,
    options: { resolvePlatformIOBuildDir?: BuildDirResolver } = {}
): Promise<string | undefined> {
    const buildDirValue = sections['platformio']?.['build_dir'];
    const workspaceDirValue = sections['platformio']?.['workspace_dir'];

    const selectedBuildPathValue = buildDirValue || workspaceDirValue;
    if (selectedBuildPathValue && /\$(?:PROJECT_HASH|\{PROJECT_HASH\})/.test(selectedBuildPathValue)) {
        if (options.resolvePlatformIOBuildDir) {
            try {
                const resolved = await options.resolvePlatformIOBuildDir(workspaceFolder);
                if (typeof resolved === 'string' && resolved) {
                    return path.isAbsolute(resolved) ? resolved : path.resolve(workspaceFolder, resolved);
                }
            } catch {
                // Do not guess a path when PlatformIO cannot expand its variables.
            }
        }
        return undefined;
    }

    if (buildDirValue) {
        return normalizePioPath(buildDirValue, workspaceFolder);
    }

    if (workspaceDirValue) {
        return path.join(normalizePioPath(workspaceDirValue, workspaceFolder), 'build');
    }

    return path.join(workspaceFolder, '.pio', 'build');
}

export function readPlatformioSections(workspaceFolder: string): Sections | undefined {
    const platformIniPath = path.join(workspaceFolder, 'platformio.ini');
    if (!fs.existsSync(platformIniPath)) {
        return undefined;
    }

    const content = fs.readFileSync(platformIniPath, 'utf8');
    const sections = parsePlatformioIni(content);
    mergeExtraConfigs(workspaceFolder, sections);
    const platformio = sections['platformio'] ?? (sections['platformio'] = {});
    if (process.env.PLATFORMIO_WORKSPACE_DIR) {
        platformio['workspace_dir'] = process.env.PLATFORMIO_WORKSPACE_DIR;
    }
    if (process.env.PLATFORMIO_BUILD_DIR) {
        platformio['build_dir'] = process.env.PLATFORMIO_BUILD_DIR;
    }
    interpolateVariables(sections);
    return sections;
}

export async function getPioBuildDir(
    workspaceFolder: string,
    options: { resolvePlatformIOBuildDir?: BuildDirResolver } = {}
): Promise<string | undefined> {
    const sections = readPlatformioSections(workspaceFolder);
    if (!sections) {
        return undefined;
    }
    return await resolveBuildDir(workspaceFolder, sections, options);
}
