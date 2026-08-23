# Task 14 Fix 1 report

## Outcome

The Task 14 host-pin boundary now serializes Codex projection changes across
`SkillHostService` instances, records a durable prepared operation before any
filesystem swap, and recovers or reports an explicit unhealthy state after a
crash. Local-Agent snapshots and the Gateway continue to resolve only the exact
pinned revision and now reapply trust, canonical SKL, and bounded payload checks
on every read.

## Design

- Codex mutations acquire OS-backed repository, Skill-pin, and publication-path
  locks under the configured repository's `.agents` control directory. The
  repository lock also makes recovery safe when a crashed operation introduced
  a publication name that is not present in the prior pin.
- Before publish or unpublish swaps, a fsynced prepared journal records the
  repository scope, Skill owner, prior and desired exact revision/digest, full
  projection manifest, and deterministic staging/backup names. Reopen compares
  the durable SQLite pin with the journal's prior/desired pin and either rolls
  back or finalizes. Malformed, ambiguous, tampered, or unrecoverable journals
  return `projectionHealth.state = unhealthy` without touching unrelated paths.
- Every projected tree comparison is against the DB-owned full manifest. It
  rejects changed top-level fields, changed/missing/extra files or directories,
  case-fold and prefix collisions, symlinks, Windows reparse points, and trees
  above the bounded member count. Windows scans lease each directory; swaps are
  revalidated after rename before a backup can be finalized or restored.
- Local-Agent snapshot reads recheck active lifecycle and trusted/first-party
  state. Disabled, archived, missing, and trust-downgraded Skills fail closed.
- The Gateway independently validates canonical/case-folded SKL identity,
  UTF-8 byte sizes, instruction/reference per-entry and aggregate limits,
  reference count/path/content type, capability item count/size, and exact-run
  tool scope before returning material to the model boundary.

## TDD evidence

The adversarial tests were observed failing before their minimum fixes. They
cover cross-instance publish/publish and publish/unpublish interleavings, both
database sides of a simulated crash, tampered recovery backups, corrupt and
path-escaping journals, target changes during publish/unpublish swaps, full
manifest drift, missing/extra/link members, a real Windows junction plus
simulated reparse points, lock-file reparse rejection, local lifecycle/trust
changes, lowercase SKL inputs, and forged Gateway snapshots over every bound.

## Verification

- Focused Storage: `29 passed, 1 skipped, 5 subtests passed` (the optional
  dangling-symlink probe skipped because symlink creation was unavailable; the
  simulated dangling-reparse test passed, and the real `mklink /J` probe ran).
- Focused Gateway plus runtime boundary: `56 passed`.
- Full Storage: `287 passed, 3 skipped, 311 subtests passed`.
- Full backend: `294 passed`, with one pre-existing Starlette `TestClient`
  timeout deprecation warning.
- Ruff on the five changed Python source/test files: `All checks passed!`.
- TypeScript: `npx.cmd tsc --noEmit` exited 0.
- Production build: `npm.cmd run build` exited 0 and transformed 1911 modules.
  Existing CSS syntax, mixed dynamic/static import, and large-chunk warnings
  remain.

The first sandboxed full Storage run failed through Windows temporary-directory
ACL errors (`WinError 5` / SQLite unable to open its temp database), and the
first sandboxed Vite build failed with esbuild `spawn EPERM`. Re-running the
same commands outside the sandbox while keeping every temp/build path on the F:
workspace produced the passing results above.

## Residual risk

SQLite and filesystem rename cannot share a single hardware transaction. The
durable journal therefore guarantees deterministic compensation/finalization or
an explicit unhealthy state, rather than claiming impossible atomicity across a
machine power loss. Non-cooperating processes can still edit repository files;
post-swap verification and bounded GET health detect that drift, and no drifted
projection or recovery backup is deleted.
