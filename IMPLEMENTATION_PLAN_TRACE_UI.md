# ESP32 RISC-V Trace UI Implementation Plan (TreeView + Webview + Clickable Source Links)

**Target Branch**: `esp32_trace`  
**Status**: Implemented  
**Last Updated**: 2026-11-25

---

## 1. Objective

Upgrade the ESP32 RISC-V trace user experience in `pioarduino-vscode-debug` from plain-text output documents and output-channel logs to an interactive VS Code UI featuring:

1. **Sidebar TreeView (`platformio-debug.traceView`)** for at-a-glance capture inspection, diagnostics, faults, hotspots, and quick navigation.
2. **Custom Webview Inspector (`TraceWebviewPanel`)** for exploring decoded instructions, call history, statistics, profiles, and fault-origin analysis with paging, search/filtering, and export actions.
3. **Clickable Source Links** across the TreeView, Webview, and decoded text documents that jump directly to the corresponding `file:line` in the VS Code editor.

---

## 2. Design Constraints

- **No extra bundler/framework complexity:** `webpack.config.js` builds two Node targets (`dist/extension.js`, `dist/adapter.js`). Keep the webview self-contained using VS Code CSS variables and vanilla TypeScript-generated HTML/JS with a strict CSP nonce—no React/Vite build pipeline required.
- **Keep `src/trace/` VS Code-independent:** All structured analysis models and path-normalization helpers that do not use `vscode` stay in `src/trace/` so they remain testable in Jest without VS Code mocks.
- **Large capture performance:** Real `.esptrace` captures routinely contain 50k+ instructions. Never serialize or render 50k DOM nodes at once; paginate/window instruction rows in the extension host and send slices to the webview on demand.
- **Security:** Escape all decoded symbols, file paths, and error strings before HTML interpolation; enforce a strict `Content-Security-Policy` with a per-panel nonce; validate all `webview.onDidReceiveMessage` payloads.

---

## 3. Architecture

```text
TraceFrontend (src/frontend/trace.ts)
  ├── holds active TraceAnalysisSession (cached decoded cores, resolvers, diagnostics)
  ├── registers commands & openLocation handler
  ├── notifies TraceTreeProvider on load / capture / clear
  └── opens/updates TraceWebviewPanel

src/trace/ (VS Code-free)
  ├── commands.ts / analysisModel.ts
  │     └── structured TraceAnalysisResult (events, history, stats, profile, origin, diag)
  └── elf/locationPath.ts
        └── normalize & resolve DWARF/addr2line paths against workspace/buildDir

src/frontend/
  ├── trace_tree_provider.ts    (Sidebar TreeView: captures, cores, faults, hotspots, actions)
  ├── trace_webview.ts          (WebviewPanel: tabbed inspector, paged instructions, exports)
  └── trace_link_provider.ts    (DocumentLinkProvider for plain-text decode/origin docs)
```

---

## 4. Clickable Source Link Resolution

DWARF / `addr2line` / GDB `info line` paths can be absolute, workspace-relative, build-dir-relative, or use foreign separators (e.g. Windows-built ELF inspected on macOS/Linux).

### 4.1 Path Resolver (`src/trace/elf/locationPath.ts`)

Implement `resolveSourceFilePath(rawFile: string, searchRoots: string[]): string | undefined`:

1. Reject synthetic/unresolvable markers (`??`, `<built-in>`, empty strings).
2. If `rawFile` is absolute and exists on disk, return it.
3. Normalize separators (`\` -> `/`) and probe relative to `searchRoots` (`workspaceFolder`, `buildDir`, `path.dirname(elfPath)`).
4. If still not found, try suffix-matching against workspace files (e.g., stripping leading build-machine prefix up to `src/`, `lib/`, `components/`, `main/`) if unambiguous.

### 4.2 Navigation Command (`platformio-debug.trace.openLocation`)

Register in `TraceFrontend`:

- Accepts `{ file: string; line?: number; workspaceFolder?: string; elfPath?: string }`.
- Resolves the file path via `resolveSourceFilePath`.
- If found: opens the document with `vscode.workspace.openTextDocument(uri)` and reveals the 1-based line (`new vscode.Range(line - 1, 0, line - 1, 0)`) in `vscode.window.showTextDocument`.
- If not found: shows a clear warning (`Source file not found: <file>`) rather than failing silently.

### 4.3 Plain-Text `DocumentLinkProvider` (`src/frontend/trace_link_provider.ts`)

- Register `vscode.languages.registerDocumentLinkProvider` for trace decode/origin documents (using a dedicated language ID or custom URI scheme such as `esptrace-output:`).
- Match `(<file>:<line>)` / `<file>:<line>` tokens in formatted decode and origin lines and turn them into clickable `vscode.DocumentLink`s targeting `platformio-debug.trace.openLocation`.

---

## 5. Structured Analysis Model (`src/trace/commands.ts` / `src/trace/analysisModel.ts`)

Currently `decodeCapture`, `statsCapture`, `historyCapture`, `profileCapture`, and `originCapture` return `{ lines: string[], summary?: string }`. Add a structured API that runs the pipeline once per capture and caches/exposes typed data for both the TreeView and Webview:

```ts
export interface TraceCoreAnalysis {
    coreId: number;
    note: CaptureNote;
    diag: TraceDiagnostic;
    events: TraceEvent[];
    resolver: SourceResolver;
    image: CodeImage | undefined;
    stats: StatsSnapshot;
    history: History;
    profile: Profile;
    origin: FaultWindow;
}

export interface TraceCaptureAnalysis {
    capturePath: string;
    chip: string;
    cores: TraceCoreAnalysis[];
}
```

- Add `analyzeCapture(capturePath: string, options: CommandOptions): Promise<TraceCaptureAnalysis>` in `src/trace/commands.ts` reusing `prepareCores` and `prepareCoreAsync`.
- Keep existing `decodeCapture` / `statsCapture` / `historyCapture` / `profileCapture` / `originCapture` unchanged for CLI parity and existing tests.

---

## 6. Sidebar TreeView (`src/frontend/trace_tree_provider.ts`)

Mirror the pattern used by `DisassemblyTreeProvider` and `MemoryTreeProvider` in `src/extension.ts`.

### 6.1 View Registration (`package.json`)

Add under `contributes.views.debug` (alongside `peripherals`, `registers`, `memory`, `disassembly`—or coordinate with `pioarduino-vscode-ide` if views are owned there):

```json
{
  "id": "platformio-debug.traceView",
  "name": "ESP32 Trace",
  "when": "config.platformio-debug.trace.enabled"
}
```

Add toolbar/inline actions in `contributes.menus`:
- `view/title`: Load Capture (`platformio-debug.trace.inspectCapture`), Open Inspector (`platformio-debug.trace.openInspector`), Refresh / Clear, Open Capture Folder.

### 6.2 Tree Hierarchy

```text
ESP32 Trace
├── Capture Controls (when debug session active)
│   ├── Probe OpenOCD Support
│   ├── Start Capture / Stop Capture / Dump Capture
├── <capture.esptrace>  (chip, ABI, ELF SHA status)
│   ├── Open Full Trace Inspector  [opens WebviewPanel]
│   └── Core 0
│       ├── Diagnostics  (49,109 insns · 4 syncs · 1 trap · 3 gaps)
│       ├── Fault & Origin
│       │   ├── Fault: cause=5  epc=0x42001234  foo (main.c:42)  [clickable]
│       │   ├── Unreturned Calls (3)
│       │   │   └── bar (app.c:18)  [clickable]
│       │   └── Recent Branches (4)
│       │       └── 0x42001200  taken  (main.c:38)  [clickable]
│       ├── Top Hotspots (top 10)
│       │   └── process_data  42.1% (20,670 insns)  (dsp.c:105)  [clickable]
│       └── Recent Call History (last 20)
│           └── app_main -> init_driver  (main.c:12)  [clickable]
```

Every node with a resolved `file` + `line` attaches:
```ts
item.command = {
    command: 'platformio-debug.trace.openLocation',
    title: 'Open Source Location',
    arguments: [{ file: loc.file, line: loc.line, elfPath }],
};
```

---

## 7. Custom Webview Inspector (`src/frontend/trace_webview.ts`)

### 7.1 Panel Lifecycle

- Command: `platformio-debug.trace.openInspector` (opens/focuses `TraceWebviewPanel`, prompting for a capture file if none is loaded yet).
- Reuse a single panel instance per capture (or singleton panel updated when a new capture is loaded).
- `localResourceRoots: []` (no local disk asset loading needed when HTML/CSS/JS is inline with nonce).

### 7.2 Views / Tabs

1. **Overview & Diagnostics**
   - Capture path, chip, ABI version, ELF path, ELF SHA-256 status, ROM ELF status.
   - Core selector dropdown (when multi-core).
   - Counts summary cards (instructions, syncs, traps, gaps, warnings) + diagnostic messages.
2. **Instructions (Paged & Filterable)**
   - Extension host slices `core.events` into pages (default 500 events/page).
   - Controls: Prev/Next page, **Jump to Fault**, **Last N before fault** (50 / 200 / 1000 / All), text filter (PC, symbol, mnemonic, gap reason).
   - Columns: `#`, `PC`, `Instruction / Event`, `Symbol`, `Source` (clickable `<a data-file="..." data-line="...">file:line</a>`).
   - Gap and trap rows highlighted with VS Code warning/error theme colors.
3. **Call History**
   - Chronological call/trap/return list with depth indentation, cause/EPC badges, and clickable `file:line` links.
   - Export buttons: **Open as JSON**, **Open as Text**.
4. **Hotspots & Stats**
   - Sortable table of functions (and toggle for basic blocks) showing instruction count, `%` bar, symbol, and clickable `file:line`.
5. **Profile**
   - Interactive folded-stack / flame breakdown (collapsible call-tree or horizontal SVG/CSS flame bars with zoom on click and clickable `file:line` on hover/click).
   - Export buttons: **Save Speedscope JSON**, **Save Folded Text**.
6. **Fault Origin**
   - Fault trap details (`cause`, `epc` clickable link, `tval`, `window_complete`).
   - Unreturned call stack (clickable links).
   - Recent branch outcomes (`taken` / `not taken`, clickable links).
   - Register origin tree (when register state is available).

### 7.3 Message Protocol (`Webview <-> Extension`)

Webview -> Extension:
- `{ type: 'ready' }`
- `{ type: 'selectCore', coreId: number }`
- `{ type: 'requestInstructions', coreId: number, page: number, pageSize: number, filter?: string, jumpToFault?: boolean }`
- `{ type: 'openLocation', file: string, line: number }`
- `{ type: 'export', kind: 'decode' | 'stats' | 'historyJson' | 'historyText' | 'folded' | 'speedscope' | 'origin', coreId: number }`

Extension -> Webview:
- `{ type: 'init', summary: ... }`
- `{ type: 'instructionsPage', coreId: number, page: number, totalPages: number, totalMatched: number, rows: ... }`

---

## 8. File Layout

New files:
```text
src/trace/elf/locationPath.ts          # Workspace/buildDir-aware source path resolution
src/frontend/trace_tree_provider.ts    # Sidebar TreeDataProvider
src/frontend/trace_webview.ts          # WebviewPanel inspector + HTML/CSS/JS renderer
src/frontend/trace_link_provider.ts    # DocumentLinkProvider for text decode/origin docs
__tests__/trace/locationPath.test.ts
__tests__/frontend/traceTree.test.ts
__tests__/frontend/traceWebview.test.ts
```

Modified files:
```text
src/trace/commands.ts                  # Add analyzeCapture() returning TraceCaptureAnalysis
src/frontend/trace.ts                  # Register openLocation, openInspector, link provider, tree provider
src/extension.ts                       # Register TraceTreeProvider on extension activation
package.json                           # Add openInspector/openLocation commands & traceView view
```

---

## 9. Phased Implementation Plan

### Phase 1 — Structured Model & Source Link Resolution
- Implement `src/trace/elf/locationPath.ts` and `platformio-debug.trace.openLocation`.
- Add `analyzeCapture()` in `src/trace/commands.ts`.
- Unit tests for path normalization (relative, absolute, Windows-to-POSIX, missing file).

### Phase 2 — Sidebar TreeView
- Implement `TraceTreeProvider` in `src/frontend/trace_tree_provider.ts`.
- Wire `TraceTreeProvider` into `TraceFrontend` / `src/extension.ts` and `package.json`.
- Unit tests for tree hierarchy, empty/active-session states, and clickable `openLocation` commands.

### Phase 3 — Webview Inspector
- Implement `TraceWebviewPanel` in `src/frontend/trace_webview.ts` with CSP nonce, HTML escaping, paged instruction loading, tabs (Overview, Instructions, History, Stats, Profile, Fault Origin), and export handlers.
- Unit tests for HTML escaping, paging/filtering logic, and message handling.

### Phase 4 — Text Document Links & Polish
- Implement `TraceDocumentLinkProvider` in `src/frontend/trace_link_provider.ts` for untitled decode/origin documents.
- Add setting `platformio-debug.trace.openInspectorOnDecode` (optional) and update `TraceFrontend` so `inspectCapture` / `decode` can refresh the TreeView automatically.
- Run `npm run build` and `npm test`.
