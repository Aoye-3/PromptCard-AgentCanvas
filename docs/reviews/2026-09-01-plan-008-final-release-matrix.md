# Plan 008 Final Release Matrix

## Checkpoint

- Branch: `feat/skill-document-storyboard-loop`
- Base packaging commit: `34c6877 feat(bridge): package optional MCP adapter`
- Date: 2026-09-01 (Europe/London)
- Status: automated release matrix passed; ready for the authorized feature-branch-to-`main` merge

## Closed Product Loop

The accepted real-host evidence remains the full Codex script → Document create/change → Storyboard create/change → Prompt create → Codex-generated image stage/place → native visual acceptance loop. The follow-up checkpoint stops and restarts Storage, Gateway, Vite, and Codex, then proves identical staging/delivery replay, same-key/different-digest conflict, one result per object family, preserved provenance/version/approval state, and zero fabricated PromptCard provider generation runs. See [Real Codex Writeback Contract Checkpoint](./2026-08-31-real-codex-writeback-contract-checkpoint.md) and [Real Codex Restart And Replay Checkpoint](./2026-08-31-real-codex-restart-replay-checkpoint.md).

This final matrix did not repeat external image generation or spend. It revalidated every repository-owned contract, adapter, storage boundary, browser workflow, and security path beneath that already accepted real-host evidence.

## Final Automated Evidence

| Gate | Result |
| --- | --- |
| Production build | passed; 1,981 modules; only existing CSS selector, dynamic/static import, and chunk-size warnings |
| `npm.cmd run lint` | passed; 0 errors, frozen ratchet baseline of 41 historical warnings |
| Gateway and text Runtime checks | `agent:check` and `text-agent:check` passed; Storage schema 19 reported |
| Full frontend regression | 4/4 shards, 141 files, 1,431 tests passed |
| Full Gateway + Storage regression | 875 passed, 344 subtests passed, 3 platform skips, 1 Starlette TestClient deprecation warning |
| Full Gateway Ruff | passed |
| Bridge contracts | 52 passed across v1/v2/v3 |
| Optional packaging/docs | 6 passed, including locked launch, redaction, profiles/templates, diagnostics, and maintained relative links |
| Unified adversarial gate | 52 contracts, 8 CLI, 10 MCP, 186 MCP-absent frontend/startup, 87 Storage + 36 subtests (1 platform skip), 55 Gateway, and 1 real Gateway attack chain passed |
| Ordinary Playwright | 34 passed, 10 correctly configuration-gated skips |
| Image/multi-view Playwright | 5 passed against real Storage and the deterministic Fake Provider Runtime |
| Focused real-Gateway Playwright | Agent work environment, adversarial boundary, Document, Prompt, and Storyboard passed; 2 runner-owned restart phases skipped here because their separate two-lifetime checkpoint already passes |
| Tauri native shell | 10 Rust unit tests passed; Doc tests passed |
| Changed-file lint | the packaging test and three changed E2E specs passed ESLint with zero warnings; the Fake Runtime fixture passed Ruff |
| Diff integrity | `git diff --check` passed; only Windows line-ending notices |

## Blocking Defects Found And Fixed

The first ordinary Playwright run failed 7 tests. The failures shared two release-runner causes:

1. The deterministic Fake Runtime predated the optional Agent work-environment route. Ordinary Canvas loads therefore saw repeated 404s, a second unrelated alert, and console failures. The fixture now returns a closed valid `configured=false` Bridge snapshot. This exercises the intended degradation state: Bridge unavailable, ordinary PromptCard workflows still usable.
2. The Agent work-environment and real Gateway attack specs asserted a Bridge token even under the Fake Runtime runner. They now declare their real-Gateway requirement and skip only when that profile is absent. A focused real-Gateway rerun proves both still execute rather than being silently disabled.

The long CVC scenario passed alone but used roughly 84–90 seconds while deliberately holding and rebasing a project save, copying/retrying a CVC, switching projects, inspecting/revoking the immutable snapshot, and cleaning two projects plus one asset. Its scenario-specific budget is now 120 seconds; no assertion or cleanup was removed. The complete two-worker suite then passed.

## Quality Baseline

The global ESLint command previously could not be a release gate: restrictive pytest artifact directories stopped enumeration, and the repository's documented 41-warning baseline exceeded a stale budget of 30. `.eslintignore` now excludes only test/cache/output directories, and `max-warnings=41` is a ratchet: zero errors and the current baseline pass; warning 42 fails. Feature work must not increase the budget. The 41 warnings remain a separate cleanup backlog and are not attributed to this Bridge implementation.

## Residuals

- Three Python tests are explicitly platform/environment skipped; no product failure is hidden.
- One Starlette `TestClient(timeout=...)` deprecation warning remains.
- Vite retains the documented CSS selector and bundle-size warnings.
- React test output retains existing duplicate-key and SSR `useLayoutEffect` warnings even though all assertions pass.
- TRAE remains an unverified candidate; Doubao and MarsCode remain pending official evidence plus real host smoke.
- Browser Asset Shelf/connectors remain outside Plan 008.

None of these residuals blocks the external Agent creative-context closed loop or risks stored project data.

## Merge Handoff

1. Commit and push this final-gate correction/evidence slice to `feat/skill-document-storyboard-loop`.
2. Confirm the feature branch is clean apart from pre-existing inaccessible pytest artifact directories that are intentionally neither read nor deleted.
3. Merge the feature branch into `main` without squashing away checkpoint history, then push `main`.
4. Verify remote `main` resolves to the merge result and that README/Plan 008 are present there.
