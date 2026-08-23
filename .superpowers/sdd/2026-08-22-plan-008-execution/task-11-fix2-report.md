# Task 11 Fix2 Report

## Scope

This follow-up fixes the two Important findings from the Task 11 re-review:

1. `CopyCodexContext` now coordinates create, inspect, and revoke through one generation/token operation state machine.
2. Playwright fixture cleanup now removes every acquired project before attempting referenced assets, while still attempting later projects after an earlier project cleanup failure.

## RED evidence

- `CopyCodexContext.test.tsx`: 8 failures, 13 passes. The eight failures covered create/inspect and create/revoke races in both operation directions and both settlement orders.
- `e2e-fixture-cleanup.test.ts`: 2 failures, 1 pass. The staged graph cleanup helper did not yet exist.
- Contract pretest remained green at 29/29 while collecting the RED evidence.

## Implementation

### Unified context operation ownership

- Every create, inspect, and revoke receives a monotonically increasing token tied to the current dialog generation, operation kind, and exact canonical CVC when known.
- Starting a new operation atomically invalidates the previous operation and clears its pending state before setting the new operation pending.
- Create binds its initially unknown CVC only from its own current successful settlement.
- Inspect and revoke settlements must match their exact canonical input CVC.
- Success, error, and `finally` state changes are accepted only from the current operation token. A stale settlement cannot change input, inspection, error, or pending state.
- Closing and reopening the dialog advances the generation, so settlements from the previous session are ignored.

The deferred tests cover create to inspect, inspect to create, create to revoke, and revoke to create, each in both settlement orders. Existing and added coverage also verifies close/reopen and double-submit behavior, including exact final input, inspection, and pending states.

### Staged fixture cleanup

- `cleanupAcquiredFixtureGraph` deduplicates acquired handles and uses `Promise.allSettled` for all project deletions first.
- A first-project failure does not prevent attempting the second project.
- Referenced assets are deleted only after every acquired project deletion succeeds.
- If any project deletion fails, asset deletion is deliberately skipped and project errors are aggregated. This retains the asset rather than leaving a surviving project with a deleted reference.
- If no project was acquired, assets are safe to delete directly.
- The Task 11 Playwright teardown now submits both projects and the referenced asset to this single staged helper.

## Verification

- Focused Task 11/Task 9/contract regression: 11 files, 171/171 tests passed; contract pretest 29/29 passed.
- Focused race/cleanup rerun after lint cleanup: 2 files, 24/24 tests passed; contract pretest 29/29 passed.
- Playwright: 4/4 passed in 1.4 minutes:
  - real Copy Codex context create/preview/inspect/revoke flow;
  - project/text copy-code keyboard flow;
  - image copy-code mouse/retry/menu flow;
  - unsupported-node and responsive overflow flow.
- Production build: passed (`tsc && vite build`, 1911 modules transformed).
- `git diff --check` on the five implementation/test files: passed.
- Lint: no Fix2-owned findings. The repository command still exits non-zero with the existing baseline of 2 errors and 41 warnings (`free-canvas-project.ts` constant condition and `free-canvas-multi-view.spec.ts` empty pattern are the errors).

## Remaining observations

- The production build retains the existing CSS selector, Tauri mixed import, and large chunk warnings.
- Unrelated deleted pytest fixtures and the untracked Plan 008 execution document were not modified or staged.
