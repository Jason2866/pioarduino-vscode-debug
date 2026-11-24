# ESP32 RISC-V Trace Decoder Implementation Plan

**Target Branch**: `esp32_trace`  
**Status**: Draft  
**Last Updated**: 2026-11-24

---

## 1. Objective

Implement the Espressif `esp-riscv-trace` feature set natively in TypeScript inside `pioarduino-vscode-debug`, without using Python at runtime.

The completed feature should support:

- Loading `.esptrace` captures produced by OpenOCD.
- Loading ESP core-dump ELF files containing the `ESP_RISCV_TRACE` note.
- Reconstructing executed instruction flow from hardware trace packets.
- Resolving PCs to functions, source files, and lines through the Espressif toolchain.
- Producing instruction dumps, diagnostics, statistics, call/return history, and profile output.
- Optional live capture control through the active PlatformIO/OpenOCD debug session.

## 2. Scope

### In scope

- Native TypeScript port of the decoder path from `esp-riscv-trace`.
- PlatformIO/pioarduino toolchain detection for ESP32 RISC-V targets.
- `addr2line`-based source resolution with optional GDB fallback.
- Minimal ELF parsing for executable code bytes, symbols, SHA-256, and core-file notes.
- VS Code commands and settings for inspecting and decoding captures.
- OpenOCD trace capture commands behind a spike-validated integration path.

### Out of scope for the first release

- Xtensa trace decoding. The upstream decoder targets ESP32 RISC-V trace hardware.
- Python CLI/API wrapping.
- A full webview UI. The first version can use an output channel and text documents.
- `analysis.origin` crash-causality reconstruction unless it is explicitly added later.
- ESP-IDF-specific integration beyond what can be reused from the copied PlatformIO/toolchain code.

## 3. Current State

This repository is a TypeScript VS Code debug adapter for PlatformIO/pioarduino. It wraps:

```text
platformio debug --interface gdb --interpreter=mi2
```

Relevant current integration points:

- Debug launch arguments are assembled in `src/backend/adapter.ts`.
- DAP custom requests are handled in `GDBDebugSession.customRequest()`.
- The frontend retrieves launch arguments through the existing `get-arguments` request.
- Commands are registered in `src/extension.ts`.
- `package.json` now declares `contributes.commands`/`contributes.configuration` for the trace feature (added during implementation).

No trace framing, packet decoding, snapshot parsing, or reconstruction currently exists in this repository.

## 4. External References

### `esp-riscv-trace`

Upstream project:

```text
https://github.com/espressif/esp-riscv-trace
```

Relevant upstream modules:

```text
esp_riscv_trace/
  snapshot/abi.py
  snapshot/chip.py
  containers/base.py
  containers/espt.py
  containers/coredump.py
  decoder/encoding.py
  decoder/framing.py
  decoder/instruction.py
  decoder/packets.py
  decoder/packets_pt10.py
  decoder/packets_et20.py
  decoder/params.py
  decoder/pipeline.py
  decoder/reconstruct.py
  decoder/ring.py
  decoder/semantics.py
  elf/image.py
  elf/intervals.py
  elf/layered.py
  elf/rom.py
  ir/capture_note.py
  ir/events.py
  analysis/diagnostics.py
  analysis/history.py
  analysis/location.py
  analysis/profile.py
  analysis/stats.py
  exporters/*
  api.py
  cli.py
  session.py
```

Upstream is Apache-2.0 and requires Python 3.11+. This project will port the required behavior to TypeScript rather than invoking it.

### ESP-Decoder

ESP-Decoder is owned by the same author as this work and may be copied/adapted directly.

Reusable sources:

```text
src/chipTargets.ts
src/pioIntegration.ts
src/espIdfIntegration.ts       # optional later
src/addr2lineResolver.ts
src/panic/addr2line.ts         # optional GDB fallback
```

ESP-Decoder uses Vitest; this repository uses Jest. Test logic can be adapted, but test style must be converted.

## 5. Architecture

```text
.esptrace / core ELF
    │
    ▼
Container loader
    │
    ▼
Snapshot ABI parser
    │
    ▼
Ring-buffer linearizer
    │
    ▼
Frame parser
    │
    ▼
Packet parser
    │
    ▼
Instruction decoder
    │
    ▼
Execution reconstructor
    │
    ▼
TraceEvent stream
    │
    ├── diagnostics
    ├── stats
    ├── history
    ├── profile
    └── instruction/source decode
              │
              ▼
        ELF image + addr2line/GDB
              │
              ▼
          VS Code UI/output
```

ELF and source resolution remain outside the packet decoder:

```text
app ELF + ROM ELF
    │
    ▼
Minimal ELF parser
    │
    ├── executable PT_LOAD bytes
    ├── symbol table
    └── SHA-256
    │
    ▼
Persistent addr2line process
    │
    ▼
Function/file/line locations
```

## 6. Proposed File Layout

Add a shared, VS Code-independent trace library:

```text
src/trace/
  types.ts
  binary.ts
  chip.ts
  platformioIni.ts
  pioToolchain.ts
  addr2lineResolver.ts
  elf.ts
  elfImage.ts
  layeredImage.ts
  containers.ts
  snapshot.ts
  service.ts
  exporters.ts
  decoder/
    encoding.ts
    instruction.ts
    semantics.ts
    framing.ts
    ring.ts
    packets.ts
    packetsPt10.ts
    packetsEt20.ts
    params.ts
    reconstruct.ts
    pipeline.ts
  analysis/
    diagnostics.ts
    history.ts
    location.ts
    profile.ts
    stats.ts
```

Add frontend integration:

```text
src/frontend/trace.ts
src/frontend/trace_output.ts       # optional
src/frontend/trace_webview.ts      # later phase
```

Add adapter-side capture support:

```text
src/backend/traceCapture.ts
```

Modify:

```text
src/backend/adapter.ts             # trace custom requests
src/extension.ts                   # command registration and trace service wiring
src/common.ts                      # shared trace event/request types if needed
package.json                       # dependency and/or contributed commands/settings
```

Keep `src/trace/*` free of `vscode` imports so it can be unit tested in Jest and reused by either webpack entry if needed.

## 7. Toolchain Detection

### 7.1 Reuse strategy

Adapt ESP-Decoder’s detection code rather than inventing a new discovery path.

Copy or adapt:

- `chipTargets.ts`
  - ELF `e_machine` detection
  - chip-to-architecture mapping
  - known chip list
- `pioIntegration.ts`
  - `platformio.ini` parsing
  - `extends`, `extra_configs`, and variable interpolation
  - build directory resolution
  - `.pio/build/<env>/*.elf` discovery
  - board `build.mcu` lookup
  - `findPioGdbToolPath()`
  - `findRomElf()`
  - `getPioPackagesDir()`
- `addr2lineResolver.ts`
  - persistent batched `addr2line`
  - sentinel-based output detection
  - idle timeout and process cleanup

ESP-IDF support can be added later by adapting `espIdfIntegration.ts`.

### 7.2 Trace context

Introduce a resolver that returns:

```ts
interface TraceContext {
  workspaceFolder: string;
  elfPath: string;
  chip?: string;
  targetArch?: 'riscv' | 'xtensa';
  packagesDir?: string;
  coreDir?: string;
  buildDir?: string;
  gdbPath?: string;
  addr2linePath?: string;
  openocdPath?: string;
  romElfPath?: string;
}
```

Resolution order:

1. Use explicit launch/config overrides when present.
2. Use `args.executable` from the active debug session.
3. Fall back to `.pio/build/<env>/*.elf` discovery.
4. Read ELF `e_machine`; `0xF3` means RISC-V.
5. Detect chip from board JSON `build.mcu`, environment name, board ID, platform string, or capture `target_id`.
6. Resolve PlatformIO/pioarduino packages directory.
7. Find `riscv32-esp-elf-gdb`.
8. Derive or find `riscv32-esp-elf-addr2line`.
9. Find `tool-openocd-esp32/bin/openocd`.
10. Find `tool-esp-rom-elfs/<chip>_rev*_rom.elf`.

### 7.3 Package locations

Expected pioarduino/PlatformIO package layout:

```text
<coreDir>/packages/
  tool-riscv32-esp-elf-gdb/bin/riscv32-esp-elf-gdb
  toolchain-riscv32-esp/bin/riscv32-esp-elf-gdb
  toolchain-riscv32-esp/bin/riscv32-esp-elf-addr2line
  tool-openocd-esp32/bin/openocd
  tool-esp-rom-elfs/<chip>_rev<N>_rom.elf
```

`pioarduino-node-helpers` should be used for core/package path helpers.

Do use Python-backed helper APIs only when necessary (use Platformio Python venv (penv) when needed), for example:

- `ProjectConfig`
- `getCorePythonExe`
- `getCorePythonCommandOutput`
- `pioarduinoCoreStage`

Also verify `pioarduino-node-helpers` runtime/engine requirements against this extension’s VS Code engine range (`^1.82.0`).

### 7.4 No-Python boundary

The trace feature must not spawn Python. Allowed external processes are native binaries only:

- `riscv32-esp-elf-gdb`
- `riscv32-esp-elf-addr2line`
- `riscv32-esp-elf-objdump` / `readelf` if needed
- `openocd`

When copying `pioIntegration.ts`, remove or bypass the `${PROJECT_HASH}` Python expansion path. For the first version, support normal `build_dir`/`workspace_dir` values and fall back to `.pio/build`.

## 8. ELF and Source Resolution

### 8.1 Minimal ELF parser

Implement enough ELF parsing for trace decoding:

- ELF header
- Program headers
- Section headers
- Executable `PT_LOAD` regions
- Symbol table and linked string table
- ELF notes for core dumps
- SHA-256 through Node `crypto`

ESP32 RISC-V firmware is expected to be ELF32 little-endian. ELF64 support can be added only if needed.

Required symbol classes:

- `STT_FUNC`
- `STT_OBJECT`
- relevant `STT_NOTYPE` labels

### 8.2 Source resolver

Primary path: persistent `addr2line`.

Recommended invocation:

```text
riscv32-esp-elf-addr2line -f -C -i -e <app.elf>
```

Batch addresses through stdin and parse function/file/line output. Add:

- result cache
- batch timeout
- idle-process timeout
- process restart on failure
- path normalization for source links

Optional fallback: drive GDB `info line` / `list` when `addr2line` is unavailable. This is slower and should be secondary.

### 8.3 ROM ELF layering

Mirror upstream `LayeredImage` behavior:

- App ELF provides normal firmware addresses.
- ROM ELF provides ROM address ranges.
- Lookup order must match upstream semantics so ROM calls resolve correctly.

## 9. Decoder Port Mapping

| Upstream Python | TypeScript target | Notes |
|---|---|---|
| `snapshot/abi.py` | `src/trace/snapshot.ts` | ABI structs/enums and note parsing |
| `snapshot/chip.py` | `src/trace/chip.ts` | Chip IDs and decoder profiles |
| `containers/base.py` | `src/trace/containers.ts` | Shared container interface |
| `containers/espt.py` | `src/trace/containers.ts` | `.esptrace` ESPT parsing |
| `containers/coredump.py` | `src/trace/containers.ts` | ELF `PT_NOTE`/`PT_LOAD` extraction |
| `ir/events.py` | `src/trace/types.ts` | Trace event model |
| `ir/capture_note.py` | `src/trace/types.ts` or `snapshot.ts` | Capture metadata |
| `decoder/encoding.py` | `src/trace/decoder/encoding.ts` | Bit-level instruction decoding |
| `decoder/instruction.py` | `src/trace/decoder/instruction.ts` | Control-flow instruction classes |
| `decoder/semantics.ts` source | `src/trace/decoder/semantics.ts` | Register/write effects for analysis |
| `decoder/framing.py` | `src/trace/decoder/framing.ts` | Anchors, frames, packet indexes |
| `decoder/ring.py` | `src/trace/decoder/ring.ts` | Circular buffer linearization |
| `decoder/packets.py` | `src/trace/decoder/packets.ts` | Shared packet types |
| `decoder/packets_pt10.py` | `src/trace/decoder/packetsPt10.ts` | PT1.0 packets |
| `decoder/packets_et20.py` | `src/trace/decoder/packetsEt20.ts` | ET2.0 packets |
| `decoder/params.py` | `src/trace/decoder/params.ts` | Encoder/chip profiles |
| `decoder/reconstruct.py` | `src/trace/decoder/reconstruct.ts` | Execution reconstruction |
| `decoder/pipeline.py` | `src/trace/decoder/pipeline.ts` | Event pipeline/interleaving |
| `elf/image.py` | `src/trace/elfImage.ts` | Code image interface |
| `elf/intervals.py` | `src/trace/intervals.ts` | Address interval index |
| `elf/layered.py` | `src/trace/layeredImage.ts` | App + ROM layering |
| `elf/rom.py` | `src/trace/romElf.ts` | ROM ELF integration |
| `analysis/diagnostics.py` | `src/trace/analysis/diagnostics.ts` | Gaps/errors/warnings |
| `analysis/stats.py` | `src/trace/analysis/stats.ts` | Instruction/hotspot stats |
| `analysis/history.py` | `src/trace/analysis/history.ts` | Call/return history |
| `analysis/location.py` | `src/trace/analysis/location.ts` | Location resolution helpers |
| `analysis/profile.py` | `src/trace/analysis/profile.ts` | Folded/speedscope profile data |
| `exporters/*` | `src/trace/exporters.ts` + frontend formatting | Text/JSON output |
| `api.py`, `session.py` | `src/trace/service.ts` | High-level decode API |
| `cli.py` | not ported | VS Code commands replace CLI |

Port behavior first, then optimize. Preserve upstream diagnostic meanings where practical so fixture comparisons remain meaningful.

## 10. Capture Control

### 10.1 Prerequisites

Trace capture requires:

- Firmware built with `CONFIG_ESP_RISCV_TRACE_ENABLE`.
- OpenOCD built with `CONFIG_ESP_RISCV_TRACE_OPENOCD`.
- A supported RISC-V trace chip.
- Correct capture path handling.

Supported trace chips currently include:

```text
esp32c5
esp32c6
esp32c61
esp32h2
esp32h21
esp32h4
esp32p4
esp32s31
```

### 10.2 OpenOCD commands

Expected commands:

```text
esp riscv_trace start loop <file>
esp riscv_trace stop
esp riscv_trace dump <file>
```

Use absolute paths under a workspace-local directory such as:

```text
.pio/debug-trace/<timestamp>-<env>.esptrace
```

### 10.3 Transport spike

Before implementing UI controls, verify how to reach OpenOCD from the active debug session.

Possible paths:

1. GDB `monitor esp riscv_trace ...` through the existing MI command path.
2. Direct OpenOCD telnet/gdbserver command channel if exposed by PlatformIO.
3. Dedicated adapter custom requests that wrap the working transport.

The existing `execute-command` path may be sufficient for a spike, but dedicated requests will be cleaner.

### 10.4 Adapter custom requests

Add to `GDBDebugSession.customRequest()` if needed:

```text
trace-start
trace-stop
trace-dump
trace-status
```

Request/response types should live in `src/common.ts` or `src/trace/types.ts`.

## 11. VS Code Commands and Settings

### 11.1 Commands

Initial command set:

```text
platformio-debug.trace.inspectCapture
platformio-debug.trace.decodeFile
platformio-debug.trace.decodeLastInstructions
platformio-debug.trace.showHistory
platformio-debug.trace.showStats
platformio-debug.trace.showProfile
platformio-debug.trace.startCapture
platformio-debug.trace.stopCapture
platformio-debug.trace.dumpCapture
platformio-debug.trace.openCaptureFolder
```

Register commands in `src/extension.ts`. If palette/menu contributions are required, add them to `package.json` here or coordinate with `pioarduino-vscode-ide`, matching the project’s existing UI split.

### 11.2 Settings

Proposed settings under `platformio-debug.trace.*`:

```text
platformio-debug.trace.enabled
platformio-debug.trace.captureDir
platformio-debug.trace.chip
platformio-debug.trace.core
platformio-debug.trace.mode
platformio-debug.trace.timeoutMs
platformio-debug.trace.autoDecodeOnStop
platformio-debug.trace.elfPath
platformio-debug.trace.gdbPath
platformio-debug.trace.addr2linePath
platformio-debug.trace.openocdPath
platformio-debug.trace.romElfPath
```

Launch configuration may optionally carry trace overrides, but settings plus active debug arguments should cover the common case.

### 11.3 Output

First version:

- Output channel: `PlatformIO Debug Trace`
- Read-only text documents for large decode/history/profile output
- Diagnostics/warnings inline in decoded output

Later version:

- Dedicated tree/webview for instructions, history, stats, and profile
- Source links from addr2line locations
- Export commands for JSON/text/speedscope

## 12. Implementation Phases

### Phase 0 — Spike and scaffolding

Tasks:

- Create `esp32_trace` branch.
- Add `src/trace/` skeleton.
- Add `pioarduino-node-helpers` dependency/type declarations if needed.
- Verify webpack bundling with the helper.
- Spike OpenOCD trace command transport.

Exit criteria:

- Toolchain paths can be resolved on a real pioarduino project.
- A capture command path is identified or documented as blocked.

### Phase 1 — Toolchain/context detection

Tasks:

- Adapt `chipTargets.ts`.
- Adapt pure PlatformIO INI/env/build/ELF discovery code.
- Adapt `findPioGdbToolPath()` and `findRomElf()`.
- Add `addr2line` and OpenOCD discovery.
- Implement `resolveTraceContext()`.
- Add Jest tests with temporary package trees.

Exit criteria:

- Given a workspace and ELF, the resolver returns arch, chip, GDB, addr2line, OpenOCD, ROM ELF, and packages dir where available.
- Xtensa-only targets are rejected for trace features.

### Phase 2 — Containers, snapshot, ring, framing

Tasks:

- Port ABI structs/enums.
- Port `.esptrace` ESPT container parsing.
- Port core-dump ELF note extraction.
- Port ring linearization.
- Port frame parser.

Exit criteria:

- A real `.esptrace` fixture loads and reports expected frame/packet counts.
- A trace-enabled core ELF loads the `ESP_RISCV_TRACE` note.

### Phase 3 — Packets and instruction decoding

Tasks:

- Port decoder params/profiles.
- Port PT1.0 and ET2.0 packet parsers.
- Port RISC-V/RVC/Zcmp instruction decoding.
- Port instruction semantics needed by reconstruction.

Exit criteria:

- Parsed packets match upstream expectations on fixture captures.
- Instruction classes/targets match upstream decoder behavior.

### Phase 4 — Reconstruction and decode output

Tasks:

- Port `reconstruct.ts` and `pipeline.ts`.
- Implement `TraceEvent` stream.
- Implement minimal ELF image and interval index.
- Implement app+ROM layered image.
- Integrate `Addr2lineResolver`.
- Add text decode exporter.

Exit criteria:

- `decode` output shows PCs, functions, files, lines, gaps, and summaries.
- Output is comparable to upstream `esp-riscv-trace decode` on fixtures.

### Phase 5 — Analysis features

Tasks:

- Port diagnostics accumulator.
- Port stats accumulator.
- Port history builder.
- Port profile accumulator.
- Add folded and speedscope JSON exporters.

Exit criteria:

- `stats`, `history`, and `profile` commands produce useful output.
- Diagnostics report trace gaps and unsupported/invalid data.

### Phase 6 — Capture controls and UI polish

Tasks:

- Implement `trace-start`, `trace-stop`, `trace-dump`, and `trace-status` if the spike succeeds.
- Add frontend commands and settings.
- Add output channel/text document rendering.
- Add optional auto-decode on halt/crash.
- Coordinate `package.json` contributions if needed.

Exit criteria:

- User can start/stop/dump trace during a supported debug session.
- Captured `.esptrace` can be decoded without leaving VS Code.

### Phase 7 — Optional advanced analysis

Tasks:

- Evaluate `analysis.origin` / `FaultWindowBuilder`.
- Decide whether crash-causality reconstruction belongs in this extension.
- Port only if the feature set requires it.

## 13. Testing Strategy

### Unit tests

Add Jest tests under `__tests__/trace/` for:

- Binary reader endianness/bit order
- `platformio.ini` parsing and interpolation
- Build/env/ELF discovery
- Toolchain package detection
- ELF header/symbol/note parsing
- Snapshot ABI parsing
- ESPT and core-dump containers
- Ring wrap/linearization
- Framing anchors/errors
- PT1.0 and ET2.0 packets
- Instruction decode cases
- Reconstruction against synthetic code images
- `addr2line` output parsing
- Exporter formatting

### Fixture tests

Use Apache-licensed upstream fixtures where practical:

- `tests/esp32c5/stop.esptrace`
- `tests/esp32c5/panic_stop.esptrace`
- `tests/esp32c5/coredump.elf`
- `tests/built_apps/esp32c5.elf`
- optionally `esp32c6` fixtures for PT1.0 coverage

The trace files are small; app ELFs are several MB each. Start with one ET2.0 fixture and one PT1.0 fixture, then decide whether to vendor binaries or generate smaller synthetic fixtures.

### Manual hardware tests

Required for capture controls:

- ESP32-C6 or ESP32-C5
- Firmware with trace enabled
- OpenOCD trace start/stop/dump
- Decode capture and compare against upstream expected output
- Core-dump path if available

## 14. Risks and Open Questions

| Risk | Mitigation |
|---|---|
| Decoder port is large | Port in phases; keep upstream fixture comparisons at each stage |
| OpenOCD command transport is unclear | Spike before UI work; support file decode independently |
| Firmware lacks trace config | Detect/warn and document required `sdkconfig` options |
| `addr2line` differs from `pyelftools` DWARF resolution | Compare on fixtures; use `-i` for inline frames; keep GDB fallback |
| `pioarduino-node-helpers` compatibility | Verify engine/module format; implement minimal fallback if needed |
| Large captures consume memory | Stream events where possible; batch addr2line; cap UI rendering |
| Package contribution ownership | Resolved: `contributes` added to this extension's `package.json` |
| Custom `${PROJECT_HASH}` build dirs | Defer; support standard build dirs first |

## 15. Definition of Done

The feature is complete when:

- A user can select or auto-detect an ESP32 RISC-V ELF.
- The extension resolves the correct RISC-V toolchain and addr2line.
- A `.esptrace` or trace-enabled core ELF can be inspected and decoded.
- Instruction dump, stats, history, and profile outputs are available.
- Diagnostics explain unsupported chips, missing firmware config, malformed captures, and toolchain failures.
- `npm run build` and `npm test` pass.
- Capture controls work on supported hardware or are clearly documented as unavailable.

## 16. Implementation Progress

Completed (all under `src/trace/`, ported from Apache-2.0 `esp-riscv-trace`):

- `chip.ts`, `platformioIni.ts`, `pioToolchain.ts`, `addr2lineResolver.ts`, `service.ts`, `types.ts` — toolchain/context detection adapted from ESP-Decoder (Phase 1).
- `snapshot/abi.ts`, `snapshot/chip.ts` — snapshot ABI, note ABI, encoder params, chip ID maps.
- `containers/base.ts`, `containers/espt.ts`, `containers/coredump.ts`, `containers/index.ts` — ESPT and coredump-ELF loaders with auto-detection.
- `elf/core.ts` — minimal ELF32 little-endian core reader (PT_NOTE/PT_LOAD).
- `decoder/ring.ts`, `decoder/framing.ts` — ring linearization, wrap inference, anchor/framing walk.
- `decoder/params.ts`, `decoder/packets.ts`, `decoder/packetsPt10.ts`, `decoder/packetsEt20.ts` — decoder profiles, BigInt `BitReader`, PT1.0/ET2.0 packet parsing.
- `ir/events.ts` — trace event IR types.
- `decoder/encoding.ts`, `decoder/instruction.ts` — RV32I/RVC/Zcmp/Zcmt instruction decode.
- `elf/image.ts` — `CodeImage` interface + `ElfImage` (executable PT_LOAD regions, `read`, sha256).
- `decoder/reconstruct.ts` — full `_Walker` state machine port (sync/trap/support/F1/F2 handling, held-instruction speculation, report/park/deferred-gap logic, `GapReason`).
- `decoder/pipeline.ts` — `decodeEvents`/`interleave`/`parseOrError` glue (framing events + parsed packets → reconstruction).
- `decoder/semantics.ts` — `decodeInsnSemantics`/`decodeAt`/`sources`/`evaluate`/`insnText`, `MemAccess`/`InsnInfo`/`LINKS` (renamed `decode_insn`→`decodeInsnSemantics` to avoid clashing with the control-flow `decodeInsn`).
- `session.ts` — `openSession`/`iterCores`/`CoreView`/`StallImage`/`UsageError` (DWARF resolver, capture-note header, ELF sha check, and ROM ELF layering deferred to the ELF/analysis phase).
- `frontend/trace.ts` — `platformio-debug.trace.resolveContext` / `inspectCapture` commands and output channel; wired in `extension.ts`.
- `pioarduino-node-helpers` added as a dependency and marked webpack-external.
- `elf/core.ts` extended — section headers + ELF symbol table parsing; `elf/image.ts` extended — labels, objects, `data_at`.
- `elf/intervals.ts` — `IntervalIndex`; `elf/resolver.ts` (`SourceResolver`), `elf/rom.ts` (ESP-IDF `roms.json` via `IDF_PATH`/`ESP_ROM_ELF_DIR`), `elf/layered.ts` (`LayeredImage`/`LayeredResolver`, `rom:` symbol prefix), `elf/addr2lineResolver.ts` — batched `riscv32-esp-elf-addr2line` source resolution.
- `ir/capture_note.ts` — capture-note formatting; `session.ts` — `buildCaptureNote`/`wrapStateView`/`ShaMismatch`.
- `analysis/diagnostics.ts`, `stats.ts`, `history.ts`, `profile.ts`, `location.ts` — diagnostics accumulator, stats, call-stack history builder, profile accumulator.
- `exporters/_format.ts`, `text.ts`, `history.ts`, `statsText.ts`, `profile.ts`, `note.ts` — decode text (incl. `GapCoalescer`, `format_note`, `format_diagnostic`, `format_capture_set`), history text/JSON, stats text, folded + speedscope profiles.
- `commands.ts` — `decode`/`stats`/`history`/`profile` command layer mirroring upstream `cli.py`, with golden parity tests.
- `analysis/origin.ts` — `FaultWindowBuilder`/`FaultWindow`/`RegisterStep` port of `analysis/origin.py` (register provenance walks, store/load following, trap/untraced-call crossings, scheduler detection, bus access, stack calls, branch outcomes, unsure writes); `history.ts` exports `ECALL_CAUSES`/`SCHEDULER_FUNCTIONS`.
- Capture controls — adapter custom requests `trace-probe`/`trace-start`/`trace-stop`/`trace-dump` send `monitor esp riscv_trace ...` via MI2; `sendCommand` gained a `captureConsole` flag and `MINode.consoleOutput` carries per-command console/target stream output.
- `frontend/trace.ts` — all ten `platformio-debug.trace.*` commands (resolveContext, inspectCapture, probeCapture, startCapture, stopCapture, dumpCapture, decode, stats, history, profile); decode offers full/last-50/200/1000 scopes; output channel "PlatformIO Debug Trace"; decode/profile open untitled documents, stats/history write to the channel.
- `package.json` — `contributes.commands` (10 trace commands) and `contributes.configuration` (14 `platformio-debug.trace.*` settings) declared.
- Tests: `__tests__/trace/` (14 suites) plus Apache-2.0 fixtures in `__tests__/fixtures/trace/` (esp32c5/c6/s31 captures and coredump ELFs, app ELFs, expected decode summaries, golden CLI outputs); `__tests__/backend/mi2-console-capture.test.ts` and `adapter-trace-commands.test.ts` cover the capture plumbing.

Verified: `npm run build` clean; `npm test` 38 suites / 612 tests pass. End-to-end `decodeEvents` matches upstream expected output exactly on all four fixtures: esp32c6 stop (49109 insns/4 syncs/3 gaps), esp32c6 panic (1951/3/1 trap/4 gaps), esp32c5 stop (48431/3/21 gaps), esp32c5 panic (16482/25/2 traps/120 gaps) — for both PT1.0 and ET2.0. Semantics port passes the upstream `test_semantics.py` suite: 25 evaluate cases, AMO/reservation orderings, 26 reserved/Zcmp forms, and exhaustive control-flow agreement over every compressed encoding plus ~30k sampled 32-bit encodings. `commands.test.ts` compares `decode`/`stats`/`history`/`profile` output against golden files generated by the upstream CLI (8/8 byte-identical after path/JSON normalization, incl. DWARF file/line via addr2line).

Remaining:

- ~~`analysis/origin.py`~~ done: `analysis/origin.ts` ports `FaultWindowBuilder`/`FaultWindow`/`RegisterStep` walks (register provenance, store/load following, trap/untraced-call crossings, scheduler detection, bus access, stack calls, branch outcomes, unsure writes). `history.ts` now exports `ECALL_CAUSES`/`SCHEDULER_FUNCTIONS`. `__tests__/trace/origin.test.ts` ports `test_origin.py` — 68 tests incl. real coredump captures on esp32c5/c6/s31.
- Real DWARF resolver (current `SourceResolver` is an addr2line batch-query stub — sufficient for CLI parity); optional GDB/objdump fallbacks.
- ~~UI polish~~ decode/stats/history/profile wired into the frontend: `platformio-debug.trace.{decode,stats,history,profile}` pick a capture, resolve ELF/addr2line/chip/ROM context, run `commands.ts`, and show decode/profile in an untitled document, stats/history in the output channel. Decode offers full/last-50/200/1000 scopes; `profileFormat`/`historyJson`/`captureTimeoutMs` settings read.
- ~~`package.json` contributes~~ all ten `platformio-debug.trace.*` commands declared under `contributes.commands` (category "PlatformIO Debug"); all `platformio-debug.trace.*` settings declared under `contributes.configuration` (elfPath, chip, targetArch, coreDir, packagesDir, buildDir, usePlatformIOConfig, gdbPath, addr2linePath, openocdPath, romElfPath, captureTimeoutMs, historyJson, profileFormat).
- ~~Capture controls~~ partially done: adapter custom requests `trace-probe`/`trace-start`/`trace-stop`/`trace-dump` send `monitor esp riscv_trace ...` through GDB MI; MI2 now captures console/target stream output per command (`sendCommand(..., captureConsole)`, `MINode.consoleOutput`); frontend commands `platformio-debug.trace.{probe,start,stop,dump}Capture` added; `inspectCapture` now loads captures via `openSession`. **Spike finding:** the installed pioarduino `tool-openocd-esp32` (OpenOCD v0.12.0-esp32-20260703) does NOT contain `esp riscv_trace` (verified via `strings`); upstream `openocd-esp32` merged the code ~Nov 2026 on master behind `CONFIG_ESP_RISCV_TRACE_OPENOCD`, after the latest release (20260831). Live capture requires a newer tool-openocd-esp32 package; `trace-probe` detects support at runtime. Working alternative today: coredump-ELF captures with the trace note.
- ~~UI polish / contributes~~ done (see above).
