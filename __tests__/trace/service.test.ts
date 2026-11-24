import { TraceService } from '../../src/trace/service';
import { resolveTraceContext } from '../../src/trace/pioToolchain';
import { TraceContext } from '../../src/trace/types';

jest.mock('../../src/trace/pioToolchain', () => ({
    resolveTraceContext: jest.fn(),
}));

const mockedResolve = resolveTraceContext as jest.MockedFunction<typeof resolveTraceContext>;

const fakeContext = { elfPath: '/tmp/f.elf', warnings: [] } as unknown as TraceContext;

describe('TraceService', () => {
    beforeEach(() => {
        mockedResolve.mockReset();
        mockedResolve.mockResolvedValue(fakeContext);
    });

    test('resolveContext delegates to resolveTraceContext', async () => {
        const service = new TraceService();
        const options = { workspaceFolder: '/ws' };
        const result = await service.resolveContext(options as any);
        expect(result).toBe(fakeContext);
        expect(mockedResolve).toHaveBeenCalledWith({ workspaceFolder: '/ws' });
    });

    test('default options merge under call options', async () => {
        const service = new TraceService({ chip: 'esp32c6', elfPath: '/default.elf' });
        await service.resolveContext({ workspaceFolder: '/ws', chip: 'esp32c5' } as any);
        expect(mockedResolve).toHaveBeenCalledWith({
            chip: 'esp32c5',
            elfPath: '/default.elf',
            workspaceFolder: '/ws',
        });
    });
});
