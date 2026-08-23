# Task 14 Fix 2 report

## Outcome

The Task 14 Codex projection boundary now retains its durable prepared journal
whenever an in-process publish or unpublish cannot prove that the prior pinned
projection was restored. Reopening Storage uses that journal to finish the
rollback, while read health remains structured rather than leaking Windows
lease implementation exceptions. Public SKL lookup is case-insensitive without
changing internal Skill-ID semantics, and Storage now enforces the same bounded
capability shape before returning a local-Agent snapshot.

## Design

- A failed Codex mutation is reconciled from the journal record and deterministic
  staging/backup paths, rather than only from adapter changes that were returned
  after a successful swap. The journal is removed only after rollback, staging
  cleanup, and the prior enabled projection all validate. Remaining operation
  artifacts produce `codex_projection_recovery_required` and keep the journal
  for reopen. Pre-swap collisions and externally introduced drift with no
  operation artifacts preserve their original structured conflict.
- Projection scans translate `_FolderRootChanged` from both Windows lease
  acquisition and lease close into `codex_projection_drift`. The `finally`
  boundary still closes acquired handles; a close failure cannot turn GET pin
  health into an internal error.
- Runtime catalog resolution keeps an exact-key map for internal IDs and a
  separate case-folded map only for public `referenceCode` values. Storage is
  therefore called with the catalog's canonical uppercase SKL, and snapshot
  output retains that canonical code.
- Storage validates exact-revision `declaredCapabilities` against the fixed
  capability keys, a 64-item aggregate limit, and a 128-byte UTF-8 per-item
  limit. Invalid data fails closed as `skill_snapshot_invalid`; valid exact
  revision capabilities are unchanged.

## TDD evidence

Before the fixes, focused Storage reproduced seven failures: publish restore,
unpublish restore, and staging cleanup all returned
`codex_projection_failed` and lost their recovery journal; Windows lease
acquire/close leaked `_FolderRootChanged`; 65 capability items and one
129-byte UTF-8 item reached the API. The runtime boundary separately failed
lowercase SKL lookup with `selected_skill_not_found`. The same adversarial tests
pass after the minimum implementation, including reopen recovery to the prior
revision and healthy projection.

## Verification

- Focused Storage: `35 passed, 1 skipped, 7 subtests passed`.
- Focused Gateway runtime boundary: `39 passed`.
- Full Storage: `293 passed, 3 skipped, 313 subtests passed`.
- Full backend: `295 passed`, with one pre-existing Starlette `TestClient`
  timeout deprecation warning.
- Ruff on the four changed Python source/test files: `All checks passed!`.
- TypeScript: `npx.cmd tsc --noEmit` exited 0.
- Production build: `npm.cmd run build` exited 0 and transformed 1911 modules.
  Existing CSS syntax, mixed dynamic/static import, and large-chunk warnings
  remain.

The first sandboxed full Storage run failed through Windows temporary-directory
ACL errors (`WinError 5` / SQLite unable to open its temp database), and the
first sandboxed Vite build failed with esbuild `spawn EPERM`. Re-running the
same commands outside the sandbox while keeping all temporary and build paths
inside the F: workspace produced the passing results above.

## Residual risk

The journal still provides compensation rather than impossible atomicity
between SQLite and repository filesystem renames. If both the live projection
and its durable backup are externally damaged, reopen reports
`codex_projection_recovery_required` and preserves evidence instead of deleting
unknown data. The two reviewer-designated minor items—disabled dangling-reparse
health and the unused `_current_skill_revision` helper—remain outside this fix
round and should stay on the parent acceptance ledger.
