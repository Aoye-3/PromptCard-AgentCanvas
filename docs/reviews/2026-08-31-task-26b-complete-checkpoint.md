# Task 26B Storyboard Writeback Completion Checkpoint

## Checkpoint

- Date: 2026-08-31
- Branch: `feat/skill-document-storyboard-loop`
- State: Task 26B complete; Task 26C Agent work-environment UI is the next exact slice
- Merge state: feature branch only; do not merge or push `main` until the final real Codex total loop passes

## Completed Boundary

- `storyboard.create` proves one exact CVC-contained source Document and creates one deterministic native `IFreeCanvasStoryboardNode`.
- Storage assigns and the browser preserves one stable `CVS-*` before the delivery ledger can be accepted.
- `storyboard.change` resolves only exact `CVS/revision/digest` authority and converts external row ordinals into native stable row IDs.
- Changes reuse the existing Storyboard per-field old/new review UI; no second Storyboard editor or generic Canvas mutation API was added.
- Storyboard CVC content includes a bounded `pendingFieldChanges` identity list. Sequence identities expose only `scope/field`; row identities expose only `scope/rowOrdinal/field`. Internal row, edit, and change IDs plus old/new values remain private.
- A newly requested change to a field already pending in the immutable CVC snapshot fails before a ledger record is opened.
- Deterministic Bridge markers retain profile, CVC, request digest, sources, exact Skill pins, target base, and proposal identity.
- Save/retry reuses the established authoritative persistence receipt and bounded retry path already used by the other Bridge deliveries.

## Defects Found By The Real Loop

1. Storyboard browser normalization dropped the Storage-returned `CVS-*`. The handler correctly refused ledger acceptance without a stable result code, after which an old auto-save removed the temporary node. `normalizeStoryboardNode` now preserves `referenceCode`, with a focused regression.
2. The two-phase test launches a fresh temporary browser profile, unlike the desktop app whose active CVC preference persists in `localStorage`. Recovery explicitly restores that existing UI preference; Storage/profile/CVC checks remain the authority.
3. Replay semantics were confirmed as `previewed + replay` at preview and the prior terminal result at commit. The restart test now verifies both steps rather than assuming preview itself is terminal.

## Verification Evidence

- Storage Storyboard delivery: 6 passed.
- Full Bridge Gateway regression: 32 passed.
- Strict browser Storage parsing, Bridge Inbox, native Storyboard application, and Free Canvas normalization: 141 passed.
- TypeScript `tsc --noEmit`: passed.
- Touched Python Ruff: passed.
- Production build: passed; only the pre-existing CSS selector and large-chunk warnings remain.
- Real focused Storyboard flow: 1 passed in 44.9 seconds.
- Full real Bridge flow: Document and Storyboard passed; two restart-phase tests skipped by design.
- Two-process restart flow: prepare passed in 42.9 seconds; recover passed in 42.8 seconds; three non-phase tests skipped in each run by design.
- Pytest emitted only the pre-existing inaccessible cache warnings; no user-owned test artifact was modified.

The real flow proves:

1. create Document and obtain `CVD-*`;
2. create Storyboard from exact Document evidence and obtain `CVS-*`;
3. replay create without a duplicate node;
4. submit a camera change against exact Storyboard authority;
5. review old/new values and accept the native field change;
6. restart Storage, Gateway, Vite, and Chromium between prepare/recover phases;
7. recover an accepted Document, accepted Storyboard, pending Storyboard change, sources, ledger status, and active CVC UI preference;
8. finish the pending field review after restart, replay both Storyboard requests, and retain one result node.

## Deliberately Not Claimed

- The discoverable Agent work-environment surface in Task 26C is not implemented yet.
- A newly connected Codex has not yet proved Bootstrap → runtime → workspace → exact Skill/reference discovery without prior schema knowledge.
- The final real Codex script → Document → Storyboard → Prompt → generated image loop has not yet passed as one acceptance session.
- `main` has not been changed by this checkpoint.

## Next Exact Slice: Task 26C

1. Consolidate Bridge connection/profile/scopes, explicit PRJ/CVC/revision, exact Skill pins/projection health, available Tools/object kinds, and pending deliveries into the Agent work-environment surface.
2. Make Bootstrap Skill plus runtime/workspace describe the first discoverable path for Codex.
3. Add exact “send to Agent” CVC/object references and a copyable task description; never infer targets from screenshots or current focus.
4. Reuse the already-complete native Document, Storyboard, Prompt, and image review paths and show consistent provenance/status/failure information.
5. Run the final real Codex total loop, fix blocking/data-risk/high-friction issues, update acceptance evidence, and only then merge and push `main`.

## Resume Commands

```powershell
python -m pytest promptcard_storage/tests/test_bridge_storyboard_delivery_v19.py -q
agent-runtime\backend\.venv\Scripts\python.exe -m pytest agent-runtime/backend/tests/test_bridge_gateway.py -q
npx.cmd vitest run src/storage/storage-service-client.test.ts src/components/canvas/bridge/BridgeDeliveryInbox.test.tsx src/components/canvas/bridge/bridge-storyboard-application.test.ts src/domain/free-canvas/free-canvas-project.test.ts
npx.cmd tsc --noEmit
npm.cmd run test:e2e:bridge
npm.cmd run test:e2e:bridge-restart
npm.cmd run build
```
