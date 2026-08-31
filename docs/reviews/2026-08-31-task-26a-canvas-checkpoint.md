# Task 26A Canvas Checkpoint Handoff

## Checkpoint

- Date: 2026-08-31
- Branch: `feat/skill-document-storyboard-loop`
- State: Storage, Gateway, and browser/Canvas Document adapters implemented; process-level replay/recovery probe remains
- Merge state: feature branch only; do not merge or push `main`
- Next-task lock: do not start Task 26B Storyboard until the remaining Task 26A probe passes

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

## Deliberately Not Claimed

- No real process-level Gateway → Storage → browser acceptance → restart → replay probe has run yet.
- Save interruption and lost decision response have not yet been exercised through live services for Document delivery.
- Task 26A is therefore not marked complete, and Task 26B remains locked.
- The complete external-Agent environment and real Codex script-to-Document-to-Storyboard-to-Prompt-to-image acceptance remain later gates.

## Next Exact Slice

1. Start the real Storage, Gateway, and browser services with a disposable project inside this workspace.
2. Preview and commit one Document create, accept it in Canvas, and capture its CVD.
3. Submit one exact-base change, verify native tracked suggestions, accept/reject at least one suggestion, and persist.
4. Repeat the same requests and simulate an interrupted decision response; verify one proposal and one Document result.
5. Restart services and verify CVD, marker, sources, Skill pins, ledger state, and suggestion state.
6. Update this handoff and Plan 008; only then unlock Task 26B.

## Resume Commands

```powershell
npx.cmd vitest --run src/storage/storage-service-client.test.ts src/components/canvas/bridge/BridgeDeliveryInbox.test.tsx src/components/canvas/bridge/bridge-document-application.test.ts src/components/canvas/nodes/DocumentNode.test.tsx src/domain/documents/document-suggestions.test.ts src/domain/free-canvas/free-canvas-project.test.ts
npx.cmd tsc --noEmit
npm.cmd run test:frontend
npm.cmd run build
```
