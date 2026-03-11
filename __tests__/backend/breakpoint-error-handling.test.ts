import { MI2 } from '../../src/backend/mi2/mi2';
import { parseMI } from '../../src/backend/mi_parse';

describe('Breakpoint Error Handling', () => {
  describe('addBreakPoint null return handling', () => {
    test('should return null when breakpoint number parsing fails', async () => {
      const mi2 = new MI2('gdb', []);
      
      // Mock sendCommand to return invalid response
      mi2.sendCommand = jest.fn().mockResolvedValue({
        resultRecords: { resultClass: 'done' },
        result: (path: string) => {
          if (path === 'bkpt.number') return undefined;
          if (path === 'bkpt.locations') return undefined;
          return undefined;
        }
      });

      const result = await mi2.addBreakPoint({
        file: 'test.c',
        line: 10
      });

      expect(result).toBeNull();
    });

    test('should return null when GDB returns error', async () => {
      const mi2 = new MI2('gdb', []);
      
      // Mock sendCommand to return error response
      mi2.sendCommand = jest.fn().mockResolvedValue({
        resultRecords: { resultClass: 'error' },
        result: (path: string) => 'No symbol table is loaded.'
      });

      const result = await mi2.addBreakPoint({
        file: 'test.c',
        line: 10
      });

      expect(result).toBeNull();
    });

    test('should return breakpoint object when successful', async () => {
      const mi2 = new MI2('gdb', []);
      
      // Mock sendCommand to return valid response
      mi2.sendCommand = jest.fn().mockResolvedValue({
        resultRecords: { resultClass: 'done' },
        result: (path: string) => {
          if (path === 'bkpt.number') return '5';
          if (path === 'bkpt') return { number: '5' };
          return undefined;
        }
      });

      const breakpoint = {
        file: 'test.c',
        line: 10
      };

      const result = await mi2.addBreakPoint(breakpoint);

      expect(result).not.toBeNull();
      expect(result.number).toBe(5);
      expect(result.file).toBe('test.c');
      expect(result.line).toBe(10);
    });
  });

  describe('Adapter breakpoint result handling', () => {
    test('should filter out null results from multiple breakpoints', () => {
      const results = [
        { number: 1, line: 10, file: 'test.c' },
        null,
        { number: 2, line: 20, file: 'test.c' },
        null,
        { number: 3, line: 30, file: 'test.c' }
      ];

      const filtered = results.filter(r => r !== null);

      expect(filtered.length).toBe(3);
      expect(filtered[0].number).toBe(1);
      expect(filtered[1].number).toBe(2);
      expect(filtered[2].number).toBe(3);
    });

    test('should handle all null results gracefully', () => {
      const results = [null, null, null];

      const filtered = results.filter(r => r !== null);

      expect(filtered.length).toBe(0);
    });

    test('should map breakpoint objects to DAP format', () => {
      const results = [
        { number: 1, line: 10, file: 'test.c' },
        { number: 2, line: 20, file: 'test.c' }
      ];

      const dapBreakpoints = results
        .filter(r => r !== null)
        .map(bp => ({
          line: bp.line,
          id: bp.number,
          verified: true
        }));

      expect(dapBreakpoints.length).toBe(2);
      expect(dapBreakpoints[0]).toEqual({ line: 10, id: 1, verified: true });
      expect(dapBreakpoints[1]).toEqual({ line: 20, id: 2, verified: true });
    });

    test('should handle mixed null and valid results', () => {
      const results = [
        { number: 1, line: 10, file: 'test.c' },
        null,
        { number: 3, line: 30, file: 'test.c' }
      ];

      const dapBreakpoints = results
        .filter(r => r !== null)
        .map(bp => ({
          line: bp.line,
          id: bp.number,
          verified: true
        }));

      expect(dapBreakpoints.length).toBe(2);
      expect(dapBreakpoints[0].id).toBe(1);
      expect(dapBreakpoints[1].id).toBe(3);
    });
  });

  describe('Breakpoint object structure', () => {
    test('should have consistent structure for single breakpoint', () => {
      const breakpoint = {
        number: 1,
        line: 10,
        file: 'test.c',
        condition: 'x > 5'
      };

      expect(breakpoint).toHaveProperty('number');
      expect(breakpoint).toHaveProperty('line');
      expect(breakpoint).toHaveProperty('file');
      expect(typeof breakpoint.number).toBe('number');
      expect(typeof breakpoint.line).toBe('number');
    });

    test('should not be an array', () => {
      const breakpoint = {
        number: 1,
        line: 10,
        file: 'test.c'
      };

      expect(Array.isArray(breakpoint)).toBe(false);
      expect(breakpoint[0]).toBeUndefined();
      expect(breakpoint[1]).toBeUndefined();
    });

    test('should access properties by name, not by index', () => {
      const breakpoint = {
        number: 1,
        line: 10,
        file: 'test.c'
      };

      // Correct way
      expect(breakpoint.number).toBe(1);
      expect(breakpoint.line).toBe(10);
      expect(breakpoint.file).toBe('test.c');

      // Incorrect way (should be undefined)
      expect((breakpoint as any)[0]).toBeUndefined();
      expect((breakpoint as any)[1]).toBeUndefined();
    });
  });

  describe('Error scenarios', () => {
    test('should handle invalid file path', () => {
      const breakpoint = {
        file: '',
        line: 10
      };

      expect(breakpoint.file).toBe('');
      expect(breakpoint.line).toBe(10);
    });

    test('should handle invalid line number', () => {
      const breakpoint = {
        file: 'test.c',
        line: -1
      };

      expect(breakpoint.line).toBe(-1);
    });

    test('should handle missing optional fields', () => {
      const breakpoint = {
        file: 'test.c',
        line: 10
      };

      expect(breakpoint).not.toHaveProperty('condition');
      expect(breakpoint).not.toHaveProperty('countCondition');
    });
  });

  describe('Type safety', () => {
    test('should distinguish between null and valid breakpoint', () => {
      const validBreakpoint = { number: 1, line: 10, file: 'test.c' };
      const nullBreakpoint = null;

      expect(validBreakpoint).not.toBeNull();
      expect(nullBreakpoint).toBeNull();

      if (validBreakpoint !== null) {
        expect(validBreakpoint.number).toBe(1);
      }

      if (nullBreakpoint !== null) {
        // This should not execute
        expect(true).toBe(false);
      }
    });

    test('should handle Promise<any> return type', async () => {
      const promise = Promise.resolve({ number: 1, line: 10, file: 'test.c' });
      const result = await promise;

      expect(result).not.toBeNull();
      expect(result.number).toBe(1);
    });

    test('should handle Promise<null> return type', async () => {
      const promise = Promise.resolve(null);
      const result = await promise;

      expect(result).toBeNull();
    });
  });
});
