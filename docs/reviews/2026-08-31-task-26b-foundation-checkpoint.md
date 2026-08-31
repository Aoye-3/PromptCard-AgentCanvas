# Task 26B Storyboard Foundation Checkpoint Handoff

## Checkpoint

- Date: 2026-08-31
- Branch: `feat/skill-document-storyboard-loop`
- State: Storyboard contract, ledger, Gateway, strict browser parsing, native adapter, and Inbox summary are complete; Canvas persistence and real-process acceptance remain open
- Merge state: feature branch only; do not merge or push `main` until the real Codex closed loop passes

## Completed At This Checkpoint

- Storage owns closed `storyboard.create` and `storyboard.change` preview/commit adapters on the existing profile-scoped v19 delivery ledger.
- Create proves the exact source `CVD/revision/digest` inside the selected CVC before opening a delivery intent.
- Change proves the exact target `CVS/revision/digest`, bounds row ordinals, rejects duplicate change identities, and never exposes internal Canvas row IDs.
- Terminal acceptance requires exactly one same-project `CVS-*`; preview, commit, listing, decision, replay, and restart reuse the shared ledger.
- Gateway uses the independent `bridge:deliver:storyboard` scope, canonicalizes CVC/CVD/CVS references, validates exact Skill pins, and forwards only the closed v3 payload.
- The browser Storage client strictly parses Storyboard create/change visual proposals and rejects hidden node IDs, hidden row IDs, and mismatched visual ordinals.
- The native application adapter deterministically creates one `IFreeCanvasStoryboardNode`, preserves exact source Document evidence and Bridge/Skill provenance, and converts external row ordinals to stable native row IDs for existing per-field pending changes.
- The existing Bridge Inbox recognizes Storyboard proposals and summarizes create/change scope without adding a second Agent UI.

## Verification Evidence

- Storage Storyboard delivery: 5 passed.
- Full Bridge Gateway regression: 32 passed.
- Strict browser Storage parsing plus native Storyboard application: 55 passed.
- Bridge Inbox plus native Storyboard application: 10 passed.
- TypeScript `tsc --noEmit`: passed.
- The Storage run emitted only the pre-existing inaccessible `.pytest_cache` warning; no user-owned test artifact was modified.

## Deliberately Not Claimed

Task 26B is not complete. This checkpoint does not yet prove:

- Canvas save-coordinator integration that returns the Storage-owned `CVS-*` before ledger acceptance;
- create/change rendering through the real `StoryboardNode` field-difference controls;
- single/all accept/reject across an external Storyboard delivery;
- rejection of a field that became pending after CVC creation (the CVC projection still needs the bounded pending-field signal);
- real Storage + Gateway + Vite + Chromium replay, reload, and two-process restart recovery;
- the final real Codex Document → Storyboard → Prompt → image loop.

## Next Exact Slice

1. Add the bounded `pendingFieldChanges` signal to the Storyboard CVC projection and strict browser parser; prove an already-pending field fails closed.
2. Wire `BridgeStoryboardDelivery` into `FreeCanvasBuilderScreen` through the existing save coordinator and deterministic application inspection.
3. Create Storyboard nodes from exact Document evidence, apply changes as native `pendingFieldChanges`, and return one Storage-owned `CVS-*` only after save succeeds.
4. Add focused Inbox/Canvas tests for create/change, stale base, replay, save retry, and single/all field review.
5. Extend the real Bridge Playwright harness for create/change/replay/reload/restart. Only after this passes may Task 26B acceptance boxes be checked and Task 26C begin.

## Resume Baseline

```powershell
python -m pytest promptcard_storage/tests/test_bridge_storyboard_delivery_v19.py -q
& .\agent-runtime\backend\.venv\Scripts\python.exe -m pytest agent-runtime/backend/tests/test_bridge_gateway.py -q
node_modules\.bin\vitest.cmd --run src/storage/storage-service-client.test.ts src/components/canvas/bridge/BridgeDeliveryInbox.test.tsx src/components/canvas/bridge/bridge-storyboard-application.test.ts
npx.cmd tsc --noEmit
```
