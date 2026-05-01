# Implementation Plan for v1.2.0

**Target Release**: 1.2.0  
**Status**: Planning Phase  
**Last Updated**: 2026-05-01

---

## Overview

This document outlines the implementation plan for version 1.2.0 of the PlatformIO VSCode Debug extension. The four major features planned are:

1. Enhanced peripheral viewer with SVD file support
2. Improved memory editor with data visualization
3. RTOS thread awareness
4. Better error messages and diagnostics

---

## Feature 1: Enhanced Peripheral Viewer with SVD File Support

### Current State
- Basic SVD parsing exists at `src/frontend/peripheral.ts`
- Uses `fast-xml-parser` for XML processing
- Supports peripherals, clusters, registers, and fields
- Current value display with hex/binary/decimal formatting

### Planned Enhancements

| Priority | Task | Effort | Files to Modify |
|----------|------|--------|-----------------|
| High | Add SVD file search/discovery from common paths | 2d | `peripheral.ts`, `extension.ts` |
| High | Implement peripheral search/filter UI | 2d | `peripheral.ts` |
| High | Add register change highlighting (diff from reset) | 3d | `peripheral.ts` |
| Medium | Support for SVD `<derivedFrom>` attribute | 2d | `peripheral.ts` |
| Medium | Add peripheral register bit-field tooltip documentation | 1d | `peripheral.ts` |
| Low | Export peripheral register map to JSON/Markdown | 2d | New file |

### Technical Details

#### SVD File Discovery
```typescript
// New method in PeripheralTreeProvider
private findSVDFile(deviceName: string): string | undefined {
    const searchPaths = [
        `${workspaceRoot}/.vscode/*.svd`,
        `${workspaceRoot}/*.svd`,
        `${platformioPackages}/framework-*/svd/*.svd`,
        `${platformioPackages}/tool-openocd/svd/*.svd`,
    ];
    // Search logic here
}
```

#### Change Tracking
- Store `previousValue` alongside `currentValue` in `RegisterNode`
- Compare on each update to detect changes
- Apply VSCode decoration (e.g., colored background) to changed registers

#### Search/Filter UI
- Use VSCode `QuickPick` API with `canPickMany: false`
- Filter peripherals by name or base address
- Keyboard shortcut: `Ctrl+Shift+P` → "Peripherals: Search"

---

## Feature 2: Improved Memory Editor with Data Visualization

### Current State
- Read-only hex dump at `src/frontend/memory_content_provider.ts`
- ASCII view on the right side
- Basic selection highlighting
- History tracking in `src/frontend/memory_tree_provider.ts`

### Planned Enhancements

| Priority | Task | Effort | Files to Modify |
|----------|------|--------|-----------------|
| High | Add editable memory cells (write support) | 3d | `memory_content_provider.ts`, `adapter.ts` |
| High | Add data type interpretation (u8/16/32/64, float, double) | 3d | `memory_content_provider.ts` |
| High | Add ASCII/string view toggle | 1d | `memory_content_provider.ts` |
| Medium | Add memory diff/highlighting capabilities | 2d | `memory_content_provider.ts` |
| Medium | Add endianness toggle (little/big) | 1d | `memory_content_provider.ts` |
| Low | Add memory bookmarking/named regions | 2d | `memory_tree_provider.ts` |

### Technical Details

#### Memory Write Implementation
```typescript
// New command in extension.ts
private async writeMemory(address: number, data: Uint8Array): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) return;
    
    await session.customRequest('write-memory', {
        address,
        data: Buffer.from(data).toString('hex')
    });
}
```

#### Data Type Visualization
- Add toolbar dropdown to memory view
- Support: u8, u16, u32, u64, i8, i16, i32, i64, float, double
- Re-interpret bytes according to selected type and endianness
- Display in separate column alongside hex view

#### Editing Workflow
1. User clicks on hex byte in editor
2. Input box appears for new value
3. Validate input (hex format)
4. Call `write-memory` debug request
5. Refresh view on success

---

## Feature 3: RTOS Thread Awareness

### Current State
- No RTOS support exists
- Basic thread handling in `adapter.ts` (GDB thread events)
- Uses `ThreadEvent` from `@vscode/debugadapter`

### Planned Enhancements

| Priority | Task | Effort | Files to Modify |
|----------|------|--------|-----------------|
| High | Create RTOS detection mechanism | 3d | New file `rtos.ts` |
| High | Implement FreeRTOS thread parser | 3d | `rtos.ts` |
| High | Add thread-aware stack frame mapping | 4d | `adapter.ts` |
| Medium | Implement ThreadX support | 2d | `rtos.ts` |
| Medium | Implement Zephyr support | 2d | `rtos.ts` |
| Medium | Add thread state display (blocked, ready, running) | 2d | `adapter.ts` |
| Low | Add thread priority display | 1d | `adapter.ts` |

### Technical Details

#### RTOS Detection
```typescript
// New file: src/backend/rtos.ts
export enum RTOSType {
    None = 'none',
    FreeRTOS = 'freertos',
    ThreadX = 'threadx',
    Zephyr = 'zephyr',
    Unknown = 'unknown'
}

export class RTOSDetector {
    async detect(miDebugger: MI2): Promise<RTOSType> {
        // Check for FreeRTOS: look for pxCurrentTCB symbol
        // Check for ThreadX: look for _tx_thread_current_ptr
        // Check for Zephyr: look for _kernel.current
    }
}
```

#### Thread Parsing (FreeRTOS Example)
```typescript
interface RTOSThread {
    id: number;
    name: string;
    state: 'running' | 'ready' | 'blocked' | 'suspended';
    priority: number;
    stackPointer: number;
    stackInfo?: { base: number; size: number; used: number };
}

class FreeRTOSThreadParser {
    async parseThreads(miDebugger: MI2): Promise<ROSThread[]> {
        // Read pxCurrentTCB to get current task
        // Walk ready/blocked/suspended lists
        // Parse TCB structures from memory
    }
}
```

#### Configuration
```json
{
    "name": "PIO Debug",
    "type": "platformio-debug",
    "request": "launch",
    "rtos": {
        "type": "auto",
        "enabled": true
    }
}
```

#### Thread State Mapping
| FreeRTOS State | VSCode Thread State |
|----------------|---------------------|
| Running | `running` |
| Ready | `ready` |
| Blocked | `paused` |
| Suspended | `paused` |
| Deleted | `exited` |

---

## Feature 4: Better Error Messages and Diagnostics

### Current State
- Basic error messages in `src/extension.ts`
- Generic GDB/MI error handling
- No structured diagnostic system

### Planned Enhancements

| Priority | Task | Effort | Files to Modify |
|----------|------|--------|-----------------|
| High | Create centralized error message system | 2d | New file `diagnostics.ts` |
| High | Add connection troubleshooting wizard | 3d | `diagnostics.ts` |
| High | Improve GDB/MI error parsing | 2d | `mi2/mi2.ts` |
| Medium | Add diagnostic logging panel | 2d | `extension.ts` |
| Medium | Add SVD parse error recovery with suggestions | 1d | `peripheral.ts` |
| Low | Add "Report Issue" command with context collection | 2d | `extension.ts` |

### Technical Details

#### Centralized Error System
```typescript
// New file: src/diagnostics.ts
export interface ErrorAction {
    label: string;
    callback: () => void;
}

export class DiagnosticsManager {
    showError(message: string, actions?: ErrorAction[]): void {
        if (actions && actions.length > 0) {
            vscode.window.showErrorMessage(message, ...actions.map(a => a.label))
                .then(selected => {
                    const action = actions.find(a => a.label === selected);
                    action?.callback();
                });
        } else {
            vscode.window.showErrorMessage(message);
        }
    }
    
    // Predefined error patterns with solutions
    handleGDBConnectionError(error: string): void {
        // Suggest checking OpenOCD/GDB server status
        // Offer to restart debug session
    }
}
```

#### Common Error Patterns
| Error Pattern | Suggested Action |
|---------------|------------------|
| "Connection refused" | Check OpenOCD status, port availability |
| "No such file or directory" | Verify SVD file path in launch.json |
| "Cannot access memory" | Target may not be halted; try pausing |
| "Remote replied with error" | GDB server protocol mismatch |

#### Diagnostic Logging
- Add output channel: "PlatformIO Debug Diagnostics"
- Log all GDB/MI commands and responses when `showDevDebugOutput: true`
- Log peripheral/memory operations
- Export diagnostic log for bug reports

---

## pioarduino-vscode-ide Integration Changes

The `pioarduino-vscode-ide` extension (`https://github.com/pioarduino/pioarduino-vscode-ide`) defines the UI layer (commands, views, menus) while this debug extension provides the implementation. The following changes are needed in the IDE extension:

### package.json Changes Required

#### New Commands to Add
```json
{
  "command": "platformio-debug.peripherals.search",
  "title": "Search Peripherals",
  "category": "PlatformIO Debug",
  "icon": "$(search)"
},
{
  "command": "platformio-debug.memory.edit",
  "title": "Edit Memory",
  "category": "PlatformIO Debug",
  "icon": "$(edit)"
},
{
  "command": "platformio-debug.memory.setDataType",
  "title": "Set Data Type",
  "category": "PlatformIO Debug"
},
{
  "command": "platformio-debug.memory.toggleEndianness",
  "title": "Toggle Endianness",
  "category": "PlatformIO Debug"
},
{
  "command": "platformio-debug.rtos.refreshThreads",
  "title": "Refresh RTOS Threads",
  "category": "PlatformIO Debug",
  "icon": "$(refresh)"
},
{
  "command": "platformio-debug.diagnostics.showLog",
  "title": "Show Debug Diagnostics",
  "category": "PlatformIO Debug"
}
```

#### New Configuration Properties
```json
"platformio-debug.rtos.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Enable RTOS thread awareness (FreeRTOS, ThreadX, Zephyr)"
},
"platformio-debug.rtos.type": {
  "type": "string",
  "enum": ["auto", "FreeRTOS", "ThreadX", "Zephyr", "none"],
  "default": "auto",
  "description": "RTOS type for thread awareness (auto-detect if not specified)"
},
"platformio-debug.memory.defaultDataType": {
  "type": "string",
  "enum": ["u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "float", "double"],
  "default": "u8",
  "description": "Default data type for memory view"
},
"platformio-debug.memory.defaultEndianness": {
  "type": "string",
  "enum": ["little", "big"],
  "default": "little",
  "description": "Default endianness for memory view"
},
"platformio-debug.diagnostics.showDevDebugOutput": {
  "type": "boolean",
  "default": false,
  "description": "Show detailed diagnostic logs for troubleshooting"
}
```

#### New Views (Optional)
- **RTOS Threads Panel**: Add to debug view container alongside peripherals/registers
- **Diagnostics Panel**: Output channel for diagnostic messages

### File Locations in IDE Extension
```
https://github.com/pioarduino/pioarduino-vscode-ide/
├── package.json              (modify: add commands, config, views)
├── syntaxes/                 (existing: language definitions)
└── src/                      (if UI logic needed, typically just package.json)
```

---

## Proposed File Structure (Debug Extension)

```
src/
├── backend/
│   ├── adapter.ts              (modify: RTOS thread awareness)
│   ├── mi2/
│   │   ├── mi2.ts              (modify: error parsing)
│   │   └── types.ts            (may need RTOS types)
│   ├── rtos.ts                 (NEW: RTOS parsers)
│   └── symbols.ts              (existing)
├── frontend/
│   ├── peripheral.ts           (modify: SVD enhancements)
│   ├── memory_content_provider.ts  (modify: editing/visualization)
│   ├── memory_tree_provider.ts (modify: bookmarks)
│   └── diagnostics.ts          (NEW: error handling)
├── common.ts                   (modify: add types)
└── extension.ts                (modify: register commands)
```

---

## Development Phases

### Phase 1: Foundation
- [x] Create `diagnostics.ts` with error handling framework
- [x] Implement diagnostic logging panel
- [x] Add centralized error message system
- [x] **IDE Extension**: Add diagnostic configuration to `package.json`

### Phase 2: Memory Editor
- [x] Add `write-memory` support in `adapter.ts`
- [x] Implement editable hex view in `memory_content_provider.ts`
- [x] Add data type interpretation panel
- [x] Add endianness toggle
- [x] **IDE Extension**: Add memory edit commands and configuration to `package.json`

### Phase 3: SVD Enhancements
- [ ] Implement SVD file discovery
- [ ] Add peripheral search/filter UI
- [ ] Implement change highlighting
- [ ] Add `<derivedFrom>` support
- [ ] **IDE Extension**: Add peripheral search command to `package.json`

### Phase 4: RTOS Support
- [ ] Create RTOS detection mechanism
- [ ] Implement FreeRTOS parser
- [ ] Add thread-aware stack mapping
- [ ] Add ThreadX and Zephyr support
- [ ] **IDE Extension**: Add RTOS configuration and thread refresh command to `package.json`

### Phase 5: Polish & Testing
- [ ] Integration testing for all features
- [ ] **IDE Extension**: Test all new commands and configurations
- [ ] Documentation updates
- [ ] Bug fixes and edge cases

---

## Testing Requirements

| Feature | Unit Tests | Integration Tests | Manual Tests |
|---------|------------|-------------------|--------------|
| SVD Enhancements | SVD parsing edge cases | Search/filter UI | Real device SVD load |
| Memory Editor | Data type conversions | Write operations | Various memory regions |
| RTOS Awareness | Mock RTOS structures | Thread switching | FreeRTOS/ThreadX/Zephyr targets |
| Diagnostics | Error pattern matching | Troubleshooting wizard | Various error scenarios |

---

## Test Generation Plan

### New Test Files to Create

#### 1. SVD Enhancements Tests
```
__tests__/
├── frontend/
│   ├── svd-file-discovery.test.ts          (NEW: SVD path resolution)
│   ├── peripheral-search.test.ts           (NEW: search/filter logic)
│   ├── register-change-tracking.test.ts    (NEW: value diff detection)
│   └── svd-derivedfrom.test.ts             (NEW: inheritance parsing)
```

**Test Coverage Targets:**
- SVD file discovery: Test all search path patterns
- Peripheral search: Test fuzzy matching, case sensitivity
- Change tracking: Verify highlighting triggers on value change
- `<derivedFrom>`: Test circular references, nested inheritance

#### 2. Memory Editor Tests
```
__tests__/
├── frontend/
│   ├── memory-write.test.ts              (NEW: write-memory request)
│   ├── memory-data-types.test.ts         (NEW: type interpretation)
│   ├── memory-endianness.test.ts         (NEW: byte order handling)
│   └── memory-bookmarks.test.ts          (NEW: named regions)
├── backend/
│   └── adapter-write-memory.test.ts      (NEW: write-memory handler)
```

**Test Coverage Targets:**
- Write operations: Test byte alignment, partial writes
- Data types: Test u8/u16/u32/u64/i8/i16/i32/i64/float/double
- Endianness: Verify little/big endian conversion
- Input validation: Test invalid hex, out-of-bounds addresses

#### 3. RTOS Awareness Tests
```
__tests__/
├── backend/
│   ├── rtos-detector.test.ts             (NEW: auto-detection logic)
│   ├── freertos-parser.test.ts           (NEW: FreeRTOS TCB parsing)
│   ├── threadx-parser.test.ts            (NEW: ThreadX thread parsing)
│   ├── zephyr-parser.test.ts             (NEW: Zephyr kernel parsing)
│   └── rtos-thread-mapping.test.ts       (NEW: thread-to-frame mapping)
```

**Test Coverage Targets:**
- Detection: Mock GDB symbol table responses
- FreeRTOS: Test TCB structure parsing, state mapping
- ThreadX: Test thread list walking
- Zephyr: Test kernel thread table access
- Thread mapping: Verify frame ID assignment

#### 4. Diagnostics Tests
```
__tests__/
├── diagnostics/
│   ├── error-pattern-matching.test.ts    (NEW: error classification)
│   ├── diagnostics-manager.test.ts       (NEW: error actions)
│   └── troubleshooting-wizard.test.ts  (NEW: diagnostic flow)
```

**Test Coverage Targets:**
- Error patterns: Test regex matching for common GDB errors
- Actions: Verify callback execution for error actions
- Logging: Test output channel formatting

### Modified Existing Tests

Files requiring updates for new functionality:

| File | Changes Needed |
|------|----------------|
| `__tests__/frontend/device-defaults.test.ts` | Add tests for SVD inheritance |
| `__tests__/mi2/breakpoint-parsing.test.ts` | Verify still passes (regression check) |
| `__tests__/backend/breakpoint-error-handling.test.ts` | Add error classification tests |

### Test Infrastructure

#### Mock Data Files
```
__tests__/
├── mocks/
│   ├── rtos/
│   │   ├── freertos-tcb.bin          (Mock TCB structures)
│   │   ├── threadx-thread.bin        (Mock ThreadX thread)
│   │   └── zephyr-kernel.bin         (Mock Zephyr kernel)
│   ├── svd/
│   │   ├── test-device.svd           (Test SVD with derivedFrom)
│   │   └── search-test/              (Directory for discovery tests)
│   └── memory/
│       └── test-regions.json         (Memory test configurations)
```

#### Test Utilities (New)
```typescript
// __tests__/utils/rtos-mocks.ts
export function createMockTCB(state: string, priority: number): Buffer;
export function createMockThreadList(count: number): Buffer;

// __tests__/utils/memory-mocks.ts  
export function createMockMemoryBuffer(size: number, pattern: string): number[];
export function validateMemoryWrite(address: number, data: string): boolean;
```

### Regression Test Suite

All existing tests must pass:
```bash
npm test
# Expected: 133 tests passing (current) + new tests
```

New features should not break:
- MI2/MI3/MI4 protocol compatibility
- Existing peripheral viewer functionality
- Current memory read operations
- Breakpoint handling

### Test-Driven Development Order

1. **Write failing tests first** for each feature
2. **Implement feature** to make tests pass
3. **Refactor** while maintaining test coverage
4. **Add edge case tests** after initial implementation

### Coverage Requirements by Feature

| Feature | Minimum Coverage | Critical Paths |
|---------|------------------|----------------|
| SVD Enhancements | 85% | File discovery, change detection |
| Memory Editor | 90% | Write operations, type conversion |
| RTOS Awareness | 80% | Detection, thread parsing |
| Diagnostics | 85% | Error classification, actions |

---

## Dependencies

- No new runtime dependencies expected
- May require `@types/node` updates for buffer operations
- Development dependencies: jest for testing (already present)

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| RTOS parsing fragile across versions | High | Implement version detection, graceful fallback |
| Memory write safety | High | Add confirmation dialogs, validate addresses |
| SVD file discovery performance | Low | Cache search results, async loading |
| GDB/MI version differences | Medium | Test with MI2/MI3/MI4 (already supported) |

---

## Success Criteria

### Debug Extension (pioarduino-vscode-debug)
- [ ] All 4 feature areas have measurable improvements
- [ ] Test coverage > 80% for new code
- [ ] No regressions in existing functionality (133 tests passing)
- [ ] Documentation updated in README.md
- [ ] CHANGELOG.md updated with detailed entries

### IDE Extension (pioarduino-vscode-ide)
- [ ] All new commands registered in `package.json`
- [ ] New configuration properties added and functional
- [ ] No conflicts with existing debug commands
- [ ] Updated extension README with new features

---

## Notes

- Keep backward compatibility with MI2 protocol
- Maintain support for existing launch.json configurations
- Follow existing code style (no semicolons, single quotes, 4-space indent)
- Reuse existing utility functions from `src/utils.ts`

## Release Coordination

The debug extension and IDE extension releases should be coordinated:

1. **Debug Extension Release**: Must be published first (contains implementation)
2. **IDE Extension Release**: Published after with updated `package.json` (contains UI definitions)

Both extensions can be developed in parallel, but the IDE extension's package.json changes should reference commands/features that exist in the debug extension version it depends on.

### Version Compatibility

| IDE Extension | Debug Extension | Notes |
|---------------|-----------------|-------|
| 1.3.x | 1.1.x | Current stable |
| 1.4.x | 1.2.0 | With v1.2.0 features |

### Files to Modify in IDE Extension

Location: `https://github.com/pioarduino/pioarduino-vscode-ide/package.json`

Key sections to update:
- `contributes.commands` - Add new command definitions
- `contributes.menus` - Add menu items for new commands  
- `contributes.configuration` - Add new configuration properties
- `contributes.views` - Add new RTOS/diagnostics views if applicable
