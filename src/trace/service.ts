import { resolveTraceContext } from './pioToolchain';
import { ResolveTraceContextOptions, TraceContext } from './types';

/**
 * High-level entry point for ESP32 RISC-V trace operations.
 *
 * Decoder/container support is added incrementally; this class currently
 * owns trace-context resolution and will grow capture/decode APIs.
 */
export class TraceService {
    constructor(private readonly defaultOptions: Partial<ResolveTraceContextOptions> = {}) {}

    async resolveContext(options: ResolveTraceContextOptions): Promise<TraceContext> {
        return resolveTraceContext({ ...this.defaultOptions, ...options });
    }
}
