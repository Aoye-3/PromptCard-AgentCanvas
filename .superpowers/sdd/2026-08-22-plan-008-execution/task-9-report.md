# Plan 008 Task 9 Report — Canvas reference-code copy UI

## Outcome

Implemented explicit copy-code actions for the active Canvas project (`PRJ-...`), stable text nodes (`CVT-...`), and stable image placement nodes (`CVM-...`). The UI consumes only Storage response projections, uses the shared strict public-code validator and Task 7 clipboard feedback hook, and never derives a fallback code.

Unsupported, transient, running, missing, and invalid node states expose a disabled menu item with an explanatory status. Mouse, Enter, and Space activation are isolated from Canvas selection/editor/command handlers; retry and stale async settlement use the existing scoped clipboard hook. The project header and menus wrap without horizontal overflow at narrow widths.

Response DTO fields are additive and optional. Canvas normalization preserves supported response projection fields, while Storage create/update serialization strips project and node `referenceCode` fields before writing.

## Changed files

- `src/components/canvas/FreeCanvasBuilderScreen.tsx`
- `src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx`
- `src/components/canvas/image-actions/CanvasReferenceCodeAction.tsx`
- `src/components/canvas/image-actions/CanvasReferenceCodeAction.test.tsx`
- `src/components/canvas/image-actions/CanvasUnsupportedNodeContextMenu.tsx`
- `src/components/canvas/image-actions/CanvasNodeContextMenu.tsx`
- `src/components/canvas/image-actions/CanvasTextNodeContextMenu.tsx`
- `src/components/canvas/image-actions/ImageActionMenu.test.tsx`
- `src/domain/reference-codes/reference-code.ts`
- `src/domain/reference-codes/reference-code.test.ts`
- `src/domain/free-canvas/free-canvas-project.ts`
- `src/domain/free-canvas/free-canvas-project.test.ts`
- `src/models/PromptHistory.model.ts`
- `src/storage/storage-service-client.ts`
- `src/storage/storage-service-client.test.ts`
- `tests/e2e/free-canvas-copy-code.spec.ts`
- `.superpowers/sdd/2026-08-22-plan-008-execution/task-9-report.md`

## TDD evidence

### RED

1. Initial component/storage/validator run:
   - Command: `npm.cmd test -- --run src/domain/reference-codes/reference-code.test.ts src/storage/storage-service-client.test.ts src/components/canvas/image-actions/CanvasReferenceCodeAction.test.tsx src/components/canvas/image-actions/ImageActionMenu.test.tsx`
   - Result: 4 files failed; 6 tests failed and 35 passed. Failures proved the shared validator/action module did not exist, write payloads retained response-only fields, and Canvas menus had no copy-code action.
2. Screen wiring run:
   - Command: `npm.cmd test -- --run src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx -t "wires...|opens..."`
   - Result: 2 failed and 30 skipped. The project action and unsupported-node menu were absent.
3. Keyboard isolation run:
   - Command: `npm.cmd test -- --run src/components/canvas/image-actions/CanvasReferenceCodeAction.test.tsx -t "activates node-code copy directly"`
   - Result: 2 failed and 3 skipped. Enter/Space did not prevent their native/global default before explicitly activating code copy.
4. Response normalization run:
   - Command: `npm.cmd test -- --run src/domain/free-canvas/free-canvas-project.test.ts -t "preserves response-only reference codes"`
   - Result: 1 failed and 38 skipped; normalized nodes returned `[undefined, undefined]` instead of the response CVT/CVM projections.

The first sandboxed Vitest launch also failed before test collection with `spawn EPERM`; the same command was rerun outside that process restriction to obtain the application RED result above.

### GREEN

- Final Task 9 focused suite:
  - Command: `npm.cmd test -- --run src/domain/reference-codes/reference-code.test.ts src/domain/free-canvas/free-canvas-project.test.ts src/storage/storage-service-client.test.ts src/components/canvas/image-actions/CanvasReferenceCodeAction.test.tsx src/components/canvas/image-actions/ImageActionMenu.test.tsx src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx`
  - Result: 6 files passed; 117/117 tests passed in 2.70 s. Existing `MultiViewGroupPanel` duplicate `item-left` key warnings remain.
- Task 7 copy-code regression:
  - Command: `npm.cmd test -- --run src/components/prompt-media/useClipboardCopyFeedback.test.tsx src/domain/prompt-media/prompt-media.test.ts src/components/prompt-media/PromptPresetPreviewDialog.test.tsx src/components/PromptLibraryPreviewMode.test.ts src/stores/preset.store.test.ts`
  - Result: 5 files passed; 32/32 tests passed.
- Production build:
  - Command: `npm.cmd run build`
  - Result: passed; 1,908 modules transformed. Existing CSS selector, mixed Tauri import, and large-chunk warnings remain.
- Lint:
  - Command: `npm.cmd run lint`
  - Result: Task 9 files introduced no lint findings. Repository-wide lint remains non-zero with 2 pre-existing errors (`src/domain/free-canvas/free-canvas-project.ts:950` constant loop and `tests/e2e/free-canvas-multi-view.spec.ts:17` empty object pattern) plus 41 pre-existing warnings.

## Browser evidence

- Spec: `tests/e2e/free-canvas-copy-code.spec.ts`, Chromium with the repository-local `.playwright-browsers` cache.
- Real Storage create responses supplied the exact project/text/image public codes; the spec covers project Enter, text Space, image mouse rejection/retry, unsupported arrow state, selection/editor/dialog/write invariants, console errors, and 320/768 overflow.
- RED browser diagnostics found and drove two fixes:
  - React Flow selection synchronization closed a newly opened context menu.
  - Exact failing locator after that fix: `tests/e2e/free-canvas-copy-code.spec.ts:55`, `expect.poll(() => clipboardText(page)).toBe(textCode)`. The menu button was disabled because Canvas normalization discarded its response `referenceCode`; clipboard therefore retained `Task 9 text content` rather than the expected `CVT-...`.
- The normalization defect is now covered by a focused regression test and fixed. A final post-fix browser run did not finish within the required 60-second outer limit and was terminated; Playwright emitted no later failing locator before termination. Therefore a complete post-fix browser pass, including the 320/768 tail, is not claimed.
- Each normally failed run executed its `finally` cleanup. The two runs intentionally terminated at the outer limit left exact fixtures; `copy-code-1787430836421` and `copy-code-1787431072035` were subsequently trashed and permanently deleted through the Storage store API.

## Commit

Single implementation commit subject: `feat(canvas): copy public reference codes`. This report is part of that commit; the resolved commit hash is recorded in the parent handoff because a commit cannot contain its own final hash.

## Concerns

- Browser verification remains incomplete because the post-fix runner exceeded the mandated outer time limit during the test/service lifecycle and was stopped. The last concrete browser failure is fixed and protected by unit/component coverage, but the E2E spec should be rerun in an already-running E2E service session to avoid web-server startup/teardown consuming the outer limit.
- Existing duplicate React keys, repository lint baseline failures, CSS syntax warning, and bundle-size warnings are outside Task 9 scope and were not changed.
