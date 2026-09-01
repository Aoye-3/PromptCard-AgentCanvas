# Repository Agent Guidance

Global user and workspace instructions still apply. This file records the repository-local rules that future Agents must preserve.

## Workspace And Git Boundary

- Work in the currently opened `PromptCard-Manager` repository and its current checkout. Create or switch to an in-place feature branch before edits.
- Do not create a worktree, temporary clone, mirror, copied repository, or alternate checkout.
- Do not place repositories, project copies, dependencies, virtual environments, builds, caches, or test output on `C:` or another drive. Keep them inside the current repository on its existing drive.
- Workspace confinement is a path-validation invariant. It is not authorization to hardcode the current drive letter, username, parent workspace name, or absolute repository path.
- Never commit machine-specific absolute paths such as `C:\...`, `F:\...`, `/Users/...`, or `/home/...` for test roots, caches, builds, runtime data, or maintained documentation examples.
- Derive the repository root from the current file, Git root, or launcher location. Before any write, resolve the final absolute target and verify that it remains inside the current repository and on the repository drive.
- Prefer validated repository-local roots such as `.test-tmp/`, `.tmp/`, `.cache/`, `dist/`, `.venv/`, and `.playwright-browsers/` according to their owning tool. Do not fall back to the operating-system temporary directory for project tests or caches.

## Storage Test Artifacts

- PromptCard Storage tests use `promptcard_storage.tests.workspace_paths.workspace_test_root()` for new suite-specific temporary roots.
- Every test creates an isolated child directory and cleans it in `tearDown`, a fixture finalizer, or `finally`.
- A permission/ACL test must restore permissions before cleanup. Do not leave directories that Git, pytest, or source-search tools cannot enumerate.
- The policy regression in `promptcard_storage/tests/test_workspace_test_paths.py` must stay green.

## Documentation Contract

- Follow [Documentation Policy](./docs/maintenance/documentation-policy.md) for source-of-truth order, change triggers, status handling, and completion criteria.
- Behavior changes update the nearest current-state architecture/API/frontend/backend/database/operations document in the same change.
- Plans and review evidence record delivery history; they do not override current-state technical documentation or accepted ADRs.
