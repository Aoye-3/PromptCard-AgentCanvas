# Task 26A Gateway Checkpoint Handoff

## Checkpoint

- Date: 2026-08-31
- Branch: `feat/skill-document-storyboard-loop`
- State: Task 26A Storage and Gateway sub-slices complete; stop before Canvas integration
- Merge state: feature branch only; do not merge or push `main` until the real Codex closed loop passes

## Completed At This Checkpoint

The public Bridge v3 Gateway now carries `document.create` and `document.change` through the already-published MCP/CLI delivery contract into the Storage-owned Document ledger.

- The FastAPI request union is closed and discriminated by delivery kind.
- Document create accepts only the simple editor-neutral block/inline contract.
- Document change accepts only insert/delete/replace operations with bounded UTF-8 coordinates and digests.
- `bridge:deliver:document` is checked independently before Storage mutation.
- CVC, CVD, and source codes are canonicalized; approved exact Skill pins still use the shared validation path.
- Internal `nodeId` targets and unknown request fields fail at the router boundary.
- Optional model fields are omitted before forwarding. This prevents absent `level`, marks, links, or optional image-placement fields from becoming explicit `null` attributes that violate Storage's closed request shape.
- Preview and commit route only to internal-token Document Storage endpoints. Commit uses the Storage-owned proposal kind; status remains a read-only shared-ledger lookup.
- No Gateway-specific Codex behavior or additional MCP Tool was introduced.

## Verification Evidence

- TDD red gate: both Document create/change cases returned 422 before the router models existed.
- Payload-parity red gate: paragraph and inline optionals were initially forwarded as `null`; the focused test reproduced this before `exclude_none=True` was applied.
- Bridge Gateway suite: 29 passed.
- Bridge v1/v2/v3 contract suite: 52 passed.
- Bridge CLI suite: 8 passed.
- MCP suite: 10 passed across STDIO and loopback HTTP.
- Agent Runtime check and Text Agent TypeScript check: passed.
- Touched Python Ruff (`--no-cache` because the repository `.ruff_cache` is inaccessible): passed.
- Pytest's only focused warning is the pre-existing inaccessible `.pytest_cache`.

## Deliberately Not Claimed

Task 26A is still not complete end to end. This checkpoint does not yet:

- parse Document deliveries in the browser Storage client;
- display Document create/change proposals in the Bridge inbox;
- apply create/change through the Canvas project save coordinator;
- reuse native red-delete/green-add suggestion review and single/all decisions;
- persist and display external Agent, Skill pins, source codes, request/proposal identity on the Document result;
- prove restart/replay through a real browser and Codex process.

Task 26B Storyboard work remains locked.

## Next Exact Slice

1. Add failing strict-parser tests for `document_create` and `document_changes` visual proposals.
2. Extend `BridgeDelivery` and the inbox without adding another editor.
3. Reuse `createPlanningDocumentV1`, `applyDocumentChangeOperations`, the project save coordinator, and the durable applied-edit marker.
4. Require exact CVD/revision/digest on change and deterministic identity on create/retry.
5. Verify native suggestion review, acceptance/rejection, save failure retry, restart, and duplicate delivery before updating Plan 008 and unlocking Task 26B.

## Resume Baseline

```powershell
cd agent-runtime/backend
..\..\.venv\Scripts\python.exe -m pytest tests/test_bridge_gateway.py -q --basetemp=..\..\.test-tmp\task26a-gateway-resume
..\..\.venv\Scripts\python.exe -m ruff check --no-cache app/gateway/bridge.py app/gateway/routers/bridge.py tests/test_bridge_gateway.py
```
