# Task 10 Fix 1 Report: PLM lifecycle and no-replace hardening

## Status

Resolved both Important review findings with a narrow Storage change. CVC creation and exact resolution now fail closed when an explicit PLM source's backing asset is missing, trashed, deleted, or absent on disk. Context-pack rows can no longer be rewritten through `INSERT OR REPLACE`, including attempts to clear revocation.

## Implementation

- Raised the monotonic Storage schema from v11 to v12 because the new trigger changes the canonical SQLite schema.
- Fresh databases create `context_packs_no_replace`; existing v11 databases add it in the `prevent-context-pack-replacement` migration. The real v10 chain continues through v11 and v12.
- The new `BEFORE INSERT` trigger aborts whenever a row with `NEW.cvc_code` already exists. It blocks SQLite replacement before the implicit delete/insert sequence can rewrite immutable columns or revocation state.
- Every store connection enables `PRAGMA recursive_triggers=ON`. The explicit no-replace trigger remains the primary guarantee; recursive triggers also ensure replacement operations cannot silently bypass delete-trigger semantics.
- Added one shared, redacted PLM availability check. It resolves the canonical PLM registry entry, active preset, exact binding, backing asset row/lifecycle, and on-disk file.
- CVC creation calls the check for explicit PLM source boundaries. Exact CVC resolution rechecks every PLM in frozen `sourceCodes` after the existing CVM checks.
- All PLM lifecycle failures return stable `source_unavailable` (HTTP 410 through existing mapping) with only `{"namespace":"promptMedia","code":"PLM-..."}`. Asset IDs and filesystem paths are not returned.
- Shared v1 contracts, API shapes, frontend code, and maintenance restore code were unchanged. Bumping the schema lets existing v11 backups follow the normal staging migration to v12 instead of creating a same-version canonical-schema mismatch.

## TDD evidence

### RED

The first attempted focused run was blocked before assertions by the Windows sandbox denying SQLite creation under the test directory. Re-running the same command with workspace write permission produced the valid RED result. After correcting a test-only invalid Trash actor, the review-specific RED selection was:

```text
.\.venv\Scripts\python.exe -m pytest promptcard_storage/tests/test_context_packs_v11.py -q -k "unavailable_prompt_media or rechecks_prompt_media or insert_or_replace or migrate_to_v12"
10 failed, 2 passed, 7 deselected, 2 warnings in 4.60s
```

The failures proved the intended gaps: all four PLM asset-unavailable states were accepted at creation, all four were ignored at resolution, schema remained v11, and a revoked snapshot was successfully replaceable.

### GREEN

Focused CVC gate:

```text
.\.venv\Scripts\python.exe -m pytest promptcard_storage/tests/test_context_packs_v11.py -q
11 passed, 1 warning, 19 subtests passed in 9.60s
```

Directed schema, migration, backup, restore, and registry gate:

```text
.\.venv\Scripts\python.exe -m pytest promptcard_storage/tests/test_backup.py promptcard_storage/tests/test_sqlite_store.py promptcard_storage/tests/test_public_references_v10.py -q
57 passed, 1 skipped, 1 warning, 83 subtests passed in 38.69s
```

Full Storage discovery:

```text
.\.venv\Scripts\python.exe -m pytest promptcard_storage/tests -q
1 failed, 183 passed, 1 skipped, 2 warnings, 208 subtests passed in 82.10s
```

The sole failure is the brief's known HEIC environment checkpoint: the current workspace venv is CPython 3.12 and does not contain `pillow_heif`. The existing workspace-local checkpoint directory contains CPython 3.11 native binaries; using its documented `PYTHONPATH` fails import with incompatible `PIL._imaging`. No dependency was installed or copied.

Full Storage gate excluding only that known environment checkpoint:

```text
.\.venv\Scripts\python.exe -m pytest promptcard_storage/tests -q -k "not test_import_decodes_real_heic_with_locked_workspace_dependency"
183 passed, 1 skipped, 1 deselected, 1 warning, 208 subtests passed in 85.04s
```

The skip is the pre-existing Windows real-symlink privilege limitation. The warning is the pre-existing workspace ACL preventing pytest cache writes.

## Mutation and compatibility evidence

- Creation tests independently exercise PLM backing asset Trash, missing row, deleted lifecycle, and missing file.
- Resolution tests create valid frozen packs first, then independently apply the same four asset mutations and assert exact, redacted PLM errors.
- A real SQLite `INSERT OR REPLACE` test attempts to change creator, entries, snapshot digest, and clear all revocation fields. The v12 trigger raises `sqlite3.IntegrityError`; the entire row remains byte-for-byte unchanged, inspection retains revocation metadata, and exact resolve still returns `context_revoked`.
- Tests assert `PRAGMA recursive_triggers=1` on store connections.
- Fresh, synthetic real v10, and synthetic real v11 databases all reach v12 with both immutable and no-replace triggers present.
- Existing backup/production-restore canonical-schema tests pass at v12, and CVC backup/restore preserves the exact contract view.

## Files

- `promptcard_storage/store.py`
- `promptcard_storage/tests/test_context_packs_v11.py`
- `.superpowers/sdd/2026-08-22-plan-008-execution/task-10-fix1-report.md`

No runtime pytest fixture deletion or untracked plan draft is included.
