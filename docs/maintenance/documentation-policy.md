# Documentation Policy

Docs describe current code truth and preserve the reasoning needed for safe future changes. Planned or incomplete capabilities must be labeled as roadmap or not yet implemented.

## Source-Of-Truth Order

When documents disagree, resolve the conflict in this order:

1. accepted ADRs define durable architectural and product boundaries;
2. current-state architecture, API, frontend, backend, database, operations, quality, and maintenance documents describe the shipped implementation;
3. the project overview and documentation index summarize those maintained documents;
4. active plans define authorized future sequencing;
5. completed plans, checkpoints, and reviews preserve historical evidence and must not override current-state truth.

Update every conflicting current-state document in the same change. Do not rewrite a historical ADR Context or checkpoint to make it look newly authored; add an implementation outcome, supersession note, or current-status annotation instead.

## Placement

- Architecture changes go under `architecture/`.
- Durable architecture or data-model decisions go under `decisions/` as ADRs.
- Stack and tool changes go under `tech-stack/`.
- Endpoint changes go under `api/`.
- UI and state changes go under `frontend/`.
- Runtime service changes go under `backend/`.
- Persistence changes go under `database/`.
- Local runbooks and secrets policy go under `operations/`.
- Test and acceptance updates go under `quality/`.
- Maintenance process goes under `maintenance/`.

## Code-To-Documentation Change Matrix

| Code or behavior changed | Required maintained documentation |
| --- | --- |
| Runtime topology, trust boundary, or cross-service flow | `architecture/` and, for durable decisions, `decisions/` |
| HTTP, MCP, CLI, schema, or public TypeScript/Python contract | `api/`, contract package README/schema, and compatibility notes |
| Canvas/UI workflow, review interaction, or client state | `frontend/` plus manual acceptance when user-visible |
| Gateway, text Runtime, provider adapter, Skill, or Tool behavior | `backend/` and the closest architecture boundary |
| SQLite schema, migration, asset lifecycle, reference, or durable record | `database/`, Storage API, schema notes, and rollback/backup guidance |
| Launcher, environment, port, path, credential, or recovery behavior | `operations/` and `tech-stack/tooling-and-scripts.md` |
| Test command, fixture ownership, warning budget, or acceptance gate | `quality/` and the release checklist |
| Product sequencing or completion state | active/completed `Plan/` entry and `docs/Plan/README.md` |
| Significant accepted trade-off that is expensive to reverse | a new ADR; never silently rewrite the old decision |

If a change touches multiple rows, update every affected category. “Tests pass” does not substitute for current API, architecture, operations, or data documentation.

## Status And Evidence Discipline

- Current-state documents use present tense and describe only shipped behavior.
- Plans carry an explicit status from `docs/Plan/README.md`; completed and superseded plans remain in place for history.
- Reviews and checkpoint files record revision, date, scope, commands, results, skips, warnings, and residual risks.
- A release matrix may cite earlier real-host or manual evidence, but must distinguish newly executed checks from inherited evidence.
- Keep known limitations close to the owning subsystem and label them as blocking, required follow-up, or non-blocking residual.

## Portable Paths

- Maintained code, tests, configuration, and documentation must not bind the repository to a drive letter, username, or absolute checkout path.
- Derive roots from the current file, Git root, or launcher location, then resolve and validate that write targets remain inside the repository and on its current drive.
- Use machine-specific absolute paths only as clearly labeled, non-copyable placeholders or adversarial fixture values. Never use them as an executable default.
- PromptCard Storage tests use `promptcard_storage.tests.workspace_paths.workspace_test_root()` and keep artifacts under `.test-tmp/promptcard-storage/`.

## Completion Criteria

A code-and-documentation change is complete only when:

- the nearest current-state documents and indexes agree with the implementation;
- relevant ADR/Plan status and historical evidence remain accurate;
- documented commands were actually run, with failures and environment blocks distinguished from assertion failures;
- maintained relative links resolve;
- `git diff --check` passes;
- no machine-specific path, secret, local runtime state, cache, or generated artifact is staged.

## Archive

Historical plans, old requirements, extracted raw text, and progress notes belong under `archive/legacy`.
