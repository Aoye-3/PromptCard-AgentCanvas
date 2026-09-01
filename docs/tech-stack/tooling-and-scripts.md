# Tooling and Scripts

## Repository-Local Path Resolution

Launchers derive the repository root from their own location and keep dependencies, caches, builds, browser binaries, and test output on the repository drive. Workspace confinement is verified after resolving a path; committed scripts and tests must not encode the current drive letter or checkout path.

PromptCard Storage tests use `promptcard_storage.tests.workspace_paths.workspace_test_root()` for suite-specific parents under `.test-tmp/promptcard-storage/`. The policy test `promptcard_storage.tests.test_workspace_test_paths` rejects machine-bound roots and unqualified system temporary directories.

## Frontend

```powershell
npm.cmd run dev
npm.cmd run tauri:dev
npm.cmd test -- --run
npm.cmd run build
npm.cmd run test:e2e
npm.cmd run test:e2e:real-codex-discovery
```

`test:e2e` delegates to `scripts/run-e2e-tests.ps1`. That runner fixes browser binaries to the workspace `.playwright-browsers`, starts and owns Vite, the Fake Runtime, and Storage on ports `38100`, `38101`, and `38102`, propagates Playwright's real exit code, returns `124` on runner timeout, and stops the owned service trees in `finally` before verifying port release. The focused image-node and multi-view gate is:

`test:e2e:real-codex-discovery` switches the same runner to the real Gateway and an isolated `real-codex-e2e` repository scope, forwards only the Bridge URL/token/workspace root into the repository-owned STDIO MCP, and launches the signed-in Codex CLI with no PromptCard schema preloaded. The assertion source is Codex JSONL MCP events and bounded result payloads, not final model prose. This gate requires a locally authenticated Codex installation and is intentionally separate from the default offline E2E suite.

```powershell
npm.cmd run test:e2e -- -c playwright.image-generation.config.ts
```

The focused config intentionally excludes model-management. Do not invoke `playwright test` directly for these gates. If browser binaries must be installed, keep them in the workspace:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.playwright-browsers"
npx.cmd playwright install chromium
```

Run Storage verification through the canonical script. It derives the repository root and invokes the locked workspace virtual environment instead of resolving an ambient `python`:

```powershell
npm.cmd run storage:test
```

Do not install `pillow_heif` globally to change the result of this gate.

## Agent Runtime

```powershell
npm.cmd run agent:check
npm.cmd run agent:dev
npm.cmd run text-agent:dev
npm.cmd run text-agent:check
npm.cmd run dev:with-agent
```

`agent:dev` starts the Python Gateway. `text-agent:dev` starts the pi Node service, and `text-agent:check` type-checks that service. `agent:check` validates the Gateway, required Ark SDK adapter dependency, and pi TypeScript runtime; it does not require a configured model credential.

The PowerShell scripts derive the project root from `$PSScriptRoot`, so the project folder can be renamed without changing their core path logic. They do not load PromptCard provider credentials from `API-Key.txt` or provider environment variables. Model Management stores credentials in the operating-system keyring.

`scripts/start-dev-with-agent.ps1` is the full-stack local orchestrator. It uses `scripts/dev-port-runtime.ps1` to resolve local ports, writes `logs/dev-runtime.json`, exports the matching environment variables, and probes storage, Agent Runtime, and frontend health before starting new work.

Port inputs:

- `PROMPTCARD_FRONTEND_PORT`: optional strict frontend port. Without it, the frontend prefers `3000` and falls forward when busy.
- `PROMPTCARD_AGENT_PORT`: optional strict Python Gateway port. Without it, the orchestrator chooses a free local port.
- `PROMPTCARD_TEXT_AGENT_PORT`: optional strict pi text Agent port. Without it, the orchestrator chooses a free local port.
- `PROMPTCARD_STORAGE_PORT`: optional strict storage port. Without it, the orchestrator chooses a free local port.
- `PROMPTCARD_AGENT_URL` and `PROMPTCARD_STORAGE_URL`: exported by the orchestrator for Vite proxy targets.
- `PROMPTCARD_TEXT_AGENT_URL`: exported for Gateway-to-pi calls.
- `PROMPTCARD_GATEWAY_INTERNAL_URL` and `PROMPTCARD_INTERNAL_TOKEN`: exported for authenticated pi-to-Gateway model calls.
- `PROMPTCARD_STORAGE_HEALTH_URL`: exported for the PromptCard Runtime status check.
- `PROMPTCARD_IMAGE_GENERATION_NODE_V1`: trusted server rollout gate for new image-generation requests; disabled by default.

The startup script accepts injectable health URLs, timeout seconds, frontend command parameters, and runtime manifest path for Vitest coverage. The defaults preserve the normal `npm.cmd run dev:with-agent` and `start.bat` behavior.

`npm.cmd run tauri:dev` starts the Tauri desktop dev shell. Tauri delegates service startup to `npm.cmd run desktop:dev-services`, which reuses `logs/dev-runtime.json` when launched from `scripts/launch-desktop-shell.ps1`. The manifest schema includes separate Gateway and text-Agent URLs and health endpoints.
