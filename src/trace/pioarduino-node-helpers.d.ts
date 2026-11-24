declare module 'pioarduino-node-helpers' {
    export const core: {
        getCoreDir(): string;
        getCoreState(): Record<string, any>;
        setCoreState(state: Record<string, any>): void;
        getCacheDir(): string;
        getTmpDir(): string;
        getEnvDir(): string;
        getEnvBinDir(): string;
        getCorePythonExe(): Promise<string>;
        getCorePythonCommandOutput(args: string[], options?: any): Promise<string>;
        getPIOCommandOutput(args: string[], options?: any): Promise<string>;
        runPIOCommand(args: string[], callback?: any, options?: any): void;
    };

    export const proc: {
        IS_WINDOWS: boolean;
        whereIsProgram(name: string): string | null;
        getCommandOutput(cmd: string, args: string[], options?: any): Promise<string>;
        runCommand(cmd: string, args: string[], callback?: any, options?: any): void;
        patchOSEnviron(options?: any): void;
        extendOSEnvironPath(name: string, items: string[], prepend?: boolean): void;
        terminateCmdsInQueue(): void;
        getSysType(): string;
    };

    export const project: {
        ProjectConfig: new (projectDir?: string) => any;
        ProjectPool: any;
        ProjectObserver: any;
        ProjectIndexer: any;
        ProjectTasks: any;
        TaskItem: any;
    };

    export const installer: {
        BaseStage: any;
        pioarduinoCoreStage: any;
        createVenvWithUv: any;
        ensurePipInPenv: any;
    };

    export const misc: any;
    export const home: any;
}
