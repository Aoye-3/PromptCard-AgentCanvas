# Verification Checklist

Run before merging broad implementation or documentation restructuring:

```powershell
npm.cmd run test:frontend
.\agent-runtime\backend\.venv\Scripts\python.exe -m unittest discover -s promptcard_storage/tests -p "test_*.py"
.\agent-runtime\backend\.venv\Scripts\python.exe -m unittest promptcard_storage.tests.test_app
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
npm.cmd run agent:check
npm.cmd run text-agent:check
cd agent-runtime/backend
uv run pytest tests/test_promptcard_runtime_boundary.py -q
```

For text-Agent boundary changes, also run:

```powershell
npm.cmd test -- --run text-agent-runtime/src/provider-runtime.test.ts text-agent-runtime/src/proposal-policy.test.ts src/services/agent-runtime-service.test.ts src/stores/agent.store.test.ts
npm.cmd test -- --run src/components/agent/AgentConversationMenu.test.tsx src/components/skills/SkillHubScreen.test.tsx src/features/media/MediaScreen.test.tsx
npm.cmd test -- --run src/components/agent/canvas-agent-composer-model.test.ts src/components/AgentCollaborationPanel.test.tsx src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx
.\agent-runtime\backend\.venv\Scripts\python.exe -m pytest agent-runtime\backend\tests\test_promptcard_runtime_boundary.py agent-runtime\backend\tests\test_text_generation_providers.py -q -p no:cacheprovider
```

Verify all of the following boundaries:

- A project conversation survives frontend, Gateway, and text Runtime restart, and reloaded replies can refer to prior durable context.
- The same `requestId` does not duplicate messages or proposals, and a conversation cannot be read or continued from a different project, entrypoint, or mode.
- Conversation rename, Trash, restore, and permanent-delete behavior uses the independent Agent lifecycle; permanent deletion cascades messages, proposals, and completed turns.
- Prompt Library assistance and Media analysis do not appear in the project conversation list. Closing and reopening Media analysis produces an empty chat.
- Ordinary Media chat does not create a preview. Explicit preview generation, selection-scoped rewrite confirmation, editable preview, and explicit Prompt registration preserve the source media relationship.
- Canvas omnireference editing keeps one writable target and every other attached node read-only; `@` mentions cannot change those roles. Completion accepts only append, while rewrite accepts only a current user-text selection or the complete user part. Proposals preserve template segments and fail after node revision, template digest, user-content digest, or selected source text changes.
- The correct first-party Skill revision is bound by Canvas and Media entrypoints. An external Skill affects only the next message, clears after send, and is rejected when its declared tools exceed the current permission scope.
- PI-native and SDK-backed provider registration, internal-route authentication, and continued Canvas/image-generation use while the pi service is unavailable remain intact. The text selector groups `PI 原生` and SDK families, while the image selector contains only image models.

A live provider call is optional and must use an explicitly configured keyring credential.

For browser-facing changes, also smoke test the local app at:

```powershell
npm.cmd run test:e2e
```

For native screenshot changes, also run `cargo test` and `cargo build --release` from `src-tauri/`, then complete the Windows capture checks in [Native Screenshot Capture](../architecture/native-screenshot-capture.md). Verify the preparation label, hidden preload/activation handshake, visible gray drag layer, pointer capture, Escape/cancel recovery, 30-second startup recovery, and `started`/`ready` timing entries in `logs/desktop-shell.log`. Do not mark macOS or Linux support verified until those desktop checks run on their respective platforms.

For the Recent Capture image chain, verify native screenshot and ClipboardItem/DataTransfer PNG/JPEG/WebP intake, single/separate/merged Prompt registration, transaction rollback, and Canvas placement. The database and asset directory must still contain one asset row and one physical file for a Capture used by Prompt Library and Canvas. Complete these Windows checks before starting the recording phase described in [Plan 002](../Plan/002-floating-capture-video-asset-mvp.md).

For model-management or image-generation changes, additionally run from the repository root:

```powershell
npm.cmd run test:frontend
npm.cmd run build
npm.cmd run agent:check
npm.cmd run test:e2e
npm.cmd run test:e2e -- -c playwright.image-generation.config.ts
.\agent-runtime\backend\.venv\Scripts\python.exe -m unittest discover -s promptcard_storage/tests -p "test_*.py"
.\agent-runtime\backend\.venv\Scripts\python.exe -m pytest agent-runtime\backend\tests\test_image_generation_service.py agent-runtime\backend\tests\test_image_generation_storage_integration.py agent-runtime\backend\tests\test_image_result_fetcher.py agent-runtime\backend\tests\test_seedream_prompt_compiler.py agent-runtime\backend\tests\test_seedream_provider.py agent-runtime\backend\tests\test_model_connections.py agent-runtime\backend\tests\test_credential_store.py agent-runtime\backend\tests\test_csrf_middleware.py -q -p no:cacheprovider
.\agent-runtime\backend\.venv\Scripts\python.exe -m ruff check agent-runtime\backend\app agent-runtime\backend\tests
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

The dedicated Playwright config covers the image-generation node and multi-view flows, not model-management. The repository runner starts its own frontend, real SQLite Storage service, and Runtime with a Provider DI fake on ports `38100–38102`; those ports must be free. It fixes the browser path to the workspace `.playwright-browsers`, propagates the real Playwright exit code (or `124` on runner timeout), stops the owned service trees in `finally`, and verifies that the ports were released. This verifies HTTP/CSRF/Storage/UI integration without spending Ark quota or requiring a real credential. Do not bypass the runner with a direct Playwright CLI command.

Keep `TEMP`, `TMP`, Python/uv caches, `PLAYWRIGHT_BROWSERS_PATH`, and `CARGO_TARGET_DIR` on the current F: workspace when these commands need to provision caches. Set `PLAYWRIGHT_BROWSERS_PATH="$PWD\.playwright-browsers"` before any `npx.cmd playwright install`; normal test execution sets it through the runner. Always run the Storage gate with the explicit workspace `.venv` interpreter shown above; do not install `pillow_heif` globally to make a system Python pass. A live Ark smoke test must never be attempted without a user-configured keyring credential and explicit rollout enablement. Before production rollout, record Windows results for text-to-image, 2–10 reference images, smart edit, point, bbox, and visual-markup raster derivatives. Also verify standard/fast, 1K/2K, preset/custom size, PNG/JPEG, watermark, and Arabic/Japanese/German prompts. Record full-suite baseline failures separately from feature-focused failures.

Current known non-feature gates are tracked in the [Seedream implementation status](../Plan/005-seedream-image-node-frontend-implementation-status.md): the Runtime full suite includes Windows/POSIX/live-credential environment checks. Repository ESLint has zero errors and a ratcheted 41-warning baseline; warning 42 fails the gate. Do not increase that budget for feature work, and do not report platform/live-credential skips as a feature regression without reproducing them in the focused commands above.

Manual browser smoke testing is still useful when validating layout or copy. Start the local stack and use the `frontendUrl` in `logs/dev-runtime.json`.

For Agent live-model behavior, require a local key and avoid running secret-dependent checks in generic CI.
