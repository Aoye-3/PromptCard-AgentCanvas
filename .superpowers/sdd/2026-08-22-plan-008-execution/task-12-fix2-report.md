# Task 12 Fix 2 Report: Same-Owner Legacy Identifier Compatibility

## Outcome

Corrected the Fix 1 identifier validator so legacy databases can contain the same case-insensitive token in more than one identifier field of the same Skill owner. Ambiguity is now defined consistently with the resolver: only a token mapped to more than one distinct Skill owner fails closed.

New Skill creation remains strict. A request whose ID and slug are equal after `casefold()`, or whose requested token is already reserved by any existing ID, slug, or public `SKL`, is still rejected atomically.

## Minimal implementation

The only production change is `_validate_skill_identifier_space`:

- it groups every casefolded ID, slug, and `SKL` token into a set of owners;
- repeated fields belonging to one owner are accepted; and
- adding a second distinct owner raises the existing stable ambiguous-identifier `MigrationError`.

The resolver already deduplicated by owner. The create-time request-internal uniqueness and reserved-token checks were not changed.

## Legacy verification

### Crafted v12 migration

A true v12 row is inserted directly with `id == slug`, a legacy revision digest, instructions, and references, and without a public `SKL` row. Migration now:

- generates the missing stable `SKL`;
- maps the legacy revision to deterministic canonical entries;
- preserves the old digest in `legacyDigest`;
- produces canonical `skill-package-v1` digest metadata; and
- returns the identical package and identity after a second database reopen.

The existing different-owner legacy cross-collision and public-code collision cases still fail and retain the complete v12 rollback assertions from Fix 1.

### Crafted pre-fix v13 reopen

A v13 Skill with exact binary asset bytes is modified to the legacy same-owner `id == slug` shape. Reopen and reconciliation now succeed. Raw revision digest, entry order/path, entry digests, SQLite BLOB type, and exact BLOB bytes are compared before and after reopen and remain unchanged.

## TDD evidence

Initial focused RED:

```text
Ran 2 tests in 1.811s
FAILED (failures=2)
```

Both failures were the expected same-owner validator rejection: one during v12 migration before v13 DDL, and one during v13 reconciliation on reopen.

Minimal-fix GREEN plus the two negative non-regressions:

```text
Ran 4 tests in 4.705s
OK
```

Complete Task12/API-related focused suite:

```text
Ran 20 tests in 6.740s
OK
```

## Verification

- Full Storage release gate using workspace-local `TEMP`/`TMP`, backend Python 3.12, and root venv site-packages on `PYTHONPATH` for `jsonschema`:

  ```text
  Ran 202 tests in 102.550s
  OK (skipped=1)
  ```

  The conditional skip is the existing Windows symlink-privilege case.

- `npx.cmd tsc --noEmit`: PASS.
- `npm.cmd run build`: PASS. Only the pre-existing CSS syntax and chunk-size warnings were emitted.

No dependency was installed. No execution-plan file, Task 5 fixture, or unrelated agent change is included.
