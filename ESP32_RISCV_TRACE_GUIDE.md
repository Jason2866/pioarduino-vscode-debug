# ESP32 RISC-V Hardware Trace User Guide

`pioarduino-vscode-debug` includes built-in, native TypeScript support for inspecting, decoding, and analyzing **ESP32 RISC-V hardware execution traces**—without requiring Python at runtime.

---

## 1. What It Does

You can load either:
- **`.esptrace` capture files** (produced by OpenOCD or exported from a device)
- **ESP core-dump ELF files** containing an `ESP_RISCV_TRACE` note

From a capture, the extension reconstructs the executed RISC-V instruction stream (PT1.0 and ET2.0 formats) and provides:
- **Interactive Trace Inspector (Webview)** with disassembled RISC-V instructions, filtering, *Jump to Fault*, call history, function hotspots, flame/profile data, and fault-origin analysis
- **ESP32 Trace Sidebar View** in the Run & Debug panel for quick navigation
- **Clickable `file:line` Source Links** across the TreeView, Webview, and decoded text documents
- **Exports** to plain text, JSON, Folded stacks, and **Speedscope JSON** (`.speedscope.json`)
- **Live Capture Controls** over an active `platformio-debug` session (when supported by your OpenOCD build)

---

## 2. Supported Chips & Prerequisites

### Supported Chips
- `esp32c5`
- `esp32c6`
- `esp32c61`
- `esp32h2`
- `esp32h21`
- `esp32h4`
- `esp32p4`
- `esp32s31`

*(Xtensa targets do not have this trace decoder.)*

### Requirements
- **Firmware ELF** built with debug symbols (`-g`) and `CONFIG_ESP_RISCV_TRACE_ENABLE` enabled in `sdkconfig` for trace-enabled firmware / core dumps.
- **RISC-V Toolchain** (`riscv32-esp-elf-addr2line` and/or `riscv32-esp-elf-gdb`) for resolving program counters to `file:line` source locations. These are auto-detected from your PlatformIO/pioarduino packages directory.
- **Live Capture (optional):** Requires firmware built with `CONFIG_ESP_RISCV_TRACE_OPENOCD` enabled and `CONFIG_ESP_RISCV_TRACE_AUTOSTART` disabled, plus an `openocd-esp32` build that includes the `esp riscv_trace` command. If your installed OpenOCD does not yet include `esp riscv_trace`, you can still decode existing `.esptrace` files and trace-enabled core-dump ELFs.

---

## 3. Quick Start

### Option A: Using the ESP32 Trace Sidebar & Inspector
1. Open the **Run and Debug** view in VS Code (`Cmd+Shift+D` / `Ctrl+Shift+D`).
2. Locate the **ESP32 Trace** panel.
3. Click **Load Capture into Inspector…** (or run **PlatformIO Debug: Trace: Open Trace Inspector** from the Command Palette).
4. Select your `.esptrace` or coredump `.elf` file.
5. Explore the capture:
   - **Sidebar TreeView**: Expand **Diagnostics**, **Fault & Origin**, **Top Hotspots**, and **Call History**. Click any item with a `file:line` label to jump straight to that source line in the editor.
   - **Webview Inspector**:
     - **Overview**: Capture metadata, core selector, ELF SHA-256 verification status, and diagnostic counts (instructions, syncs, traps, gaps, warnings).
     - **Instructions**: Paged (500 rows/page) disassembled RISC-V instruction stream. Use the filter box (search by PC, symbol, mnemonic, or gap reason) or click **Jump to Fault**.
     - **History**: Indented call, trap, and return timeline. Export as Text or JSON.
     - **Stats**: Ranked hotspot functions with execution counts and percentages.
     - **Profile**: Call-stack sample breakdown. Click **Save Speedscope…** or **Save Folded…** to save a file for [speedscope.app](https://www.speedscope.app/).
     - **Fault Origin**: Fault cause/EPC/TVAL, unreturned call stack, recent conditional branch outcomes (`taken` / `not taken`), and backward register provenance (when a halted debug session provides CPU registers).

### Option B: Using Command Palette Commands
Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and search for `PlatformIO Debug: Trace`:

| Command | Description |
|---|---|
| `Trace: Open Trace Inspector` | Opens the interactive Webview Inspector for the loaded (or newly selected) capture. |
| `Trace: Load Capture into Inspector` | Prompts for a new capture file and loads it into the TreeView and Webview Inspector. |
| `Trace: Clear Loaded Capture` | Clears the currently loaded capture from the TreeView and closes the inspector. |
| `Trace: Inspect Capture` | Prints capture header, chip, ABI, and core buffer metadata to the `PlatformIO Debug Trace` output channel. |
| `Trace: Decode Capture` | Decodes instructions (Full, or Last 50 / 200 / 1000 before fault) into an editor tab with clickable `file:line` links. |
| `Trace: Show Stats` | Prints hotspot statistics to the output channel. |
| `Trace: Show History` | Prints call/trap/return history (text or JSON) to the output channel. |
| `Trace: Show Profile` | Opens a folded or Speedscope profile in an editor tab. |
| `Trace: Show Fault Origin` | Opens fault summary, unreturned calls, recent branches, and register provenance in an editor tab. |
| `Trace: Resolve Context` | Displays auto-detected ELF, chip, toolchain (`gdb`, `addr2line`, `openocd`), and ROM ELF paths. |
| `Trace: Open Capture Folder` | Opens the configured capture directory in your OS file manager. |

---

## 4. Live Trace Capture (During a Debug Session)

When an active `platformio-debug` session is running:

1. Run **Trace: Probe OpenOCD Trace Support** to verify whether your `openocd` binary supports `esp riscv_trace`.
2. Run **Trace: Start Capture** and choose a destination `.esptrace` file (defaults to `.pio/debug-trace/`).
3. Run or reproduce the issue on your target, then run **Trace: Stop Capture**.
4. Run **Trace: Dump Capture** to flush the trace buffer to disk.
5. If `platformio-debug.trace.autoDecodeOnStop` is enabled, the extension automatically decodes the last saved capture file on dump, halt, or session termination. Note that terminating a debug session does **not** trigger a dump—always stop or dump the capture before ending the session so the file exists on disk.

---

## 5. Configuration Settings

All settings live under `platformio-debug.trace.*` in VS Code Settings:

| Setting | Default | Description |
|---|---|---|
| `platformio-debug.trace.enabled` | `true` | Enable or disable ESP32 RISC-V trace commands, sidebar view, and auto-decode. |
| `platformio-debug.trace.captureDir` | `".pio/debug-trace"` | Directory for saving trace captures (relative to workspace root or absolute). |
| `platformio-debug.trace.core` | `null` | Core ID filter (`0`, `1`, …). `null` decodes all cores in the capture. |
| `platformio-debug.trace.mode` | `"loop"` | Capture mode sent to OpenOCD `trace start`. |
| `platformio-debug.trace.captureTimeoutMs` | `0` | Loop-capture duration in milliseconds (`0` uses firmware default). |
| `platformio-debug.trace.autoDecodeOnStop` | `false` | Automatically decode the last capture when a dump finishes, target halts, or debug session terminates. |
| `platformio-debug.trace.elfPath` | `""` | Firmware ELF override. Empty auto-detects from the active debug session or `.pio/build/<env>/`. |
| `platformio-debug.trace.chip` | `""` | Chip override (e.g. `esp32c5`, `esp32c6`). Empty auto-detects from the ELF/board. |
| `platformio-debug.trace.targetArch` | `""` | Architecture override (`""`, `"riscv"`, `"xtensa"`). Empty auto-detects from ELF `e_machine`. |
| `platformio-debug.trace.coreDir` | `""` | PlatformIO core directory override (empty uses `PLATFORMIO_CORE_DIR` or `~/.platformio`). |
| `platformio-debug.trace.packagesDir` | `""` | PlatformIO packages directory override (empty uses `<coreDir>/packages`). |
| `platformio-debug.trace.buildDir` | `""` | Build directory override for ELF discovery. |
| `platformio-debug.trace.usePlatformIOConfig` | `true` | Use `platformio.ini` to resolve build directory and board metadata. |
| `platformio-debug.trace.gdbPath` | `""` | Path to `riscv32-esp-elf-gdb` (auto-detected if empty; also used as `info line` fallback). |
| `platformio-debug.trace.addr2linePath` | `""` | Path to `riscv32-esp-elf-addr2line` (auto-detected if empty). |
| `platformio-debug.trace.openocdPath` | `""` | Path to OpenOCD (auto-detected if empty). |
| `platformio-debug.trace.romElfPath` | `""` | Path to chip ROM ELF for layered ROM symbol resolution (auto-detected if empty). |
| `platformio-debug.trace.historyJson` | `false` | Emit `Trace: Show History` output as JSON instead of text. |
| `platformio-debug.trace.profileFormat` | `"folded"` | Output format for `Trace: Show Profile` (`"folded"` or `"speedscope"`). |

---

## 6. Troubleshooting

- **Missing source file/line columns:** Run **Trace: Resolve Context** and check the `PlatformIO Debug Trace` output channel to confirm `addr2linePath` (or `gdbPath` fallback) and `elfPath` were found.
- **"ELF SHA mismatch" warning:** The capture was recorded from a different firmware build than the ELF currently selected. Point `platformio-debug.trace.elfPath` to the exact ELF flashed to the device.
- **Clicking a source link says "Source file not found":** Source paths are resolved against your workspace root, ELF directory, PlatformIO framework packages (`framework-espidf`, `framework-arduinoespressif32`), and `IDF_PATH`. Ensure the matching project/framework sources exist locally.
- **OpenOCD does not recognize `esp riscv_trace`:** Your installed `tool-openocd-esp32` does not include the `esp riscv_trace` command. Upgrade `tool-openocd-esp32` when available (and ensure your firmware has `CONFIG_ESP_RISCV_TRACE_OPENOCD` enabled and `CONFIG_ESP_RISCV_TRACE_AUTOSTART` disabled), or use coredump ELFs / `.esptrace` files for offline decoding.
