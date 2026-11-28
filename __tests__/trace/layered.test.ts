import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeImage, CodeReadError } from '../../src/trace/elf/image';
import { LayeredImage, LayeredResolver } from '../../src/trace/elf/layered';
import { SourceLocation, SourceResolver } from '../../src/trace/elf/resolver';
import { getRomElfPath, resolveRomElf, RomStatus } from '../../src/trace/elf/rom';

class FakeImage implements CodeImage {
    constructor(
        private readonly base = 0,
        private readonly data: Buffer = Buffer.alloc(0),
        private readonly symbols: Map<number, string> = new Map(),
        private readonly name = 'image'
    ) {}

    read(vaddr: number, size: number): Buffer {
        const off = vaddr - this.base;
        if (off < 0 || off + size > this.data.length) {
            throw new CodeReadError(`${this.name} 0x${vaddr.toString(16).padStart(8, '0')} out of range`);
        }
        return this.data.subarray(off, off + size);
    }

    symbolAt(vaddr: number): string | undefined {
        return this.symbols.get(vaddr);
    }
}

class FakeResolver implements SourceResolver {
    constructor(private readonly locs: Map<number, SourceLocation> = new Map()) {}

    resolve(pc: number): SourceLocation | undefined {
        return this.locs.get(pc);
    }
}

describe('LayeredImage', () => {
    test('read: app hit short-circuits ROM', () => {
        const app = new FakeImage(0x100, Buffer.from([0xaa, 0xbb]), new Map(), 'app');
        const rom = new FakeImage(0x100, Buffer.from([0xcc, 0xdd]), new Map(), 'rom');
        expect(new LayeredImage(app, rom).read(0x100, 2)).toEqual(Buffer.from([0xaa, 0xbb]));
    });

    test('read: app miss falls through to ROM', () => {
        const app = new FakeImage(0, Buffer.alloc(0), new Map(), 'app');
        const rom = new FakeImage(0x400, Buffer.from([0x11, 0x22]), new Map(), 'rom');
        expect(new LayeredImage(app, rom).read(0x400, 2)).toEqual(Buffer.from([0x11, 0x22]));
    });

    test('read: both miss raises the app error', () => {
        const layered = new LayeredImage(new FakeImage(0, Buffer.alloc(0), new Map(), 'app'), new FakeImage(0, Buffer.alloc(0), new Map(), 'rom'));
        expect(() => layered.read(0xdead, 2)).toThrow(CodeReadError);
        expect(() => layered.read(0xdead, 2)).toThrow(/app 0x0000dead out of range/);
    });

    test('read: no ROM raises the app error', () => {
        const layered = new LayeredImage(new FakeImage(0, Buffer.alloc(0), new Map(), 'app'));
        expect(() => layered.read(0x200, 2)).toThrow(/app 0x00000200 out of range/);
    });

    test('read: non-CodeReadError app errors propagate without ROM fallback', () => {
        class WeirdImage extends FakeImage {
            override read(): Buffer {
                throw new Error('boom');
            }
        }
        const layered = new LayeredImage(new WeirdImage(), new FakeImage(0, Buffer.from([1])));
        expect(() => layered.read(0, 1)).toThrow('boom');
    });

    test('symbolAt: app hit returns bare name', () => {
        const app = new FakeImage(0, Buffer.alloc(0), new Map([[0x100, 'app_foo']]));
        const rom = new FakeImage(0, Buffer.alloc(0), new Map([[0x100, 'rom_foo']]));
        expect(new LayeredImage(app, rom).symbolAt(0x100)).toBe('app_foo');
    });

    test('symbolAt: app miss falls through to ROM with rom: prefix', () => {
        const rom = new FakeImage(0, Buffer.alloc(0), new Map([[0x40000000, 'esp_rom_intr_disable']]));
        expect(new LayeredImage(new FakeImage(), rom).symbolAt(0x40000000)).toBe('rom:esp_rom_intr_disable');
    });

    test('symbolAt: both miss returns undefined', () => {
        expect(new LayeredImage(new FakeImage(), new FakeImage()).symbolAt(0xdead)).toBeUndefined();
    });

    test('symbolAt: no ROM returns undefined on app miss', () => {
        expect(new LayeredImage(new FakeImage()).symbolAt(0xdead)).toBeUndefined();
    });

    test('dataAt: delegates to the app image', () => {
        const app = new FakeImage();
        (app as any).dataAt = (vaddr: number) => (vaddr === 0x50 ? 'my_var' : undefined);
        const rom = new FakeImage();
        (rom as any).dataAt = () => 'rom_var';
        const layered = new LayeredImage(app, rom);
        expect(layered.dataAt?.(0x50)).toBe('my_var');
        expect(layered.dataAt?.(0x60)).toBeUndefined();
    });
});

describe('LayeredResolver', () => {
    test('app hit short-circuits ROM', () => {
        const app = new FakeResolver(new Map([[0x100, { file: 'a.c', line: 10 }]]));
        const rom = new FakeResolver(new Map([[0x100, { file: 'rom.c', line: 99 }]]));
        expect(new LayeredResolver(app, rom).resolve(0x100)).toEqual({ file: 'a.c', line: 10 });
    });

    test('app miss falls through to ROM', () => {
        const rom = new FakeResolver(new Map([[0x400, { file: 'rom.c', line: 5 }]]));
        expect(new LayeredResolver(new FakeResolver(), rom).resolve(0x400)).toEqual({ file: 'rom.c', line: 5 });
    });

    test('both miss returns undefined', () => {
        expect(new LayeredResolver(new FakeResolver(), new FakeResolver()).resolve(0xdead)).toBeUndefined();
    });

    test('no ROM returns undefined on app miss', () => {
        expect(new LayeredResolver(new FakeResolver()).resolve(0xdead)).toBeUndefined();
    });
});

describe('ROM ELF lookup', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-rom-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeRomsJson(revs: number[], subdir = 'components/esp_rom'): void {
        const dir = path.join(tmpDir, 'idf', subdir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'roms.json'),
            JSON.stringify({ esp32c5: revs.map((rev) => ({ rev })) })
        );
    }

    const env = (idfPath: string, romDir: string) =>
        ({ IDF_PATH: idfPath, ESP_ROM_ELF_DIR: romDir }) as NodeJS.ProcessEnv;

    test('missing env vars report MISSING_ENV', () => {
        expect(resolveRomElf('esp32c5', 100, { IDF_PATH: '', ESP_ROM_ELF_DIR: '/x' } as NodeJS.ProcessEnv)).toEqual([
            undefined,
            RomStatus.MISSING_ENV,
        ]);
        expect(resolveRomElf('esp32c5', 100, { IDF_PATH: '/x', ESP_ROM_ELF_DIR: '' } as NodeJS.ProcessEnv)).toEqual([
            undefined,
            RomStatus.MISSING_ENV,
        ]);
        expect(resolveRomElf('esp32c5', 100, {} as NodeJS.ProcessEnv)).toEqual([undefined, RomStatus.MISSING_ENV]);
    });

    test('no roms.json entry reports NOT_FOUND', () => {
        const romDir = path.join(tmpDir, 'roms');
        fs.mkdirSync(romDir, { recursive: true });
        const e = env(path.join(tmpDir, 'idf'), romDir);
        expect(resolveRomElf('esp32unknown', 0, e)).toEqual([undefined, RomStatus.NOT_FOUND]);
        expect(getRomElfPath('esp32unknown', 0, e)).toBeUndefined();
    });

    test('existing ROM file reports AUTO with the selected revision', () => {
        writeRomsJson([100, 200]);
        const romDir = path.join(tmpDir, 'roms');
        fs.mkdirSync(romDir, { recursive: true });
        const elfPath = path.join(romDir, 'esp32c5_rev200_rom.elf');
        fs.writeFileSync(elfPath, 'elf');
        const e = env(path.join(tmpDir, 'idf'), romDir);
        expect(resolveRomElf('esp32c5', 200, e)).toEqual([elfPath, RomStatus.AUTO]);
    });

    test('missing ROM file reports NOT_FOUND', () => {
        writeRomsJson([100]);
        const romDir = path.join(tmpDir, 'roms');
        fs.mkdirSync(romDir, { recursive: true });
        const e = env(path.join(tmpDir, 'idf'), romDir);
        expect(resolveRomElf('esp32c5', 100, e)).toEqual([undefined, RomStatus.NOT_FOUND]);
    });

    test('revision selection picks the greatest rev <= chipRev', () => {
        writeRomsJson([100, 200, 300]);
        const e = env(path.join(tmpDir, 'idf'), path.join(tmpDir, 'roms'));
        expect(getRomElfPath('esp32c5', 250, e)).toBe(
            path.join(tmpDir, 'roms', 'esp32c5_rev200_rom.elf')
        );
        expect(getRomElfPath('esp32c5', 100, e)).toBe(path.join(tmpDir, 'roms', 'esp32c5_rev100_rom.elf'));
        expect(getRomElfPath('esp32c5', 50, e)).toBeUndefined();
    });

    test('falls back to tools/idf_py_actions/roms.json', () => {
        writeRomsJson([105], 'tools/idf_py_actions');
        const e = env(path.join(tmpDir, 'idf'), path.join(tmpDir, 'roms'));
        expect(getRomElfPath('esp32c5', 105, e)).toBe(path.join(tmpDir, 'roms', 'esp32c5_rev105_rom.elf'));
    });

    test('non-integer and future revisions are ignored', () => {
        const dir = path.join(tmpDir, 'idf', 'components', 'esp_rom');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'roms.json'),
            JSON.stringify({ esp32c5: [{ rev: 100 }, { rev: 1.5 }, { rev: '200' }, { rev: 400 }] })
        );
        const e = env(path.join(tmpDir, 'idf'), path.join(tmpDir, 'roms'));
        expect(getRomElfPath('esp32c5', 150, e)).toBe(path.join(tmpDir, 'roms', 'esp32c5_rev100_rom.elf'));
    });
});
