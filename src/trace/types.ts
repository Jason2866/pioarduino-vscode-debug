export type TraceTargetArch = 'riscv' | 'xtensa';

export interface TraceContext {
    workspaceFolder: string;
    elfPath?: string;
    chip?: string;
    targetArch?: TraceTargetArch;
    packagesDir?: string;
    coreDir?: string;
    buildDir?: string;
    idfPath?: string;
    gdbPath?: string;
    addr2linePath?: string;
    openocdPath?: string;
    romElfPath?: string;
    warnings: string[];
}

export interface ResolveTraceContextOptions {
    workspaceFolder: string;
    executable?: string;
    projectEnvName?: string;
    envName?: string;
    elfPath?: string;
    chip?: string;
    targetArch?: TraceTargetArch;
    coreDir?: string;
    packagesDir?: string;
    buildDir?: string;
    gdbPath?: string;
    addr2linePath?: string;
    openocdPath?: string;
    romElfPath?: string;
    usePlatformIOConfig?: boolean;
}

export interface Addr2lineResult {
    address: string;
    function?: string;
    file?: string;
    line?: string;
}
