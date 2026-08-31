# Testing and Quality

## Current Test Areas

The current frontend test suite covers several core utilities and stores:

- prompt parsing
- prompt composer behavior
- storage behavior
- project normalization and project merge behavior
- storyboard sequence/row operations
- three-stage output definitions
- Vite dev endpoint payload validation
- preset ordering
- card initial state
- card persistence
- example store behavior
- Agent runtime proposal parsing
- pi proposal policy for Canvas target/reference roles and append/rewrite behavior
- PromptCard Runtime boundary and local internal-token authentication
- Media Library one-image multimodal analysis boundary
- Agent workspace context building
- Agent store `sendMessage()` proposal return behavior
- local startup script parsing and health-check branching
- SQLite JSON migration, backup, revision, concurrency, Trash transaction, browser import idempotency, and asset metadata
- storage HTTP client timeout, structured-error, revision-conflict, missing-item, and asset-upload contracts
- injectable FastAPI storage route contracts for assets, errors, preset batches, and browser migration
- free-canvas image asset service behavior, including batch upload failure
- project Image Generation conversations, legacy read-only generator normalization, structured `@` references, source/reference roles, size/region/annotation validation, project-scoped lifecycle reconciliation, permanent history UI, and generated-result Media reuse
- model catalog/connection/assignment contracts, OS keyring storage and transactional legacy migration
- Seedream prompt/provider mapping, standard/fast optimization, URL/Base64 response handling, multilingual Prompt preservation, sanitized errors, secure result download, input/concurrency limits, and terminal run persistence
- contextual operation cross-field semantics, all-operation Fake Provider lifecycle/lineage, prepared-run conflict handling, atomic multi-view preparation, and queued interruption recovery
- PromptCard Storage schema v3→v4→v5 migration, original/derived image import, project conversation/run pagination, placement state machine, output/original/derived strong references, and Runtime-to-Storage SQLite integration

Tests are run through Vitest.

Vitest excludes `tests/e2e/**` so Playwright specs are not collected by the unit-test runner.

## Recommended Verification Matrix

Before merging implementation work, run:

```powershell
npm.cmd run build
npm.cmd run test:frontend
.\agent-runtime\backend\.venv\Scripts\python.exe -m unittest discover -s promptcard_storage/tests -p "test_*.py"
npm.cmd run lint
```

`test:frontend` runs the complete Vitest suite as four bounded, sequential shards. Each shard writes its native process output to `.tmp/frontend-tests` before replaying it, which prevents Windows child-process tests from keeping the calling output pipe open. Use `npm.cmd test -- --run <files>` for focused local verification.

For Agent Runtime work, also run:

```powershell
npm.cmd run agent:check
.\agent-runtime\backend\.venv\Scripts\python.exe -m pytest agent-runtime\backend\tests -q -p no:cacheprovider
.\agent-runtime\backend\.venv\Scripts\python.exe -m ruff check agent-runtime\backend\app agent-runtime\backend\tests
```

The full Runtime Ruff gate currently passes for `app` and `tests`; the image-generation E2E Runtime fixture is checked separately.

On Windows, Runtime and Storage pytest runs that use `tmp_path` must use a unique workspace-local base directory because stale pytest directories may retain restrictive ACLs. Keep the directory on the repository drive:

```powershell
$baseTemp = Join-Path $PWD ('.tmp\pytest-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
New-Item -ItemType Directory -Force -Path $baseTemp | Out-Null
& .\agent-runtime\backend\.venv\Scripts\python.exe -m pytest agent-runtime\backend\tests promptcard_storage\tests -q --basetemp $baseTemp
```

Use a unique workspace-local Ruff cache for the same reason:

```powershell
$env:RUFF_CACHE_DIR = Join-Path $PWD ('.tmp\ruff-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
& .\agent-runtime\backend\.venv\Scripts\python.exe -m ruff check agent-runtime\backend\app agent-runtime\backend\tests
```

The Plan 007 backend closure specifically asserts that all queued multi-view runs and all placeholders exist before the first Fake Provider call, batch failure produces zero Provider calls, queued reload resumes once at concurrency 1, running reload never resubmits, and localized output is stored before `succeeded`.

For startup script work, run:

```powershell
npm.cmd test -- --run scripts/start-dev-with-agent.test.ts scripts/launch-desktop-shell.test.ts
```

For browser-facing changes, start the local stack and read the active browser URL from:

```powershell
Get-Content logs\dev-runtime.json
```

After the automated browser checks pass, complete the [manual frontend acceptance checklist](manual-frontend-acceptance.md). It is the canonical procedure for populated-canvas visibility, viewport and zoom behavior, keyboard focus, right-workspace isolation, non-destructive export, multi-view recovery, and capability-limited states. Record browser evidence without credentials, authorization headers, temporary provider URLs, or raw provider responses.

The Playwright smoke suite runs through:

```powershell
npm.cmd run test:e2e
```

The project image-generation integration uses dedicated workspace-local state, a real PromptCard Storage SQLite process, the real Runtime image router/service, and a dependency-injected fake provider/result fetcher. Run its image-node and multi-view subset through the same repository runner:

```powershell
npm.cmd run test:e2e -- -c playwright.image-generation.config.ts
```

The dedicated config includes `image-generation-node.spec.ts` and `free-canvas-multi-view.spec.ts`; it does not include model-management.

Both commands delegate to `scripts/run-e2e-tests.ps1`. The runner fixes `PLAYWRIGHT_BROWSERS_PATH` to the workspace `.playwright-browsers`, owns Storage/Fake Runtime/Vite on ports `38102`/`38101`/`38100`, propagates Playwright's real exit code, returns `124` on runner timeout, and stops the owned service trees in `finally` before verifying that all three ports were released. Do not bypass it with a direct Playwright test command.

In restricted sandbox environments, Chromium launch may require elevated execution permissions.

The focused image-generation commands are the regression gate for this feature. The Runtime full suite also contains live-model, POSIX/Docker, symlink-privilege, and cross-platform path tests; record those environment failures separately instead of attributing them to Seedream changes. Repository ESLint uses a ratcheted 41-warning baseline: `npm.cmd run lint` must have zero errors and cannot introduce warning 42. Pytest/output directories are ignored so restrictive test-artifact ACLs cannot prevent source enumeration. Reduce the baseline in a dedicated cleanup rather than increasing it for feature work; see the maintained [implementation status](../Plan/005-seedream-image-node-frontend-implementation-status.md).

## Acceptance Scenarios

### Project Flow

- Create a card project.
- Add and edit cards.
- Save and reopen the project.
- Create a storyboard project.
- Add/edit sequence and shot fields.
- Create a three-stage project.
- Edit character, storyboard, and video-prompt structured fields.
- Confirm example text appears as placeholder guidance and empty fields do not appear in copied output.
- Confirm camera-bound three-stage fields can append and replace values from `camera` Prompt library presets.
- Save and reopen the three-stage project.
- Confirm project list ordering follows recent activity.

### Prompt Library Flow

- Load initial presets.
- Add a preset.
- Update a preset.
- Delete a preset.
- Reorder presets.
- Confirm usage count increments when a preset is applied.
- Confirm dev file persistence works when the Vite endpoint is available.
- Confirm whole-library replacement commits atomically through the batch endpoint.

### Agent Dashboard Flow

- Runtime status moves from unknown to connected when Agent Runtime is available.
- Local session bootstrap completes without showing a second login form.
- Text models load under `PI 原生` and SDK integration groups with no image-model leakage.
- Both a PI-native provider descriptor and an SDK-backed provider descriptor register through the pi provider collection; an assigned compatible text model returns an assistant response.
- Prompt library proposal JSON is parsed into a pending proposal.
- Approving a proposal updates the Prompt library through preset store methods.
- Rejecting a proposal does not mutate the Prompt library.

### Agent Collaboration Flow

- Attach target X and reference nodes Y/Z, mention them with `@`, and confirm only X can receive a pending `free_canvas_text_insertions` or source-bound derived-node proposal.
- In completion mode, confirm Apply inserts black user segments at exact anchors without changing any existing character, segment order, source, or color.
- In rewrite mode, confirm approval creates a complete derived node to X's right and leaves X unchanged; text selection must not change the request contract.
- Change the node, template, segments, or anchored source text after generation and confirm the whole stale proposal is rejected.
- Switch between two allowed conversation models, reload the conversation, and confirm the selection and first-execution turn snapshot persist.
- Remove the target while keeping references and confirm discussion works but no Canvas mutation proposal is accepted.
- Reject a proposal and confirm Canvas is unchanged.
- Confirm no Canvas mutation occurs before Apply.
- When runtime is disconnected, the panel shows a readable error while Canvas editing and Image Generation remain usable.

### Media Analysis Flow

- Select one image in Media Library and run style analysis.
- Confirm the request contains only that asset ID/content type.
- Confirm the response is read-only and contains no Canvas or Prompt Library proposal.
- Confirm non-image media is rejected until video analysis is implemented.

### Development Server Shutdown

- Open `Me`.
- Open settings.
- Click **Close development server**.
- Confirm the browser shows the closed-server message.
- Confirm the Vite dev server stops listening on the `frontendUrl` port from `logs/dev-runtime.json`.

### Image Generation Flow

- Create a Volcengine Ark connection and confirm the credential field clears after submit and never appears in the DOM or API response.
- Assign `doubao-seedream-5-0-pro-260628` to `image.primary`.
- Open the project-level `图片生成` tab, explicitly inject selected text/image canvas nodes, and confirm no selection or edge change triggers a request.
- Confirm structured `@` tokens remain bound to the same asset after reordering while compiled image numbers change.
- Validate 1K/2K and custom-size limits; confirm unsupported 4K/native mask/stream controls are absent.
- Save point/bbox region intent, generate through a fake provider in automated tests, and confirm a local asset, `generatedResult` capture, and succeeded run are created.
- Retry a failed run and confirm the retry has a different run ID and both records remain visible.
- Reload/restart and confirm history/output access; permanently delete the project and confirm history and its output asset remain queryable.
- Confirm every successful run is placed once as a normal image node, then use its manual continuation menu to prefill reference generation, smart edit, or region edit without invoking the provider until Generate is clicked again.

## Quality Gates

- Do not commit secrets.
- Do not commit generated virtual environments, uv caches, or local runtime databases.
- Keep docs aligned with current code behavior.
- Label deferred pi/Text Agent capabilities as roadmap instead of current behavior.
- For storage changes, verify strict JSON migration, SQLite integrity, deterministic concurrent writes, transactional Trash and batch operations, structured errors, failed-request retention, and idempotent browser migration. Projects and Prompt Library presets have no JSON or browser write fallback.
- The Storage gate must use the workspace `.venv` Python with unittest discovery so new SQLite and asset test modules cannot be silently omitted. Do not repair missing `pillow_heif` by installing it into global Python. FastAPI contract tests explicitly skip when their optional dependency is unavailable and must also pass in the repository Agent backend environment.
- Save-concurrency Playwright tests must echo the request's real project ID and type. Use a request-start barrier before releasing delayed responses; fixed sleeps do not prove stale-response ordering.
- Free-canvas image coverage must verify supported asset validation, path traversal rejection, drag-and-drop node creation, minimal image rendering, manual horizontal and vertical crop lines, line deletion, cancel behavior, and non-destructive derived-node creation.
- For Agent collaboration changes, verify that Prompt Library and Canvas writes both require explicit approval.
- For image-generation changes, verify the trusted server feature gate rejects before run creation/credential access, the browser never calls a provider directly, total inputs stay at or below ten, and all terminal paths persist either `succeeded` or `failed` without remote URLs or raw secrets.

## Roadmap / Not Yet Implemented

- The automated image-generation integration uses a dependency-injected provider and deterministic local image result. Real Windows Credential Locker + live Ark coverage remains a release-time manual smoke test.
- Agent live-model tests depend on the selected provider's configured keyring credential and should not run in generic CI without secret configuration.
- Durable Agent tests cover idempotent turns, project isolation, proposal-state reload, conversation Trash/restore/permanent-delete, and recorded Skill revision/digest audit.
