# Task 12 Fix 1 Report: Unified Skill Identifier Reservation

## Outcome

Closed the ambiguous Skill lookup path identified by independent review. Legacy Skill IDs, slugs, and public `SKL` reference codes now occupy one case-insensitive reserved identifier space. A create operation cannot introduce a token already used in any of those roles, and `id` and `slug` cannot collide with each other.

## Design

- Identifier comparison uses Python `casefold()` over the persisted Skill IDs, slugs, and `SKL` registry codes. This avoids relying on SQLite's ASCII-only `NOCASE` behavior for legacy identifiers.
- `create_skill` validates the existing identifier space and the requested ID/slug inside the same `BEGIN IMMEDIATE` transaction before inserting the Skill, revision, entries, or public registry row.
- `SKL` generation retains the existing bounded retry implementation. Its collision predicate now reserves both the public registry and every existing Skill ID/slug, including case variants. Retry exhaustion raises the existing `reference_code_collision` error and rolls back the whole create transaction.
- Resolution enumerates all identifier matches and deduplicates by Skill owner. Zero owners raises missing, one owner resolves, and more than one distinct owner raises the stable fail-closed `Skill identifier is ambiguous` migration/corruption error. One Skill matching through more than one of its fields still counts once.
- v12-to-v13 migration validates the full legacy identifier space before dropping triggers, adding columns, creating the package-entry table, or changing registry state. Reconciliation repeats the validation before generating any missing public reference.

## Migration atomicity

Two crafted v12 databases cover:

1. a case-insensitive legacy ID-to-slug cross collision; and
2. a legacy slug colliding with a pre-existing public `SKL` code.

Both fail deterministically. Raw post-failure assertions confirm schema version 12 remains current, `skill_package_entries` does not exist, the `lifecycle_status` column was not added, and every public registry row is byte-for-byte/value-for-value unchanged.

## TDD evidence

The initial focused RED contained five test methods and eight expected assertion/subtest failures:

- public-code and same-request identifier collisions were accepted;
- generated `SKL` codes did not skip legacy ID/slug tokens;
- generator exhaustion did not occur;
- raw multi-owner resolver corruption selected one row; and
- both crafted v12 collision migrations committed instead of failing.

After the minimal Storage change:

```text
Ran 5 tests in 1.641s
OK
```

The final Task12/API-related focused suite passed 19/19. The API contract additionally verifies ID and slug collisions with an existing public code return HTTP 409 without creating a list entry, followed by a successful create that returns the genuinely new Skill.

## Verification

- Final full Storage release gate, with workspace-local `TEMP`/`TMP`, backend Python 3.12, and the root venv site-packages added to `PYTHONPATH` for `jsonschema`:

  ```text
  Ran 201 tests in 84.976s
  OK (skipped=1)
  ```

  The conditional skip is the existing Windows symlink-privilege case.

- `npx.cmd tsc --noEmit`: PASS.
- `npm.cmd run build`: PASS. Only the pre-existing CSS syntax and chunk-size warnings were emitted.

No dependency was installed. No execution-plan file, Task 5 fixture, or unrelated agent change is part of this fix.
