# Task 10 Report: immutable CVC context packs

## Status

Implemented Storage-owned, project-scoped Canvas context packs on schema v11. Creation is explicit and revision-gated, exact resolution returns the frozen shared v1 `ContextPack` view, and revocation blocks resolution without deleting either the snapshot or project content.

## Schema and migration

- Raised the monotonic Storage schema from v10 to v11.
- Fresh databases create `context_packs`; existing v10 databases add it in one `BEGIN IMMEDIATE` migration and record `add-canvas-context-packs`.
- The existing real v1-v10 migration chain now continues to v11. Existing v2/v5/v8/v9 migration and production restore tests were updated to assert the current `SCHEMA_VERSION`, not a frozen v10 literal.
- A weak v10 public-reference registry is hardened before the v11 table adds its CVC foreign key.
- Backup manifests, production staging migration, canonical schema fingerprint validation, health, and restored database validation use v11 through the existing shared `SCHEMA_VERSION` path.
- `health.capabilities.contextPacks` advertises the capability.

The table stores only canonical public PRJ/CVC codes, project revision, creation metadata, exact contract entries, unique source codes, explicit source boundaries, placement hint, snapshot digest, and revocation metadata. It does not store project/node IDs, asset IDs, media bytes, paths, URLs, credentials, or whole project JSON.

Three real SQLite triggers enforce persistence rules:

- `context_packs_snapshot_immutable` rejects every snapshot-column update.
- `context_packs_revocation_once` permits only the first complete revocation transition.
- `context_packs_no_delete` prevents snapshot deletion in the first-release retention model.

## Store and API behavior

Store methods:

- `create_context_pack(payload)`
- `resolve_context_pack(cvc_code)`
- `inspect_context_pack(cvc_code)`
- `list_context_packs(project_code=None)`
- `revoke_context_pack(cvc_code, actor, reason)`

HTTP routes:

- `POST /api/context-packs`
- `GET /api/context-packs?projectCode=PRJ-...`
- `GET /api/context-packs/{CVC}`
- `GET /api/context-packs/{CVC}/resolve`
- `POST /api/context-packs/{CVC}/revoke`

Creation accepts exactly `projectCode`, `projectRevision`, non-empty ordered `nodeCodes`, `placementHint`, and `creator`; `projectId`/`nodeId` and all other fallback fields are rejected. PRJ/CVT/CVM parsing happens before lookup, lowercase is canonicalized, duplicate selection is rejected after canonicalization, and every selected node must resolve in the same active project at the supplied current project revision.

The first release implements only the master plan's explicit placement shape:

```json
{"mode":"after-selection","anchorNodeCodes":["CVT-..."]}
```

Anchors are non-empty, unique after canonicalization, supported CVT/CVM codes, and members of the explicit selection. Input order is retained; no coordinates, viewport state, focus, selection IDs, or internal IDs are persisted.

Each entry is a frozen v1 `ContextEntry`:

- `reference` is the frozen v1 `TypedReference` for CVT/CVM. The frozen schema has no revision property, so project revision remains inspection metadata rather than an illegal contract addition.
- `content` is canonical sorted compact JSON containing only bounded safe fields.
- `contentDigest` is the exact lowercase SHA-256 digest of the UTF-8 content string.
- Text title is limited to 120 characters, text to 4,000 characters, with `truncated` recorded.
- Image content contains only kind/title/width/height and safe optional contentType/size; the CVM identity remains in the typed reference.

Explicit node fields `promptLibraryReferences` and `canvasMediaReferences` are the only accepted source boundaries. They accept existing canonical PLP/PLM and same-project CVM codes respectively, normalize case, remove duplicates within each boundary, retain entry boundaries for inspection, and aggregate first-seen unique `sourceCodes` for the shared contract. No source code is inferred from asset IDs or other internal data.

Exact resolution returns only:

```json
{"projectCode":"PRJ-...","cvcCode":"CVC-...","entries":[],"sourceCodes":[]}
```

That closed view validates against the unchanged shared v1 `ContextPack` schema. Resolution does not reread text content, so later focus/selection/project/node edits do not mutate the snapshot or entry digest. It rechecks every referenced CVM against current project/node and asset lifecycle; missing, trashed, deleted, detached, running/transient, or malformed media produces structured `media_unavailable` with only the exact CVM code.

Revocation is first-write-wins and idempotent. A repeated API/store revoke returns the original actor/reason/timestamp. Inspection and list continue to expose the immutable snapshot and revocation metadata, while exact resolve returns structured `context_revoked` (HTTP 410). Unknown codes return 404, malformed/wrong-prefix/invalid payloads return 400, stale revision returns 409, and lifecycle-unavailable states follow the existing 410 convention.

## TDD evidence

### RED

After fixing one test-only duplicate preset fixture, the valid initial RED command was:

```text
python -m pytest promptcard_storage/tests/test_context_packs_v11.py -q
14 failed, 2 warnings in 5.88s
```

Failures were the intended absent behavior: schema remained v10, store create/resolve/inspect/list/revoke methods did not exist, and the HTTP routes returned 404.

Two later boundary regressions were individually proven RED before their minimal fixes:

```text
python -m pytest promptcard_storage/tests/test_context_packs_v11.py::ContextPackV11Test::test_http_routes_use_stable_status_and_closed_payloads -q
1 failed: non-object request returned 422 instead of 400
```

```text
python -m pytest promptcard_storage/tests/test_context_packs_v11.py::ContextPackV11Test::test_fresh_schema_and_real_v10_database_migrate_to_v11 -q
1 failed: health capability contextPacks was absent
```

### GREEN

Final focused CVC gate:

```text
python -m pytest promptcard_storage/tests/test_context_packs_v11.py -q
8 passed, 1 warning, 11 subtests passed in 6.51s
```

The focused tests load the repository's real JSON Schema 2020-12 bundle and validate the actual exact-resolve response against `ContextPack`. They also exercise fresh/v10 migration, ordered selection, lowercase/prefix behavior, empty/duplicate/cross-project/stale inputs, source boundaries, placement anchors, bounded/redacted content, exact digests, real SQLite immutable/revocation/delete triggers, collision rollback, focus/node-edit stability, missing/trashed/deleted media, running/malformed nodes, revoke/idempotency/inspection/list, project Trash/permanent deletion, backup/production restore, API status mapping, and serialized payload secret/path/bytes scans.

Full Storage discovery with the existing workspace-local HEIC checkpoint dependency path:

```text
$env:PYTHONPATH = (Resolve-Path '.test-tmp/task8-python-deps').Path
python -m pytest promptcard_storage/tests -q
181 passed, 1 skipped, 1 warning, 200 subtests passed in 72.00s
```

The skip is the pre-existing Windows real-symlink privilege limitation; the backup suite's Windows reparse simulations remain covered. The warning is the pre-existing workspace ACL preventing pytest from writing `.pytest_cache`.

## Mutation and transaction evidence

- Four independent direct SQL mutations of entries, project binding, creator, and snapshot digest each raise the immutable trigger.
- Direct second revocation and direct snapshot DELETE each raise their dedicated trigger.
- A forced duplicate CVC generator result raises SQLite uniqueness failure; the enclosing transaction leaves exactly one pack row and one CVC registry row.
- The context-pack media test executes real asset Trash and permanent-delete paths and proves exact resolution fails with only the frozen CVM identity.
- The production `store.backup -> maintenance.restore_backup -> reopen` path preserves the CVC and byte-for-byte contract view.

## Files

- `promptcard_storage/store.py`
- `promptcard_storage/app.py`
- `promptcard_storage/tests/test_context_packs_v11.py`
- Schema-version compatibility assertions in existing Storage migration/backup tests
- `.superpowers/sdd/2026-08-22-plan-008-execution/task-10-report.md`

No shared v1 contract, frontend, Gateway, MCP, plan draft, runtime fixture, dependency, expiry, GC, or UI behavior was changed.
