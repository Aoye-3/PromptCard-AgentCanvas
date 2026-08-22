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
