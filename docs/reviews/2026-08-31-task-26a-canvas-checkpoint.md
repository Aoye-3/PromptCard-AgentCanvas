# Task 26A Canvas Checkpoint Handoff

## Checkpoint

- Date: 2026-08-31
- Branch: `feat/skill-document-storyboard-loop`
- State: complete; Storage, Gateway, browser/Canvas, replay, reload, and service-restart recovery verified
- Merge state: feature branch only; do not merge or push `main`
- Next task: Task 26B Storyboard is unlocked and must reuse the same ledger, exact-reference, CVC, and native-review boundaries

## Completed At This Checkpoint

- `BridgeDelivery` now includes strict `document.create` and `document.change` records. Unknown attributes, internal node IDs, malformed public references, request/proposal divergence, and mismatched CVD/base/provenance fail closed.
- The external Agent Inbox displays Document create/change intent, Agent name, exact Skill code/revision, source codes, request identity, rationale, operation count, and base revision.
- Document create produces one deterministic ordinary Canvas Document using the existing editor-neutral AST.
- Document change resolves exactly one CVD, rechecks its revision/digest, and uses `applyDocumentChangeOperations`; the existing Document UI remains the only red-delete/green-add single/all accept/reject mechanism.
- Canvas acceptance is not acknowledged to the delivery ledger until persistence returns one Storage-owned CVD. Retry recognizes the durable Bridge proposal marker and does not create a duplicate result.
- Target drift, duplicate CVD authority, altered marker, invalid operation, or persistence conflict leaves the proposal pending and fails closed.
- Agent, Skill pins, source codes, request/proposal identities, base authority, and result digest are preserved in the Bridge marker and delivery ledger.

## Blocking Defect Found And Fixed

Existing Document normalization preserved text/image reference codes but dropped a Document `CVD-*`. A first external change could therefore work while restart destroyed the public authority required for later changes. `normalizeDocumentNode` now preserves `referenceCode`, with direct Canvas normalization and Bridge replay tests covering create and changed Documents.

The real-process probe then exposed three additional integration defects:

- Bridge Bearer POST requests were passing through browser cookie CSRF enforcement. `/api/promptcard/bridge/*` now bypasses cookie CSRF but still requires the independent Bridge Bearer profile and scope; ordinary browser mutations remain CSRF-protected.
- The CVC selector accepted only Text and Media nodes. Stable Document and Storyboard nodes are now selectable as `CVD-*` / `CVS-*` context objects.
- The browser Storage parser rejected those new context object namespaces. It now performs strict closed parsing for Document AST/revision/digest and Storyboard sequence/ordered rows and still rejects hidden fields or malformed projections.

## Verification Evidence

- RED: browser client rejected both new Document kinds before the strict union/parser existed.
- RED: Inbox lacked Document provenance and treated changes as image-like records.
- RED: native application module was absent before deterministic create/change tests.
- RED: restart-style normalization changed an exact applied Document result into a conflict by dropping its CVD.
- Strict parser + Inbox + Bridge application: 55 passed.
- Native Document suggestions + Document node + Canvas normalization + Bridge application: 119 passed.
- TypeScript `tsc --noEmit`: passed.
- Touched TypeScript/TSX ESLint: passed with zero warnings.
- Full frontend regression: 136 files and 1,404 tests passed across all four shards. Existing duplicate-key and SSR `useLayoutEffect` warnings remain outside this change; no test failed.
- Production `tsc && vite build`: passed. Existing CSS selector, mixed Tauri import, and bundle-size warnings remain outside this change.
- Real default loop: `npm.cmd run test:e2e:bridge` passed the active Chromium scenario; the two restart-only phase scenarios were correctly skipped.
- Real restart loop: `npm.cmd run test:e2e:bridge-restart` passed prepare and recover in separate Storage/Gateway/Vite process lifetimes. The accepted CVD, Bridge marker, source codes, Skill pins, ledger status, CVD-bearing CVC, visible Document text, and single-result replay all recovered.
- Bridge Gateway: 30 passed. Contracts: 52 passed. CLI: 8 passed. MCP: 10 passed. Focused CVC selection: 10 passed. Focused strict Storage parsing: 9 passed. Agent Runtime/type checks and all four frontend test shards passed; touched ESLint remained at zero warnings.

## Completion Boundary

- Task 26A is complete because its real process-level Gateway → Storage → browser acceptance → restart → replay gate passes with exactly one durable Document result.
- This does not complete Checkpoint 5: Storyboard create/change, the unified Agent work-environment UI, adversarial hardening, packaging, and the real Codex script-to-Document-to-Storyboard-to-Prompt-to-image acceptance remain open.
- The feature branch remains the only integration target. `main` must not move until the final real Codex loop and complete regression matrix pass.

## Next Exact Slice: Task 26B

1. Add strict `storyboard.create` and `storyboard.change` Storage adapters over the existing profile-scoped delivery ledger.
2. Resolve only exact `CVC/CVS/revision/digest` targets and ordinal-addressed rows; reject stale base, invalid ordinal, and already-changed fields before preview.
3. Adapt accepted proposals into the existing structured Storyboard sequence and per-field review UI; do not create a parallel Agent editor.
4. Add real Gateway/browser create/change/review/replay/restart evidence before marking Task 26B complete.
5. Update Plan 008, API/architecture docs, README, and the next checkpoint handoff in the same commit slice.

## Resume Commands

```powershell
npx.cmd vitest --run src/storage/storage-service-client.test.ts src/components/canvas/bridge/BridgeDeliveryInbox.test.tsx src/components/canvas/bridge/bridge-document-application.test.ts src/components/canvas/nodes/DocumentNode.test.tsx src/domain/documents/document-suggestions.test.ts src/domain/free-canvas/free-canvas-project.test.ts
npx.cmd tsc --noEmit
npm.cmd run test:frontend
npm.cmd run test:e2e:bridge
npm.cmd run test:e2e:bridge-restart
npm.cmd run build
```
