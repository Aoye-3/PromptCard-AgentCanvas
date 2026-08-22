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
- `src/components/canvas/image-actions/CanvasContextMenu.tsx`
- `src/components/canvas/image-actions/image-action-ui.ts`
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
- `scripts/e2e-fixture-cleanup.ts`
- `scripts/e2e-fixture-cleanup.test.ts`
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
  - Result after the browser-gate fixes: 6 files passed; 119/119 tests passed in 2.27 s. Existing `MultiViewGroupPanel` duplicate `item-left` key warnings remain.
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

- Spec: `tests/e2e/free-canvas-copy-code.spec.ts`, Chromium with the repository-local `node_modules/.cache/ms-playwright` cache.
- Real Storage create responses supplied the exact project/text/image public codes; the spec covers project Enter, text Space, image mouse rejection/retry, unsupported arrow state, selection/editor/dialog/write invariants, console errors, and 320/768 overflow.
- RED browser diagnostics found and drove two fixes:
  - React Flow selection synchronization closed a newly opened context menu.
  - Exact failing locator after that fix: `tests/e2e/free-canvas-copy-code.spec.ts:55`, `expect.poll(() => clipboardText(page)).toBe(textCode)`. The menu button was disabled because Canvas normalization discarded its response `referenceCode`; clipboard therefore retained `Task 9 text content` rather than the expected `CVT-...`.
- Subsequent RED runs exposed two real menu-accessibility defects at the default 1280x720 viewport: the long image menu was clamped under the global header, and an all-disabled unsupported menu had no focus target for Escape. Focused tests first failed for the missing safe layout helper and missing `tabIndex=-1`; the production fix now reserves the 56px app header plus 12px padding, constrains menu height to the remaining viewport with scrolling, and focuses the menu container when no enabled item exists.
- The original monolithic browser scenario was split into three independently cleaned scenarios with 60-second budgets and minimum fixture data:
  - project Enter + text Space + no workspace mutation: `1 passed (30.2s)`;
  - image normal mouse reject/retry + long-menu first/last reachability with a real Storage asset: `1 passed (36.3s)`;
  - unsupported arrow + Escape + 320/768 overflow: `1 passed (24.6s)`.
- Complete spec result after adding console-error/write invariants: `3 passed (41.4s)` using two workers. Every scenario executed exact project trash plus permanent-delete cleanup in its own `finally` block; the image scenario also trashed and permanently deleted its uploaded Storage asset.
- Fixtures left by intentionally stopped diagnostic runs were enumerated by exact `copy-code-*` IDs, then trashed and permanently deleted through the Storage store API.

## Commit

Single implementation commit subject: `feat(canvas): copy public reference codes`. This report is part of that commit; the resolved commit hash is recorded in the parent handoff because a commit cannot contain its own final hash.

Browser-gate fix commit subject: `fix(canvas): keep reference menus reachable`.

Review fix round 1 commit subject: `fix(canvas): reject transient image references`.

Review fix round 2 commit subject: `fix(canvas): preserve transient image state`.

## Review fix round 1

- RED command: `npm.cmd test -- --run src/components/canvas/image-actions/CanvasReferenceCodeAction.test.tsx scripts/e2e-fixture-cleanup.test.ts`.
  - Result: the three valid-CVM `running`/`failed`/top-level-`transient` cases all failed because their buttons were enabled; the cleanup suite failed to load because the helper did not exist. The first sandboxed attempt was blocked by `esbuild spawn EPERM`, so the same command was rerun with workspace process permission to record the application RED.
- Fix: image lifecycle/transient state is now evaluated before CVM validation, and the validated state result—not the raw projection—is passed into the shared copy action. Running, failed, and transient images expose distinct reasons and never call the clipboard even if a canonical CVM is present.
- Fixture hardening: the image browser fixture acquires nullable asset/project handles inside `try`; `cleanupAcquiredFixtures` uses `Promise.allSettled`, attempts project and asset cleanup independently, and throws an `AggregateError` containing every cleanup failure. Unit tests prove asset cleanup still runs after project acquisition failure and after project cleanup rejection.
- GREEN focused command: `npm.cmd test -- --run src/domain/reference-codes/reference-code.test.ts src/domain/free-canvas/free-canvas-project.test.ts src/storage/storage-service-client.test.ts src/components/canvas/image-actions/CanvasReferenceCodeAction.test.tsx src/components/canvas/image-actions/ImageActionMenu.test.tsx src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx scripts/e2e-fixture-cleanup.test.ts`.
  - Result: 7 files passed; 124/124 tests passed. Only the existing duplicate `item-left` React-key warning remains.
- Browser command: repository-local Chromium, `npx.cmd playwright test tests/e2e/free-canvas-copy-code.spec.ts --workers=1`.
  - Result: the original three required scenarios passed in 42.7s (16.0s project/text, 17.0s image retry/menu, 1.5s unsupported/responsive). A proposed route-injected running/CVM scenario was removed after review; the malicious valid-code/state combination is deterministically covered by the focused component tests, while the browser spec retains real Storage projections and no test route infrastructure.
- Production build: `npm.cmd run build` passed with 1,908 modules; only the previously recorded CSS, Tauri import, and large-chunk warnings remain.

## Review fix round 2

- Storage authority check: `promptcard_storage/store.py::_is_stable_canvas_image` reads top-level `node.transient is True`, and the Task 8 Storage test supplies it in the create payload. It is therefore a persisted business field, not a response-only projection; create/update payloads must retain it while continuing to strip `referenceCode`.
- RED command: `npm.cmd test -- --run src/domain/free-canvas/free-canvas-project.test.ts src/components/canvas/image-actions/CanvasReferenceCodeAction.test.tsx`.
  - Result: 2 tests failed and 47 passed. Image normalization produced `[undefined, undefined, undefined]` for strict `true`, strict `false`, and malformed string markers; after real normalization the transient image with a valid CVM was incorrectly enabled.
- Fix: `IFreeCanvasImageNode` now models optional `transient: boolean`; image normalization preserves only strict boolean values and ignores malformed values. Existing image transforms spread the normalized node, so subsequent frame/annotation/generation updates retain the marker. The component reads the typed field directly.
- Regression coverage: after `normalizeFreeCanvasProject`, valid-CVM and malformed-CVM transient images are both disabled with the lifecycle reason and make zero clipboard calls, while a stable valid-CVM image still copies. Storage client tests prove `transient: true` survives create/update serialization while node/project reference projections remain stripped.
- GREEN focused command: `npm.cmd test -- --run src/domain/reference-codes/reference-code.test.ts src/domain/free-canvas/free-canvas-project.test.ts src/storage/storage-service-client.test.ts src/components/canvas/image-actions/CanvasReferenceCodeAction.test.tsx src/components/canvas/image-actions/ImageActionMenu.test.tsx src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx scripts/e2e-fixture-cleanup.test.ts`.
  - Result: 7 files passed; 126/126 tests passed. Only the existing duplicate `item-left` React-key warning remains.
- Browser command: repository-local Chromium, `npx.cmd playwright test tests/e2e/free-canvas-copy-code.spec.ts --workers=1`.
  - Result: 3/3 scenarios passed in 49.2s (24.1s project/text, 14.9s image retry/menu, 1.6s unsupported/responsive).
- Production build: `npm.cmd run build` passed with 1,908 modules; only the previously recorded CSS, Tauri import, and large-chunk warnings remain.

## Concerns

- Existing duplicate React keys, repository lint baseline failures, CSS syntax warning, and bundle-size warnings are outside Task 9 scope and were not changed.
