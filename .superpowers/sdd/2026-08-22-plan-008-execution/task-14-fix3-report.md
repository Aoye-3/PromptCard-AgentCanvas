# Task 14 Fix 3 report

## Outcome

Codex journal rollback now restores the complete filesystem meaning of a prior
disabled pin: no repository projection may remain discoverable. This applies
whether the failed re-enable reused the prior publication name or selected a
new publication name.

## Design

- When the durable prior pin is disabled, rollback treats an installed
  `newTarget` as operation-owned even when its publication name matches the
  retained projection metadata. It verifies the desired manifest before
  removing the target.
- Target removal is followed by an explicit absence check. If cleanup fails,
  rollback raises `codex_projection_recovery_required`; the outer operation
  retains its prepared journal rather than reporting the original database
  failure and deleting recovery evidence.
- Before the journal may be removed, rollback also verifies that the prior
  disabled publication target is absent. Reopen can then repeat the same
  idempotent cleanup and delete the journal only after the disabled pin and
  filesystem agree.

## TDD evidence

The regression test was observed failing before the implementation: re-enabling
a disabled same-name publication followed by a forced SQLite pin-write failure
left `pin.enabled = false`, `target.exists() = true`, and no journal. Simulated
cleanup failure also reproduced for same and different publication names: both
paths re-raised the SQLite error and deleted the journal instead of returning
recovery-required. After the fix, immediate rollback removes both publication
variants, while forced cleanup failure keeps one journal and reopen removes the
live projection before returning healthy disabled state.

## Verification

- Minimal disabled rollback regression: `2 passed, 36 deselected, 4 subtests
  passed`.
- Focused journal/database rollback paths: `8 passed, 30 deselected, 4 subtests
  passed`.
- Complete Task 14 Storage focused file: `37 passed, 1 skipped, 11 subtests
  passed`.
- Full Storage suite: `295 passed, 3 skipped, 317 subtests passed`.
- Ruff on the two changed Python source/test files: `All checks passed!`.

Backend, TypeScript, and Vite were not rerun because this round changes only the
Storage rollback implementation and its Storage tests; Fix 2 already verified
those unaffected gates.

## Residual risk

As in the prior rounds, SQLite and repository filesystem state are reconciled
through durable compensation rather than a shared transaction. External damage
to both the live projection and its recovery evidence still produces an
explicit recovery-required state and preserves the journal for inspection.
