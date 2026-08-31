# Task 26A Storage Kernel Checkpoint Handoff

## Checkpoint

- Date: 2026-08-31
- Branch: `feat/skill-document-storyboard-loop`
- State: Task 26A Storage sub-slice complete; stop before Gateway/Canvas integration
- Merge state: feature branch only; do not merge or push `main` until the real Codex closed loop passes

## Completed At This Checkpoint

Storage now owns a typed `document.create` / `document.change` delivery service on the existing profile-scoped v19 ledger.

- Create accepts only the closed Bridge v3 simple Document AST and emits a `document_create` visual proposal.
- Change accepts only exact `CVC-*`, `CVD-*`, base revision, and base digest targets and emits a `document_changes` visual proposal.
- The service resolves the target inside the immutable CVC snapshot before creating a ledger row. Stale targets therefore leave no delivery intent behind.
- Change validation checks the current leaf text digest, NFC UTF-8 boundaries, missing blocks, pending suggestions, and overlapping byte ranges.
- Preview and commit are deterministic and idempotent. Pending proposals survive Storage restart.
- Acceptance/rejection uses the shared delivery decision path and accepts exactly one same-project `CVD-*` result for an accepted Document.
- `CVD/CVS` terminal-result validation now correctly uses `creative_references`; Prompt/Image validation continues to use `public_references`.
- Internal-token-only Document preview/commit routes expose the Storage adapter without changing Bridge v1/v2/v3 schemas.

## Verification Evidence

- TDD red gate: 3 focused tests initially failed because the Document service did not exist.
- Internal-route red gate: the protected route test initially returned 404.
- Final focused Storage regression: 15 passed, 4 subtests passed.
- Covered suites: Document delivery, Prompt delivery, and image staging/delivery.
- Touched Python Ruff check: passed.
- The focused run's only pytest warning is the pre-existing inaccessible repository `.pytest_cache`; tests used an explicit repository-local `--basetemp`.
- Broader Storage run: 371 passed, 3 skipped, 344 subtests passed; one unrelated HEIC dependency test could not import `pillow_heif` from the system Python. Retrying that single test with the repository `.venv` was then blocked by the pre-existing inaccessible `.test-tmp/image-assets-v5` directory. This is recorded as an environment limitation, not a green full-suite claim.

## Files Added Or Changed

- `promptcard_storage/document_delivery.py`
- `promptcard_storage/delivery_ledger.py`
- `promptcard_storage/store.py`
- `promptcard_storage/app.py`
- `promptcard_storage/tests/test_bridge_document_delivery_v19.py`
- Plan 008, ADR-023, README, Storage/Gateway API status, and this handoff

## Deliberately Not Claimed

Task 26A is not complete end to end. This checkpoint does not yet:

- route Document kinds through Gateway delivery preview/commit;
- parse Document deliveries in the browser Storage client;
- apply create/change proposals through the Canvas save coordinator;
- display native red-delete/green-add suggestions and external provenance;
- prove one accepted Document across a real Codex restart loop.

Task 26B Storyboard work must not begin until those gates pass.

## Next Exact Slice

1. Add failing Gateway tests for `document.create` / `document.change`, independent scope, exact source/Skill pins, status equivalence, and stale-target propagation.
2. Route both kinds to the new protected Storage endpoints without changing MCP schemas or v1/v2 compatibility.
3. Add failing frontend parser/inbox tests for the two closed visual proposal shapes.
4. Reuse `createPlanningDocumentV1`, `applyDocumentChangeOperations`, the project save coordinator, and durable applied-edit identity; do not add a second Document editor.
5. Verify create/change/replay/restart/conflict and native single/all suggestion accept/reject, then update this evidence trail and only then unlock Task 26B.

## Resume Command

Run the focused baseline before editing:

```powershell
python -m pytest promptcard_storage/tests/test_bridge_document_delivery_v19.py promptcard_storage/tests/test_bridge_prompt_delivery_v19.py promptcard_storage/tests/test_bridge_image_delivery_v19.py -q --basetemp=.test-tmp/task26a-storage-resume
```
