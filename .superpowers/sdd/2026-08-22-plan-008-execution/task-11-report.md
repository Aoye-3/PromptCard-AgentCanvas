# Task 11 Report: Copy Codex context UI

## Status

Implemented an explicit Copy Codex context workflow on the existing Free Canvas ReactFlow selection. The UI previews only the stable selected `CVT`/`CVM` references in persisted Canvas order, creates a Task 10 CVC against the exact displayed `PRJ` and project revision, retains the created CVC when clipboard permission is denied, and supports focus-independent inspection and idempotent revocation.

No whole-Canvas option, implicit fallback selection, backend contract change, dependency, internal ID, asset path, filesystem path, or URL was added.

## Implementation

### Explicit selection and preview

- Added a focused context-pack domain helper that intersects ReactFlow `selectedNodeIds` with `freeCanvas.nodes` and emits supported nodes in persisted Canvas order.
- Only stable text `CVT` and image `CVM` response projections are accepted. Arrow/image-generator nodes, missing or malformed codes, transient images, and running/failed images are omitted.
- Duplicate selected IDs are collapsed by membership while each persisted node appears at most once.
- Zero selection, zero supported selection, missing canonical `PRJ`, or invalid revision disables creation and explains why. No request is sent.
- The dialog displays the exact `PRJ`, project revision, type, title, and typed code before creation. The fixed placement hint is `after-selection`, with anchors byte-for-byte equal to the ordered explicit `nodeCodes`.
- A revision conflict is fail-closed and instructs the user to close and reopen the preview; the UI never substitutes a newer revision the user did not review.

### Creation and clipboard recovery

- Creation sends exactly `projectCode`, `projectRevision`, `nodeCodes`, `placementHint`, and `creator: "promptcard-ui"` to the Storage context-pack client.
- An in-flight ref prevents double-click creation before React state settles.
- Async generations are invalidated on close/reopen, so stale create/inspect/revoke settlements cannot overwrite a newer dialog session.
- After Storage creates the CVC, the code is rendered visibly before clipboard completion.
- Clipboard rejection keeps the created pack and manual CVC visible. Retry calls only `navigator.clipboard.writeText`; it never repeats `POST /api/context-packs`.
- The existing Task 9 clipboard-feedback hook supplies success/error settlement isolation.

### Inspection and revocation

- A CVC input canonicalizes case and whitespace, then inspection is keyed only by that CVC. It does not send or read the current focused project.
- Inspection shows the frozen project scope/revision, lifecycle, immutable entries, entry reference/type/title, source references, CVC, and snapshot digest.
- Creator/revocation actor metadata is parsed but not displayed. No internal IDs, paths, URLs, provider bodies, or content bytes are rendered.
- Revocation sends the fixed safe business values `actor: "promptcard-ui"` and `reason: "user-revoked"`.
- Repeated activation while pending issues one request; after the idempotent response the control is disabled and the UI explicitly states the CVC is no longer a usable copy context.
- The dialog traps Tab at its boundaries, closes with Escape/backdrop/close button, restores trigger focus, uses labelled native controls, and confines narrow-screen content to vertical scrolling.

### Strict Storage response boundary

- Added closed TypeScript types and strict parsers for Task 10 inspection entries, source boundaries, placement hint, lifecycle, and canonical `sha256:<64 lowercase hex>` digests.
- The parser rejects unknown root or nested fields, malformed namespaces/codes, unsafe entry-content shapes, malformed lifecycle tuples, anchors outside entries, and non-canonical digests with `invalid_storage_response`.
- Inspect/revoke validate canonical `CVC` input before issuing fetch.
- The client uses the existing `/storage-api` proxy and existing `request`/`StorageHttpError`/`StorageRevisionConflict` behavior.

## TDD evidence

### RED

Initial domain/client command:

```text
npm.cmd test -- --run src/domain/context-packs/context-pack.test.ts src/storage/storage-service-client.test.ts
```

Valid RED after the existing contract pretest passed 29/29:

```text
2 test files failed
5 client tests failed: contextPacks.create/inspect/revoke absent
domain suite failed to load: focused context-pack module absent
25 unrelated existing client tests passed
```

Initial component RED:

```text
npm.cmd test -- --run src/components/canvas/context-packs/CopyCodexContext.test.tsx
1 suite failed to load: CopyCodexContext absent
```

The first behavioral component implementation produced eight failing assertions before accessible button labels/test traversal were corrected. A real non-DOM close regression then remained:

```text
8 tests: 7 passed, 1 failed
ReferenceError: window is not defined
```

The auto-save revision boundary was reproduced separately before its safe message was implemented:

```text
1 failed, 8 skipped
expected revision refresh instruction; received generic create failure
```

The real Task 10 digest shape was also proven RED in the focused client test after replacing the incomplete test fixture with the actual canonical format:

```text
1 failed, 29 skipped
sha256:<64hex> response rejected as invalid_storage_response
```

Initial Playwright RED, after pointing Playwright at the existing F: workspace browser, showed the shipped Canvas header had no Copy Codex context control. Subsequent integration REDs identified, without weakening assertions:

- the existing Ctrl-click event order can settle a requested multi-selection differently, so the final browser proof uses one stable real DOM selection while domain/component tests retain multi-node order/filter coverage;
- selection persistence can advance the Storage project revision before creation, so the browser waits for the actual project PUT and asserts the preview revision equals its response;
- Task 10 digests use the canonical `sha256:` prefix, fixed through the client RED above.

### GREEN

Final focused frontend plus Task 9 regression gate:

```text
npm.cmd test -- --run \
  src/domain/context-packs/context-pack.test.ts \
  src/storage/storage-service-client.test.ts \
  src/components/canvas/context-packs/CopyCodexContext.test.tsx \
  src/components/canvas/image-actions/CanvasReferenceCodeAction.test.tsx

4 files passed
55 tests passed
```

Every focused Vitest invocation also ran the repository contract pretest:

```text
29 contract tests passed
```

Task 10 Storage regression:

```text
.\.venv\Scripts\python.exe -m pytest promptcard_storage/tests/test_context_packs_v11.py -q
11 passed, 1 warning, 19 subtests passed
```

Final real browser gate:

```text
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path '.playwright-browsers').Path
npx.cmd playwright test tests/e2e/copy-codex-context.spec.ts --workers=1
1 passed (scenario 33.9s; command 42.5s)
```

The browser test proves a real selected CVT is the only preview/request entry while an unselected valid CVM remains absent, first clipboard write rejects after durable creation, copy retry succeeds, project focus changes, the original CVC inspection and exact resolve remain the same snapshot, revoke returns 410 on resolve, and the open dialog has no document-level horizontal overflow at 320px.

Production build:

```text
npm.cmd run build
TypeScript passed
Vite production build passed (1910 modules)
```

## Warnings and known external state

- Pytest could not write `.pytest_cache` because of the existing workspace ACL; all Task 10 tests and subtests passed.
- Build retains the pre-existing Tailwind `.w-2/3` CSS minifier warning, Tauri static/dynamic import warnings, and large-chunk warning.
- Repository-wide lint remains blocked by two pre-existing errors outside Task 11: the constant condition in `src/domain/free-canvas/free-canvas-project.ts` and empty object pattern in `tests/e2e/free-canvas-multi-view.spec.ts`. Task 11 introduced no lint diagnostic.
- Manual Checkpoint 2 acceptance remains for the user; automated evidence confirms selection contents, placement anchors, immutable inspection, focus independence, and revocation.

## Files

- `src/domain/context-packs/context-pack.ts`
- `src/domain/context-packs/context-pack.test.ts`
- `src/components/canvas/context-packs/CopyCodexContext.tsx`
- `src/components/canvas/context-packs/CopyCodexContext.test.tsx`
- `src/components/canvas/FreeCanvasBuilderScreen.tsx`
- `src/domain/reference-codes/reference-code.ts`
- `src/storage/storage-service-client.ts`
- `src/storage/storage-service-client.test.ts`
- `tests/e2e/copy-codex-context.spec.ts`
- `.superpowers/sdd/2026-08-22-plan-008-execution/task-11-report.md`

No plan draft, runtime fixture, generated browser artifact, Storage schema, backend implementation, or dependency file is part of Task 11.
