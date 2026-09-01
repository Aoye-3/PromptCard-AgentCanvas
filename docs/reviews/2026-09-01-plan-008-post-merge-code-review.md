# Plan 008 Post-Merge Code Review

## Scope

- Reviewed revision: `d09a0ab merge: close Plan 008 handoff`
- Feature range: the Plan 008 implementation merged by `7b64cf8`, including the `ea13377` final release slice
- Review date: 2026-09-01 (Europe/London)
- Axes: correctness, readability/simplicity, architecture, security, performance, and verification reproducibility

## Verdict

No Critical runtime correctness, authorization, data-loss, or secret-exposure defect was found in the inspected Bridge boundary. Production build, the frozen ESLint ratchet, and the MCP transport/security suite pass locally. The repository-location-dependent Storage test roots identified below were corrected in the review branch. One required architectural follow-up remains before another broad feature is added to the same modules: decompose the largest orchestration files instead of extending them further.

This is a post-merge maintenance verdict, not a reversal of the accepted Plan 008 behavioral evidence. The real-Codex closed loop, restart/replay checkpoint, adversarial gate, and final release matrix remain the authoritative release evidence.

## Required Follow-Ups

### 1. Remove repository-specific test roots

Nine committed Storage tests bound temporary data to `F:/.Agent-PromptCardManager/PromptCard-Manager` or the drive-relative `F:.test-tmp` form. Four additional suites used the operating-system default temporary directory. The machine-bound coverage included:

- `promptcard_storage/tests/test_creative_references_v17.py`
- `promptcard_storage/tests/test_bridge_delivery_ledger_v19.py`
- `promptcard_storage/tests/test_bridge_prompt_delivery_v19.py`
- `promptcard_storage/tests/test_bridge_image_delivery_v19.py`
- `promptcard_storage/tests/test_bridge_document_delivery_v19.py`
- `promptcard_storage/tests/test_bridge_storyboard_delivery_v19.py`
- `promptcard_storage/tests/test_canvas_reference_resolution.py`
- `promptcard_storage/tests/test_context_packs_v11.py`
- `promptcard_storage/tests/test_skill_packages_v13.py`

These paths make the tests fail or write outside the active checkout when the repository moves to another path or drive. In the current checkout, retained restricted test directories also prevented six ledger tests from creating SQLite files. Replace the constants with a repository-relative root derived from `Path(__file__).resolve()` or a test-runner-provided workspace-local temporary root, and ensure cleanup leaves no unreadable artifacts.

**Resolved in this review branch:** Storage tests now use the validated `workspace_test_root()` helper under `.test-tmp/promptcard-storage/`; a policy test rejects future drive-bound roots and unqualified system temporary directories. The six ledger tests pass outside the restricted sandbox.

### 2. Decompose orchestration hot spots before extending them

Plan 008 materially enlarged already broad modules:

| File | Current lines | Plan 008 net addition |
| --- | ---: | ---: |
| `src/components/canvas/FreeCanvasBuilderScreen.tsx` | 7,419 | +1,787 / -35 |
| `promptcard_storage/store.py` | 7,140 | +1,496 / -80 |
| `agent-runtime/backend/app/gateway/promptcard_runtime.py` | 4,054 | +2,868 / -62 |
| `src/storage/storage-service-client.ts` | 2,706 | +1,153 / -13 |
| `src/components/AgentCollaborationPanel.tsx` | 1,349 | +657 / -0 |
| `text-agent-runtime/src/agent-service.ts` | 1,246 | +874 / -17 |

The change has good focused domain modules, but the top-level Canvas, Storage, Gateway, client, and Agent orchestration still require readers to hold unrelated workflows in one file. Before adding another object kind or delivery mode, move Bridge inbox/acceptance orchestration into a dedicated Canvas hook/controller, split the Storage and browser Bridge clients by bounded API family, and move document/resource runtime orchestration behind focused services. Preserve the existing public contracts and regression tests during that refactor.

## Positive Findings

- Bridge bearer tokens resolve to configured profiles with constant-time comparison; request-supplied profile/scope fields cannot expand authority.
- Read, Document, Storyboard, Prompt, image, and status permissions are independent scopes and are rechecked before Storage mutation.
- Delivery preview, commit, status, and asset staging are profile-isolated and use explicit request digests for replay/conflict behavior.
- Gateway and Storage both validate exact CVC/source/Skill authority; the browser receives visual proposals rather than auto-applied writes.
- Workspace image staging checks real-path containment, traversal/junction escape, size, signature, declared length, and digest before Gateway I/O, then Gateway and Storage validate again.
- Loopback HTTP MCP validates Host, Origin, and a separate bearer token; the production environment is allowlisted to avoid ambient secret leakage.
- The implementation reuses the native Document/Storyboard/Prompt/image review paths and records durable provenance rather than introducing an unbounded Canvas mutation API.

## Local Verification

| Check | Result |
| --- | --- |
| `npm.cmd run build` | Passed; 1,981 modules. Existing CSS selector, mixed import, and chunk-size warnings remain. |
| `npm.cmd run lint` | Passed; 0 errors and the frozen 41-warning baseline. |
| `npm.cmd run test:contracts` | Passed; 52/52 v1/v2/v3 contract tests. |
| `npm.cmd run test:mcp` | Passed; 10/10 transport, authentication, environment-redaction, and workspace-path tests. |
| `npm.cmd run bridge:cli:check` and `npm.cmd run mcp:check` | Passed. |
| `npm.cmd run test:bridge-package` | Passed; 6/6 packaging, diagnostics, and maintained-link tests. |
| Gateway Bridge tests from `test_bridge_gateway.py` | 34 passed. |
| Workspace path policy plus ledger tests | 9 passed outside the restricted sandbox: 3 path-policy tests and all 6 ledger tests. The sandbox-only SQLite ACL failure remains classified as an execution-environment restriction. |
| Full PromptCard Storage discovery | 382 passed, 3 environment/platform skips, using the locked `agent-runtime/backend/.venv`. A first run with the wrong root `.venv` correctly failed for missing DOCX/HEIF dependencies and is not release evidence. |
| `git diff --check` and maintained relative-link checks | Passed; only Windows line-ending notices remain. |

The earlier full release counts and real-host evidence are preserved in [Plan 008 Final Release Matrix](./2026-09-01-plan-008-final-release-matrix.md).

## Documentation Maintenance

This review updates the current-state documentation without rewriting historical checkpoint context:

- Plan 008 is marked completed and merged.
- Plan 009 treats Stage 1 as the accepted baseline and keeps the exact shot model as the remaining gate before Stage 2.
- The project overview and documentation entry point now describe the shipped external-Agent loop and the next planning priority.
- ADR-022 retains its original decision context and adds the 2026-09-01 implementation outcome.
