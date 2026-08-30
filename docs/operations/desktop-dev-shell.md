# Desktop Dev Shell

The desktop dev shell is a Tauri window for local self-use while the source tree remains editable. It is not the production packaged app and it does not use GitHub Releases or a remote updater.

## What It Does

- Starts or reuses PromptCard Storage, the pi text Agent, the Python Gateway, and the Vite frontend.
- Opens the main desktop window titled `PromptCard Manager Dev Shell`.
- Leaves the floating capture toolbar closed by default; users open it from the Capture Bar page when needed.
- Loads the `frontendUrl` recorded in `logs/dev-runtime.json`, so Vite hot reload still reflects source edits even when port `3000` is already occupied.
- Exits the whole Tauri app and stops PromptCard Storage, the pi text Agent, the Python Gateway, and the Vite frontend when the main desktop window closes.
- Shows a desktop-only Update screen in the left sidebar for checking, previewing, backing up, and applying fast-forward source updates.

The main webview sets `dragDropEnabled: false`. Windows requires this for Explorer file drags to reach the React HTML5 handlers used by the free canvas. Re-enabling Tauri's native interception would require a separate native path-to-asset bridge.

The Capture Bar page in the main window owns toolbar start/close controls, status, preview, and planned module configuration. When started, the floating capture toolbar is a second Tauri window routed to `/?window=capture-toolbar`. It is undecorated, non-resizable, always on top, skipped from the taskbar, and uses a toolbar-only capability with limited event/window permissions. Closing the toolbar destroys that toolbar window and does not stop the local services; service shutdown and app exit are tied to the `main` window close path.

Screenshot click leaves the toolbar visible in a preparation state while the main window creates a third temporary window, `capture-selection`, hidden over the toolbar's display. After its frontend loads, the selector activates the session; Rust hides the toolbar, takes the native `xcap` frame on a blocking worker, then explicitly shows and focuses the gray drag layer. The selector capability may only activate, finish, or cancel the active screenshot session and emit completion events; it cannot invoke update, Git, or filesystem commands. Closing, cancelling, native failure, or the 30-second startup watchdog clears the matching in-memory session and restores the toolbar. See [Native Screenshot Capture](../architecture/native-screenshot-capture.md).

## Commands

Windows Tauri development requires Rust plus Microsoft C++ Build Tools. If `cargo check` fails with `link.exe not found`, install Visual Studio Build Tools with the Visual C++ workload and retry.

Run from the project root:

```powershell
npm.cmd run tauri:dev
```

Or double-click:

```text
start-desktop.vbs
start-desktop.bat
```

`start-desktop.vbs` is the quiet double-click entry point. It starts PowerShell with a hidden window and does not show a separate launcher splash, so the Tauri desktop window is the only startup UI. It only shows a message box if the launcher exits with a non-zero code. `start-desktop.bat` runs the same launcher with visible progress output and is preferred when diagnosing startup.

The desktop launcher prepares or reads `logs/dev-runtime.json`, starts Storage, pi, and the Python Gateway in background services-only mode, starts or reuses Vite, validates the frontend entry module, and then opens the Tauri shell. The service gate accepts PromptCard Storage only when `/health` reports `serviceVersion: "2.0.0"`, `schemaVersion: 17`, and SQLite capability; a schema mismatch is a launcher failure rather than a condition delegated to the React startup screen. Keep this contract synchronized with every Storage schema upgrade.

The launcher sets `PROMPTCARD_DESKTOP_DEV=1` before it starts Vite directly. Vite uses that flag to suppress its normal browser auto-open behavior; double-clicking `start-desktop.vbs` should open the Tauri shell, not a browser tab.

The first visible loading UI has two layers:

- `index.html` contains a native boot screen that appears before the React bundle renders. It is fixed to the full main window and hidden for `/?window=capture-toolbar` so the on-demand capture toolbar does not show a clipped blank loading card.
- `src/App.tsx` renders the React startup screen while the app probes the local storage service and loads durable data.

The frontend probes storage through `/storage-api/health`. Vite handles that path as a special proxy to the storage service root `/health`; normal storage business API calls still use `/storage-api/* -> <storageUrl>/api/*`. This keeps the React app same-origin while matching the FastAPI storage route layout.

Before launching, the script checks existing `promptcard-manager-dev-shell.exe` processes from the current repository. It only reuses a visible, full-size top-level window titled `PromptCard Manager Dev Shell`. Hidden toolbar windows, `PromptCard Capture`, `Tao Thread Event Target`, and tiny internal windows are ignored. If current-repo shell processes exist without a valid main window, they are treated as stale and stopped before relaunching.

When the selected frontend port is `3000` and the debug executable is newer than the Rust sources and Tauri configuration, the launcher directly runs the existing debug shell. This skips the `tauri dev` compile/watch startup on normal launches. Changes under `src-tauri/src/`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/Cargo.toml`, or `src-tauri/build.rs` automatically use the slower rebuild path once. The launcher waits until a real main window is detected.

When the selected frontend port is not `3000`, the launcher writes an ignored Tauri runtime config at:

```text
logs/tauri.dev-runtime.conf.json
```

It then starts `tauri dev --config <that file>` so the webview points at the actual `frontendUrl`.
The generated config removes `beforeDevCommand`; otherwise Tauri dev would run the old service startup path and wait for the full service chain before opening the window.

To deliberately rebuild the shell while diagnosing native changes, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch-desktop-shell.ps1 -ForceRebuild
```

`start-desktop.bat` is only a visible launcher wrapper. Closing the launcher terminal does not close the desktop window or its local services.

The legacy Tauri `beforeDevCommand` still points at:

```powershell
npm.cmd run desktop:dev-services
```

The desktop launcher avoids that path for dynamic-port launches by writing `logs/tauri.dev-runtime.conf.json`. The maintained editable-development Storage Service root is the repository `data/` directory. Direct `npm.cmd run tauri:dev` still uses the static Tauri config and legacy `beforeDevCommand`; until its environment is unified, it may select a different storage path and must not be treated as an interchangeable launcher. Startup details, including the actual frontend, Agent Runtime, storage URLs, and Storage health path, are recorded in `logs/dev-runtime.json`.

## Durable Data And Runtime Profile

Editable-development durable storage and runtime state have separate roots inside the workspace:

```text
data/
  promptcard.sqlite3
  assets/
  capture-staging/

backups/

logs/
  dev-runtime.json
  tauri.dev-runtime.conf.json
  desktop-profile/
    agent-runtime/
      .promptcard-runtime/
    config/
      desktop-shell.json
      update-source.json
```

Maintained launchers pass explicit paths to local services:

```text
PROMPTCARD_STORAGE_DATA_DIR=<repository>\data
PROMPTCARD_RUNTIME_STATE_DIR=<desktop-profile>\agent-runtime\.promptcard-runtime
PROMPTCARD_LIBRARY_FILE=<repository>\data\prompt-library-presets.json
PROMPTCARD_LOGS_DIR=<desktop-profile>\logs
PROMPTCARD_DESKTOP_PROFILE_ROOT=<desktop-profile>
```

Repository `data/` is the live Storage Service source of truth, not a compatibility seed. Legacy JSON files and browser cache remain migration inputs. Logs, update configuration, and Agent Runtime state may stay in the Desktop Profile, but no maintained launcher should create a second live Storage database under it.

Plain `npm.cmd run dev:with-agent` uses the repository storage root. All other maintained launchers must converge on the same `PROMPTCARD_STORAGE_DATA_DIR` and fail fast when Storage health reports a different path.

## Shutdown Behavior

Closing the main Tauri window stops the local PromptCard services resolved through the dev runtime manifest, including pi and the Python Gateway, and exits the whole Tauri app. This prevents any open floating capture toolbar from keeping `promptcard-manager-dev-shell.exe` alive after the main window is gone.

Closing the floating capture toolbar affects only that toolbar window. It must not stop Storage, pi, the Python Gateway, or Vite. Reopen it from the Capture Bar page.

Closing only the `start-desktop.bat` launcher terminal does not stop the desktop shell. Use the app window close button when you want the desktop shell and local services to shut down together.

Plain terminal development remains manual: when you start services with `npm.cmd run dev:with-agent`, close that terminal or stop the processes yourself.

## Source Update

The left-sidebar Update screen owns guarded source updates. It stores its update source metadata in:

```text
logs/desktop-profile/config/update-source.json
```

The command set is:

1. `update_get_config` reads Profile update config and fills missing values from the current Git remote and branch.
2. `update_save_config` writes the selected GitHub URL, remote name, and branch into the Profile config.
3. `update_check` runs `git ls-remote` against the configured branch and records the latest remote commit.
4. `update_preview` runs `git fetch --no-tags <repoUrl> <branch>`, diffs `HEAD..FETCH_HEAD`, and classifies changed paths.
5. `update_apply` requires a clean worktree, blocks protected or manual-review paths, creates a SQLite/assets backup under `backups/`, then runs `git merge --ff-only FETCH_HEAD`.

It uses the system Git credentials. The app does not store GitHub tokens or PATs.

Automatic update currently covers AppShell, desktop shell, storage service, the Python Gateway, and the pi text runtime through this allowlist:

```text
src/
src-tauri/
promptcard_storage/
scripts/
docs/
public/
vite/
agent-runtime/backend/
text-agent-runtime/
```

The update classifier continues to block or require manual review for local-only runtime data and configuration:

```text
logs/desktop-profile/
data/
backups/
.env*
API-Key.txt
agent-runtime/.promptcard-runtime/
agent-runtime/.agent/
```

The legacy Tauri command `git_pull_source` remains for compatibility with old desktop builds, but product UI should use the Update screen.

## Current Limits

- This is a development shell, not an installer.
- It does not perform dependency installation after source updates; the Update screen reports when dependency manifests changed.
- It does not migrate data during source updates.
- The Capture Bar page currently starts and closes the screenshot toolbar only. Recording, audio capture, GIF export, video canvas nodes, frame extraction, Storyboard inference, visual Agent analysis, and global shortcuts remain planned modules.
- Screenshot capture uses native `xcap` for the display containing the floating toolbar; no WebView screen-share picker is used. This is implemented and build-verified on Windows, but manual single-display, multi-display, and mixed-DPI validation remains required. macOS and Linux are not yet validated.
- Toolbar position persistence is not implemented yet.
- If an existing service is already healthy but points at a different data directory, startup should fail instead of silently reusing it.
- Before public distribution, keep personal data out of release artifacts and migrate the repository storage root to the packaged app's approved user-data directory.

## Application Icon

The maintained transparent source icon is `public/app-icon.png`. It is used as the browser favicon and as the source for the generated Tauri icon set under `src-tauri/icons/`.

Regenerate the desktop icon set after replacing the source:

```powershell
npx.cmd tauri icon public/app-icon.png
```
