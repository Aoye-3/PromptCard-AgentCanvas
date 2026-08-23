# Task 14 implementation report

## Outcome

Implemented schema v14 independent Skill host pins, repository-scoped Codex native projections, and Gateway-bounded exact local-Agent snapshots.

## Design

- Storage owns `skill_host_pins` with an exact immutable revision and digest. The local-Agent pin is global (`scope=''`); Codex pins are repository-scoped. Updating one composite host key cannot alter the other.
- Built-in local-Agent Skills receive deterministic enabled pins during migration/seed so the existing canvas and media capabilities do not fall back to mutable `currentRevision` reads.
- Codex publishes to the frozen Plan 008 path `.agents/skills/<publicationName>`. The ownership manifest records repository scope, internal owner, PromptCard source, stable `SKL`, exact revision, digest, and every projected file digest.
- Projection collision, ownership mismatch, drift, unsafe/reparse paths, Windows reserved names, case-fold collisions, missing revisions, and untrusted Skills fail closed before the pin advances.
- Projection swaps are compensatable: staged content and backups live outside the Codex discovery tree; a Storage upsert/commit failure restores the prior projection. Disable safely removes only an owned, drift-free projection and rolls back on persistence failure.
- The local-Agent endpoint resolves only the global enabled pin and filters the canonical package to exact `SKILL.md` plus bounded UTF-8 reference resources. Scripts are never exposed or executed. The Gateway validates exact pinned revision capability declarations against the run's existing allowed tools, rejects all other capability escalation, and strips declarations before model delivery.
- Existing Gateway external and built-in Skill resolution now consumes the pinned snapshot endpoint with no `currentRevision` fallback.

## TDD and verification

- Initial RED: Storage and Gateway tests failed at collection because `skill_hosts` and `skill_snapshots` did not exist.
- Focused final: `12 passed` for `test_skill_hosts_v14.py`; `44 passed` for Gateway snapshot/runtime-boundary tests.
- Full Storage release gate: `270 passed, 2 skipped, 306 subtests passed` with the established backend interpreter plus root `PYTHONPATH`, and workspace-only `TEMP`/`TMP`.
- Full Gateway/backend: `282 passed` (one existing Starlette `TestClient.timeout` deprecation warning).
- Ruff: all Task 14 Storage and Gateway files passed. The Storage invocation ignores the pre-existing intentional `AssetValidationError` re-export (`F401`) in `store.py`.
- TypeScript: `npx tsc --noEmit` passed.
- Production build: `1911 modules transformed`, build passed with existing CSS selector, mixed Tauri import, and chunk-size warnings.

## Plan/ADR correction applied during implementation

The first RED draft assumed `.codex/skills` and project-scoped local-Agent state. Read-only Plan 008/ADR-018 review corrected both before completion: Codex uses `.agents/skills`, while local-Agent enablement/pinning is global. Exact revision capability validation also replaced skill-summary dependency checks.

## Residual risk

Projection swaps use same-volume atomic renames plus ownership/drift checks and reject existing reparse points. They do not attempt to defeat a privileged process racing directory replacement during the very small validation-to-rename interval; OS/account-level write isolation remains the outer boundary.
