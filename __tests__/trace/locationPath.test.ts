import * as path from 'path';
import { isSyntheticSourcePath, resolveSourceFilePath } from '../../src/trace/elf/locationPath';

describe('locationPath', () => {
    test('isSyntheticSourcePath identifies non-file markers', () => {
        expect(isSyntheticSourcePath('')).toBe(true);
        expect(isSyntheticSourcePath('??')).toBe(true);
        expect(isSyntheticSourcePath('<unresolved>')).toBe(true);
        expect(isSyntheticSourcePath('<built-in>')).toBe(true);
        expect(isSyntheticSourcePath('src/main.c')).toBe(false);
    });

    test('resolveSourceFilePath finds existing absolute and relative paths', () => {
        const existing = new Set([
            '/ws/src/main.c',
            path.resolve('/ws', 'components/foo/bar.c'),
        ]);
        const exists = (p: string) => existing.has(p);

        expect(resolveSourceFilePath('/ws/src/main.c', ['/ws'], exists)).toBe('/ws/src/main.c');
        expect(resolveSourceFilePath('components\\foo\\bar.c', ['/ws'], exists)).toBe(
            path.resolve('/ws', 'components/foo/bar.c')
        );
    });

    test('resolveSourceFilePath strips foreign build-machine prefix to src/', () => {
        const expected = path.resolve('/ws', 'src/app.c');
        const exists = (p: string) => p === expected;

        expect(resolveSourceFilePath('C:\\Users\\ci\\project\\src\\app.c', ['/ws'], exists)).toBe(expected);
        expect(resolveSourceFilePath('??', ['/ws'], exists)).toBeUndefined();
        expect(resolveSourceFilePath('/missing/file.c', ['/ws'], exists)).toBeUndefined();
    });

    test('resolveSourceFilePath prefers longest matching suffix when multiple files exist', () => {
        const specific = path.resolve('/ws', 'components/net/src/app.c');
        const generic = path.resolve('/ws', 'src/app.c');
        const exists = (p: string) => p === specific || p === generic;

        expect(resolveSourceFilePath('/build/components/net/src/app.c', ['/ws'], exists)).toBe(specific);
    });
});
