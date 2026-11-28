import * as traceIndex from '../../src/trace';

describe('trace index', () => {
    test('re-exports the public trace API surface', () => {
        expect(traceIndex.loadCapture).toBeDefined();
        expect(traceIndex.decodeEvents).toBeDefined();
        expect(traceIndex.parseNote).toBeDefined();
        expect(traceIndex.parseNoteHeader).toBeDefined();
        expect(traceIndex.enumName).toBeDefined();
        expect(traceIndex.TraceError).toBeDefined();
        expect(traceIndex.AbiError).toBeDefined();
        expect(traceIndex.NOTE_NAME).toBe('ESP_RISCV_TRACE');
    });
});
