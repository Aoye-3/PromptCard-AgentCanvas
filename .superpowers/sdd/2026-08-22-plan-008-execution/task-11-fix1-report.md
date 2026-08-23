# Plan 008 Task 11 Fix 1 Report

## Outcome

Resolved the independent review's one Critical and one Important finding.

- Every image duplicate path now removes the source node's Storage-owned `referenceCode` immediately and marks the local node with ephemeral `meta.referenceCodePending: true`.
- Project create/update serialization removes both public-code projections and the ephemeral pending marker, so the marker never enters canonical Canvas JSON. The existing top-level image `transient` business field is unchanged because Storage intentionally withholds CVM identity from transient images.
- Auto-save responses merge only a namespace-valid CVT/CVM projection into the current local node with the same ID and kind. A successful identity backfill clears the local pending marker. Stored title, content, position, size, annotations, and arbitrary metadata are never spread over the current node, so a late response cannot overwrite edits made after the request started.
- Task 11 rejects pending nodes and every non-unique CVT/CVM projection in the Canvas before constructing a context-pack request. Task 9 also rejects an identity-pending node even if malformed local state still contains a canonical-looking code.
- Copy Codex inspection/revocation now shares a monotonically increasing request token bound to dialog generation, operation kind, and exact canonical CVC. Editing the input invalidates the old request immediately; stale resolve/reject/finally settlements cannot update input, inspection, pending, revocation, or error state.

There is no text-node duplicate feature in the current UI. Both existing image duplication routes are covered by the shared lifecycle helper: image menu/Ctrl+D through `duplicateCanvasImageNode`, and clipboard Ctrl+C/Ctrl+V through `FreeCanvasBuilderScreen`.

## TDD evidence

### RED

The initial focused run passed the 29 contract tests, then produced five failures among 29 Vitest cases. Four were valid behavior failures and one was a new-test fixture scope error, corrected before continuing:

- duplicate retained the source CVM;
- auto-save response did not backfill the copied node CVM;
- pending inspection reset a newer input;
- late revoke A replaced inspection B.

The corrected/additional RED run produced three more behavior failures among 48 cases:

- Task 11 accepted a copied node carrying the source CVM;
- project write payload retained the ephemeral pending marker;
- Task 9 copied a pending node carrying a canonical-looking CVM.

The first sandboxed Vitest attempt could not spawn repository-local esbuild (`EPERM`); the identical command was rerun with process permission to record the application RED.

### GREEN

Final Task 11/Task 9 focused frontend command:

```text
npm.cmd test -- --run \
  src/domain/reference-codes/reference-code.test.ts \
  src/domain/free-canvas/free-canvas-project.test.ts \
  src/domain/free-canvas/canvas-command-history.test.ts \
  src/domain/context-packs/context-pack.test.ts \
  src/domain/projects/project-storage-merge.test.ts \
  src/storage/storage-service-client.test.ts \
  src/components/canvas/image-actions/CanvasReferenceCodeAction.test.tsx \
  src/components/canvas/image-actions/ImageActionMenu.test.tsx \
  src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx \
  src/components/canvas/context-packs/CopyCodexContext.test.tsx \
  scripts/e2e-fixture-cleanup.test.ts
```

Result: 11 files passed, 161/161 tests passed. Its pretest contract gate passed 29/29. The only stderr was the existing `MultiViewGroupPanel` duplicate `item-left` React-key warning.

Focused Storage identity/context-pack regression:

```text
.\.venv\Scripts\python.exe -m pytest \
  promptcard_storage/tests/test_context_packs_v11.py \
  promptcard_storage/tests/test_canvas_reference_resolution.py -q
```

Result: 33 tests passed, 58 subtests passed. Pytest retained the existing workspace ACL warning for `.pytest_cache`.

## Browser evidence

Combined real-service browser command:

```text
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path '.playwright-browsers').Path
npx.cmd playwright test \
  tests/e2e/copy-codex-context.spec.ts \
  tests/e2e/free-canvas-copy-code.spec.ts --workers=1
```

Result: 4/4 scenarios passed in 1.2 minutes.

The Task 11 scenario uses the real image duplicate menu and real Task 10 Storage routes. It lets the first duplicate PUT reach Storage but delays its response, drags the duplicate while that response is late, then proves:

- neither `referenceCode` nor `referenceCodePending` entered the project write;
- the later write and final Storage project retain the newer duplicate position;
- original and duplicate have two distinct CVM codes;
- only the duplicate is selected and previewed;
- context-pack POST contains only the duplicate CVM;
- real resolve and focus-independent inspection contain the duplicate title and CVM, exclude the original CVM, and remain byte-for-byte stable across project focus change;
- real revocation makes subsequent resolve return 410.

The three Task 9 scenarios continue to pass for project/text keyboard copy, image mouse copy with clipboard retry, unsupported nodes, menu reachability, and narrow layouts.

## Build and lint

`npm.cmd run build` passed TypeScript and Vite with 1,911 modules. Existing warnings remain for the `.w-2/3` CSS selector, mixed Tauri imports, and large chunks.

Repository lint has no finding in a Task 11 Fix 1 file. It remains non-zero only from the two pre-existing errors in `src/domain/free-canvas/free-canvas-project.ts:950` and `tests/e2e/free-canvas-multi-view.spec.ts:17`, plus 41 pre-existing warnings.

## Scope and workspace state

No dependency, backend contract, schema, fixture, worktree, clone, or alternate checkout was added. The unrelated untracked plan draft and five pre-existing deleted runtime fixture files were not staged or changed.
