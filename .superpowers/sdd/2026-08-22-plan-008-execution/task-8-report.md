# Task 8 Report: PRJ/CVT/CVM exact-resolution slice

## Status

Implemented the Storage-owned PRJ/CVT/CVM vertical slice without a schema-version change. Project JSON remains the Canvas authority; public codes live only in `public_references` and response projections.

## Delivered behavior

- Project create/get/list/update/trash/list-trash/restore responses add canonical `referenceCode` (`PRJ`).
- Current stable `kind: "text"` and `kind: "image"` Canvas nodes add scoped `CVT`/`CVM` codes. Arrow, image-generator, running, failed/transient image placements and legacy nodes without an explicit supported kind do not receive or expose codes.
- Incoming project/node `referenceCode` fields are stripped before persistence. `payload_json` remains free of public codes.
- `resolve_project_reference(PRJ)` returns canonical PRJ, current revision, type, and a title bounded to 120 Unicode characters.
- `resolve_canvas_reference(PRJ, CVT|CVM)` parses both exact codes before lookup, checks project scope and lifecycle, verifies the current node, and returns only bounded/redacted content:
  - text: title, joined authoritative segments, 4,000-character maximum, and `truncated`;
  - image: title, width, height, and valid optional `contentType`/`size` scalars.
- HTTP routes mirror the store semantics:
  - `GET /api/projects/references/{reference_code}`
  - `GET /api/projects/references/{project_reference_code}/nodes/{node_reference_code}`
- Removed Task 5's over-broad assetId-only legacy CVM inference while preserving all already-legal v10 rows and codes.
- Node removal leaves a stale mapping that resolves as typed `canvas_node_detached`; malformed persisted nodes return typed, redacted `canvas_node_invalid` rather than a 500 or content leak.
- Project Trash/restore preserves all codes. Permanent project deletion retires PRJ/CVT/CVM rows in the same transaction as deletion; injected SQLite trigger failure proves rollback. Reusing the internal project/node IDs produces fresh, disjoint codes.

## TDD evidence

### RED

After correcting the test root from the mistaken absolute `F:/.test-tmp` spelling to the brief's drive-relative `F:.test-tmp/task8-canvas-references`, the first valid RED run was:

```text
python -m unittest promptcard_storage.tests.test_canvas_reference_resolution -v
Ran 14 tests in 7.571s
FAILED (failures=17, errors=12)
```

Expected failures were missing project/node projections (`KeyError: 'referenceCode'`), missing exact resolvers, unstripped injected codes, and absent malformed-node validation.

Self-review later found ambiguous projection for a manually persisted duplicate node ID across text/image kinds. A focused RED test proved it:

```text
python -m unittest promptcard_storage.tests.test_canvas_reference_resolution.CanvasReferenceResolutionTest.test_duplicate_persisted_node_ids_do_not_expose_an_ambiguous_code -v
Ran 1 test in 0.476s
FAILED (failures=1)
AssertionError: 'referenceCode' unexpectedly found
```

The minimal fix changed projection uniqueness from `(namespace, node_id)` to project-wide `node_id`.

### GREEN

Final controller-requested focused command:

```text
python -m pytest promptcard_storage/tests/test_canvas_reference_resolution.py -q
............... [100%]
15 passed, 1 warning, 21 subtests passed in 15.71s
```

The warning is the pre-existing workspace ACL preventing pytest from writing `.pytest_cache`; exit code was 0.

Additional final focused unittest run:

```text
python -m unittest promptcard_storage.tests.test_canvas_reference_resolution -v
Ran 15 tests in 14.783s
OK
```

## Related verification

- v10/reference/project/store/app related batch initially exposed two legacy simplified-node fixtures. Validation was narrowed to reject present malicious scalar shapes while exact resolution still requires all safe projection fields. Focused compatibility rerun: `Ran 16 tests in 14.537s — OK`.
- Full Storage discovery initially ran `148` tests with system Python and had one environment-only import error (`pillow_heif`). `pillow-heif==1.4.0` was then installed only under `.test-tmp/task8-python-deps` with no pip cache, and full discovery was rerun with workspace `TEMP/TMP` and that directory on `PYTHONPATH`:

```text
Ran 148 tests in 37.914s
OK
```

- Final AST parse: `AST OK (3 files)`.
- Final `git diff --check` for tracked Task 8 source files exited 0; only Git's existing LF-to-CRLF notices were emitted.

## Files

- `promptcard_storage/store.py`
- `promptcard_storage/app.py`
- `promptcard_storage/tests/test_canvas_reference_resolution.py`
- `.superpowers/sdd/2026-08-22-plan-008-execution/task-8-report.md`

## Self-review and concerns

- No schema/version, frontend, Gateway, contracts, CVC, or plan files were changed.
- Existing unrelated deleted runtime fixtures and the untracked plan draft were left untouched and are excluded from the commit.
- The temporary Python test dependency is under ignored `.test-tmp` and is excluded from the commit.
- Task 9 remains responsible for UI consumption; Task 10 remains responsible for CVC.

## Independent review fix round

Commit `9d78acc` received five Important findings. This targeted follow-up addressed all five without changing the frozen contract or schema version:

1. CVT typed references now emit `namespace: "canvasTemplate"`, matching the frozen `contracts/promptcard-bridge/v1/schema.json`. Focused tests load that shared JSON Schema 2020-12 bundle, register its `$id` resources, and validate the actual project/CVT/CVM runtime `reference` objects against `TypedReference`.
2. Optional image `contentType` is accepted only when it is an exact normalized member of Storage's existing `IMAGE_CONTENT_TYPES`. Malicious URL/credential strings are rejected at create/update and manually corrupted persisted values return redacted `canvas_node_invalid` without echoing the value.
3. All Canvas nodes now require one nonblank, ASCII-edge-trimmed ID unique across the whole project, including supported/unsupported kind combinations. Text/image nodes must pass the same full resolvable-node validator before write, reconcile code generation, or response projection; text requires a scalar title and legal segments, while image requires a scalar title and finite positive width/height. Existing v10 tests were updated from simplified pseudo-nodes to legal current-model fixtures.
4. Stale project updates project `RevisionConflict.current` through `_with_project_public_references`, so HTTP 409 returns PRJ/CVT/CVM while raw `payload_json` remains code-free.
5. `maintenance.restore_backup` preserves explicit schema-1 compatibility and additionally accepts only the current `SCHEMA_VERSION` (10), not the intervening unsupported versions. The focused regression runs the production `store.backup -> maintenance.restore_backup -> reopen` path and proves PRJ/CVT/CVM exact resolution remains stable.

### Fix-round RED

```text
python -m pytest promptcard_storage/tests/test_canvas_reference_resolution.py -q
15 failed, 12 passed, 2 warnings, 21 subtests passed in 15.30s
```

The failures directly exercised all five review findings: eight malformed-write subtests, CVT namespace mismatch, malicious MIME echo, invalid-node reconcile projection, raw conflict current, and current-schema restore rejection.

After the first implementation pass, focused tests exposed one test-order mistake and one remaining direct-kind branch in startup reconcile:

```text
2 failed, 17 passed, 2 warnings, 29 subtests passed in 16.59s
```

The test assertion was moved after the image response was created, and reconcile was changed to use the shared full node validator.

### Fix-round GREEN

```text
python -m pytest promptcard_storage/tests/test_canvas_reference_resolution.py -q
19 passed, 1 warning, 29 subtests passed in 9.33s
```

Relevant v10/reference/project/store/sqlite/app/backup verification:

```text
python -m pytest promptcard_storage/tests/test_public_references_v10.py promptcard_storage/tests/test_reference_codes.py promptcard_storage/tests/test_store.py promptcard_storage/tests/test_sqlite_store.py promptcard_storage/tests/test_app.py promptcard_storage/tests/test_backup.py -q
65 passed, 1 warning, 69 subtests passed in 19.75s
```

Final AST parsing passed for all five changed Python files, and `git diff --check` exited 0 with only the repository's LF-to-CRLF notices. The pytest warning remains the existing workspace ACL preventing `.pytest_cache` writes.

## Independent review fix round 2

This second targeted follow-up addressed three additional Important findings without changing contracts or the schema version:

1. Present image `contentType` values now pass an explicit `str` check before membership lookup. Dict/list/null/numeric values consistently raise `ValueError`; the project API maps them to HTTP 400 `invalid_payload` instead of allowing `TypeError`/500. Omitting the optional field remains valid.
2. Startup reconcile and project response projection now count IDs across every dictionary Canvas node, including unsupported arrow/image-generator nodes, before issuing or exposing CVT/CVM. A supported node whose ID is ambiguous with any other node gets no new mapping and no projected code. A previously issued code resolves to structured, redacted `canvas_node_invalid` while the dirty ambiguity exists. Normal unique unsupported nodes remain code-free.
3. Production restore now accepts the migration range `1..SCHEMA_VERSION`, strictly requires an integer manifest version, reads the source database's actual `MAX(schema_migrations.version)`, and requires exact manifest/database agreement. Missing metadata, missing versions, spoofed values, mismatches, and future versions fail before target backup or replacement. A representative restored v9 database was reopened through the real Storage initializer and migrated to v10.

The directly affected storage-artifact fixture was updated to use a legal current image node (title and positive dimensions); production asset behavior was not changed.

### Fix-round-2 RED

After test-isolation cleanup and before production changes:

```text
python -m pytest promptcard_storage/tests/test_canvas_reference_resolution.py promptcard_storage/tests/test_backup.py -q
23 failed, 25 passed, 2 warnings, 35 subtests passed in 18.64s
```

The failures covered function/API MIME type handling, text+arrow and image+image-generator dirty-ID ambiguity, schema 1–9 restore acceptance, manifest/database mismatch validation, missing metadata, and spoofed manifest types.

The first GREEN run reduced the result to ten failures, all caused by the test fixture assuming new databases retain cumulative migration rows. Storage records one current row for a fresh database, so the legacy fixtures were corrected to replace that row, matching the repository's existing manual-v9 tests.

### Fix-round-2 GREEN

Focused Task 8 verification:

```text
python -m pytest promptcard_storage/tests/test_canvas_reference_resolution.py -q
22 passed, 1 warning, 39 subtests passed in 12.89s
```

Focused plus production backup/restore verification:

```text
python -m pytest promptcard_storage/tests/test_canvas_reference_resolution.py promptcard_storage/tests/test_backup.py -q
27 passed, 1 warning, 56 subtests passed in 14.01s
```

Relevant v3–v10 migration, backup, SQLite initializer, and storage-artifact verification used the existing workspace-local HEIC dependency path:

```text
$env:PYTHONPATH = (Resolve-Path '.test-tmp/task8-python-deps').Path; python -m pytest promptcard_storage/tests/test_backup.py promptcard_storage/tests/test_image_runs.py promptcard_storage/tests/test_image_conversations.py promptcard_storage/tests/test_image_assets_v5.py promptcard_storage/tests/test_project_resources.py promptcard_storage/tests/test_storage_artifacts.py promptcard_storage/tests/test_public_references_v10.py promptcard_storage/tests/test_sqlite_store.py -q
89 passed, 1 warning, 92 subtests passed in 39.25s
```

The only warning remains the pre-existing `.pytest_cache` ACL restriction. No environment fixtures, dependency directories, plan drafts, frontend, contracts, Gateway, or schema-version files are included in this fix round.

## Independent review fix round 3

This restore-only follow-up replaced direct source-to-target copying with validation and migration on a complete same-volume staging copy, followed by a rollback-capable DB/assets commit:

1. The complete backup directory is copied to a UUID-named sibling staging directory on the target data directory's volume. The staged manifest requires a strict integer `schemaVersion` in `1..SCHEMA_VERSION`; bool, float, string, object, and future values are rejected.
2. Before production initialization, the staged SQLite database must pass integrity checking and expose the canonical `schema_migrations` table. Its versions must be integer, unique, contiguous, in range, and end exactly at the manifest version. Missing tables/rows, missing history links, duplicate/non-integer rows, and manifest mismatch fail before any target rename.
3. A manifest claiming v10 must already contain the hardened v10 public-reference registry; weak registries are rejected instead of silently normalized. The full staged copy is then opened through production `JsonCollectionStore`, so real legacy schemas migrate in isolation. The migrated copy is checkpointed and revalidated at v10 for the complete business-table set, foreign keys, integrity, migration history, and hardened registry before commit.
4. Tests reuse the repository's real v5 asset-table rebuild and manual-v9 registry migration shapes. Both restore as already-migrated v10 databases, with data/assets and exact PRJ resolution preserved where applicable. Tests no longer treat a current database with only its version number changed as a valid legacy fixture.
5. Commit renames the current DB and, when the source supplies assets, current assets to UUID rollback names before installing the staged DB/assets. Each of the four `os.replace` steps has a one-shot injected-failure regression. Every failure returns `MigrationError`, restores the original logical DB dump and exact asset bytes, and removes staging/rollback artifacts.
6. Pre-restore backups are created directly from the rollback DB/assets through the existing `BackupManager`, avoiding `SqliteStore` initialization that would mutate built-in skill timestamps before a failed restore. Same-second pre-restore backup names use the repository's existing numeric suffix pattern.
7. A backup without an assets directory preserves existing target assets; a backup with assets atomically replaces the target asset tree. Successful and failed paths leave no `.restore-*` or `.rollback-*` artifacts.

### Fix-round-3 RED

After correcting test-only PNG signatures and before production changes:

```text
python -m pytest promptcard_storage/tests/test_backup.py -q
10 failed, 5 passed, 2 warnings, 7 subtests passed in 16.97s
```

The failures proved that v5/v9 were copied without staging migration, history corruption and fake/weak v10 databases were accepted, `os.replace` failures escaped or were not reached, and no rollback transaction protected DB/assets.

The five structural rejection cases were also run alone to prove every subcase independently failed against the old implementation:

```text
python -m pytest promptcard_storage/tests/test_backup.py::BackupRestoreValidationTest::test_restore_rejects_corrupt_history_fake_v10_and_weak_registry -q
5 failed, 1 passed, 1 warning in 4.37s
```

### Fix-round-3 GREEN

Final backup/maintenance focused verification:

```text
python -m pytest promptcard_storage/tests/test_backup.py -q
8 passed, 1 warning, 17 subtests passed in 16.99s
```

Final backup + Canvas exact-resolution verification:

```text
python -m pytest promptcard_storage/tests/test_backup.py promptcard_storage/tests/test_canvas_reference_resolution.py -q
30 passed, 1 warning, 56 subtests passed in 18.24s
```

Relevant v3–v10 migration, SQLite initializer, assets/resources, v10 registry, and storage-artifact verification:

```text
$env:PYTHONPATH = (Resolve-Path '.test-tmp/task8-python-deps').Path; python -m pytest promptcard_storage/tests/test_backup.py promptcard_storage/tests/test_image_runs.py promptcard_storage/tests/test_image_conversations.py promptcard_storage/tests/test_image_assets_v5.py promptcard_storage/tests/test_project_resources.py promptcard_storage/tests/test_storage_artifacts.py promptcard_storage/tests/test_public_references_v10.py promptcard_storage/tests/test_sqlite_store.py -q
92 passed, 1 warning, 92 subtests passed in 37.12s
```

The only warning remains the pre-existing `.pytest_cache` ACL restriction. This round changes only `promptcard_storage/maintenance.py`, `promptcard_storage/tests/test_backup.py`, and this report; unrelated environment fixture deletions and the untracked plan draft remain excluded.
