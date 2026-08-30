# Troubleshooting

## Frontend Port Is Busy

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen
```

For plain `npm.cmd run dev`, stop only the known development server process, then restart `npm.cmd run dev`.

For `npm.cmd run dev:with-agent`, unspecified frontend ports prefer `3000` but fall forward automatically. If `PROMPTCARD_FRONTEND_PORT` is set, that explicit port is strict and startup fails until it is free.

## Startup Appears to Error but Services Are Healthy

Startup logs under `logs/*err.log` are process stderr streams. They may include normal uvicorn startup lines or Python warnings even when local development is healthy.

Verify the running services from the runtime manifest:

```powershell
Get-Content logs\dev-runtime.json
```

Use the `frontendUrl`, `agentHealthUrl`, and `storageHealthUrl` values from that file. If all three return successful responses, the local stack is running.

## Browser Is Blank but Localhost Returns 200

The Vite root URL can return the HTML shell even when a frontend module failed to transform. Check the Vite stderr log first:

```powershell
Get-Content logs\dev-server.err.log -Tail 120
```

If it contains a transform error such as `Unterminated string constant`, fix the referenced source file and run:

```powershell
npm.cmd run build
```

When the build passes but the browser is still blank, the likely cause is a stale Vite process or browser tab holding an old HMR error state. Open the active `frontendUrl` from `logs/dev-runtime.json`, or stop only the known Vite process and start again:

```powershell
npm.cmd run dev:with-agent
```

Use `npm.cmd` from PowerShell. Calling `npm` can resolve to `npm.ps1` and fail under a restricted execution policy.

## Desktop Shell Shows a White Screen During Startup

The main Tauri window should show the native `index.html` boot screen first, then the React startup screen while storage is checked. If the window is plain white or only a small empty card appears:

1. Confirm the current Vite HTML contains the boot screen:

   ```powershell
   $runtime = Get-Content logs\dev-runtime.json -Raw | ConvertFrom-Json
   (Invoke-WebRequest -UseBasicParsing $runtime.frontendUrl).Content | Select-String "boot-screen"
   ```

2. Check that the storage health proxy and direct storage health both succeed:

   ```powershell
   $runtime = Get-Content logs\dev-runtime.json -Raw | ConvertFrom-Json
   Invoke-WebRequest -UseBasicParsing $runtime.storageHealthUrl
   Invoke-WebRequest -UseBasicParsing "$($runtime.frontendUrl)storage-api/health"
   ```

   `/storage-api/health` must proxy to storage `/health`. It is not part of the normal `/storage-api/* -> /api/*` business API proxy.

   The response must report `serviceVersion: "2.0.0"` and `schemaVersion: 17`. `start.bat` and `start-desktop.bat` both reach the same combined service launcher, which rejects an older Storage schema instead of opening the frontend against it. If a stale process is still listening, inspect `logs/storage-service.err.log` and rerun the visible launcher rather than changing the expected schema in the script.

3. If only a tiny capture toolbar window is visible, close that toolbar window and relaunch the main window from `start-desktop.bat`. The toolbar is now created on demand from the Capture Bar page; its native boot screen is intentionally hidden for `/?window=capture-toolbar` so it does not display a clipped loading panel.

Run the focused startup UI checks after changing the boot screen, storage health probe, or Vite proxy:

```powershell
npx.cmd vitest run scripts/app-startup.test.ts vite.config.test.ts src/storage/storage-service-client.test.ts
```

For an end-to-end startup check from the batch entry point, run:

```powershell
npm.cmd run startup:test
```

If browser automation is blocked on the current machine, rerun with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-start-from-bat.ps1 -SkipBrowserCheck
```

## VBS Double-Click Returns but No Desktop Window Appears

`start-desktop.vbs` hides PowerShell, so a successful exit can look like nothing happened. First run the visible launcher from the project root:

```powershell
start-desktop.bat
```

If it reports that `PromptCard Manager Dev Shell` is already running but no main window is visible, check whether only toolbar/internal windows remain:

```powershell
Get-Process -Name promptcard-manager-dev-shell -ErrorAction SilentlyContinue |
  Select-Object Id,MainWindowTitle,MainWindowHandle,Path
```

`PromptCard Capture`, empty titles, or tiny `15x15` handles are not valid main windows. The maintained launcher enumerates top-level windows and only reuses a visible, full-size window titled `PromptCard Manager Dev Shell`; current-repo shell processes without such a window are stopped before relaunch.

If startup still times out after stale shell cleanup, verify the native side compiles:

```powershell
Push-Location src-tauri
cargo check
Pop-Location
```

Then rerun:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch-desktop-shell.ps1
```

If double-clicking `start-desktop.vbs` opens a browser instead of the desktop shell, verify the launcher still sets desktop mode before it starts Vite:

```powershell
Select-String -Path scripts\launch-desktop-shell.ps1 -Pattern 'PROMPTCARD_DESKTOP_DEV'
```

`PROMPTCARD_DESKTOP_DEV=1` suppresses Vite's browser auto-open behavior for the desktop launcher path.

## Screenshot Toolbar Disappears or the Desktop Stops Responding

The maintained screenshot lifecycle is: toolbar preparation state, hidden selector preload, selector activation, native frame capture, then a visible gray drag layer. The selector must never remain as an uninitialized transparent always-on-top window.

First inspect the native lifecycle log:

```powershell
Get-Content logs\desktop-shell.log -Tail 120
```

A successful start contains both entries with the same session ID:

```text
screenshot capture started; session=<id>
screenshot capture ready; session=<id>; elapsed_ms=<duration>
```

Interpret missing stages as follows:

- No `started`: the hidden selector did not activate. The 30-second watchdog should close it and restore the toolbar.
- `started` without `ready`: native monitor resolution or `xcap` capture is blocked. The watchdog restores the toolbar; inspect the following failure/timeout line.
- `ready` but no visible gray layer: check `capture-selection` focus/window events and verify the frontend production build succeeds.
- Toolbar returns but remains disabled: verify `capture-toolbar.json` includes `core:event:allow-listen`; native restoration emits `capture:toolbar-restored`.

Run the focused lifecycle checks after changing this path:

```powershell
npm.cmd test -- --run src/features/capture/FloatingCaptureToolbar.test.ts src/features/capture/ScreenshotCaptureOverlay.test.ts src-tauri/tauri-config.test.ts
Push-Location src-tauri
cargo test
Pop-Location
```

Do not work around this failure by showing the selector before the source frame is captured: the gray layer would enter the screenshot. Do not only lengthen the watchdog; use the stage timings to locate selector-load or native-capture delay.

## Agent Runtime Is Disconnected

```powershell
npm.cmd run agent:check
npm.cmd run agent:dev
```

Confirm that runtime bootstrap succeeds before the model panel loads. Then verify all of the following without printing the key value:

- one enabled text connection reports `credentialConfigured: true`;
- the latest connection test passed;
- one chat model is assigned to `chat.primary`;
- the conversation's model is still present in that connection's `agentChatModelIds` whitelist;
- `textAgentHealthUrl` from `logs/dev-runtime.json` is healthy.

If the connection list is unexpectedly empty after upgrading from the removed DeerFlow runtime, refresh Model Management once. The Gateway performs an idempotent merge from the sibling `.deer-flow/promptcard-model-connections.json` into `.promptcard-runtime` while preserving connection IDs and keyring references.

If text models appear in the image selector or image models appear in the text selector, treat it as a catalog/UI regression: connection discovery must first scope by provider, then filter by `modality`, then group by `integrationGroup`.

## Playwright Browser Missing

Install browsers only when browser verification is needed:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.playwright-browsers"
npx.cmd playwright install chromium
```

The workspace path must be set before installation; do not allow Playwright to fall back to a user-profile browser cache. Run tests through `npm.cmd run test:e2e` (or `npm.cmd run test:e2e -- -c playwright.image-generation.config.ts` for image-node and multi-view coverage), not through the Playwright CLI directly.

If an E2E run reports that ports `38100–38102` are occupied, identify the existing listeners before retrying:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 38100,38101,38102
```

The runner owns the Storage, Fake Runtime, and Vite process trees it starts. It returns the real Playwright exit code, returns `124` when `PROMPTCARD_E2E_RUNNER_TIMEOUT_SECONDS` expires, and stops its services in `finally`; it also fails a nominally successful run if the ports are not released. Do not hide a failure by manually rewriting the exit code.

## Storage Tests Fail With Missing `pillow_heif`

Run the Storage gate with the repository's workspace virtual environment:

```powershell
.\agent-runtime\backend\.venv\Scripts\python.exe -m unittest discover -s promptcard_storage/tests -p "test_*.py"
```

Do not install `pillow_heif` into the global Python environment. If the workspace environment is incomplete, repair it through the maintained workspace Runtime setup instead of changing the interpreter used by the gate.
