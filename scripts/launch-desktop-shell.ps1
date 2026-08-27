param(
  [switch]$NoLaunch,
  [switch]$ForceRebuild,
  [int]$StartupTimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$DesktopShellExecutable = Join-Path $RepoRoot "src-tauri\target\debug\promptcard-manager-dev-shell.exe"
$StartDevWithAgentScript = Join-Path $RepoRoot "scripts\start-dev-with-agent.ps1"
$StartDesktopDevServicesScript = Join-Path $RepoRoot "scripts\start-desktop-dev-services.ps1"
& { . $StartDesktopDevServicesScript -InitializeOnly }
$LogsDir = if ($env:PROMPTCARD_LOGS_DIR) { $env:PROMPTCARD_LOGS_DIR } else { Join-Path $RepoRoot "logs" }
$RuntimeManifestPath = if ($env:PROMPTCARD_DEV_RUNTIME_MANIFEST) { $env:PROMPTCARD_DEV_RUNTIME_MANIFEST } else { Join-Path $LogsDir "dev-runtime.json" }
$DesktopServicesOutLog = Join-Path $LogsDir "desktop-services.out.log"
$DesktopServicesErrLog = Join-Path $LogsDir "desktop-services.err.log"
$ViteFrontendOutLog = Join-Path $LogsDir "vite-frontend.out.log"
$ViteFrontendErrLog = Join-Path $LogsDir "vite-frontend.err.log"
$TauriDevOutLog = Join-Path $LogsDir "tauri-dev.out.log"
$TauriDevErrLog = Join-Path $LogsDir "tauri-dev.err.log"
$TauriDevConfigPath = Join-Path $LogsDir "tauri.dev-runtime.conf.json"
$DesktopShellBuildStampPath = Join-Path $LogsDir "desktop-shell-build.stamp.json"
$DesktopProcessName = "promptcard-manager-dev-shell"
$DesktopMainWindowTitle = "PromptCard Manager Dev Shell"
$DesktopMinMainWindowWidth = 400
$DesktopMinMainWindowHeight = 300
$LaunchMutexName = "Local\PromptCardManagerDesktopShellLaunch"
. (Join-Path $PSScriptRoot "dev-port-runtime.ps1")

function Test-HttpOk($Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 2
    return $response.StatusCode -eq 200
  }
  catch {
    return $false
  }
}

function Wait-HttpHealthy($Name, $Url) {
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk $Url) { return }
    Start-Sleep -Milliseconds 300
  }
  throw "$Name did not become healthy within $StartupTimeoutSeconds seconds: $Url"
}

function Start-HiddenLoggedCommand {
  param(
    [string]$Command,
    [string]$StdoutPath,
    [string]$StderrPath
  )

  $cmdLine = "$Command 1>`"$StdoutPath`" 2>`"$StderrPath`""
  Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/d", "/s", "/c", $cmdLine) `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden | Out-Null
}

function Wait-DevRuntimeHealthy {
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $runtime = Read-PromptCardDevRuntime $RuntimeManifestPath
    if ($runtime -and $runtime.frontendUrl -and (Test-PromptCardFrontend $runtime.frontendUrl)) {
      return $runtime
    }
    Start-Sleep -Milliseconds 300
  }
  throw "Vite frontend did not become healthy within $StartupTimeoutSeconds seconds. Runtime manifest: $RuntimeManifestPath"
}

function Get-OrCreateDevRuntime {
  $runtime = Read-PromptCardDevRuntime $RuntimeManifestPath
  if ($runtime -and $runtime.frontendUrl -and (Test-PromptCardFrontend $runtime.frontendUrl)) {
    return $runtime
  }

  Stop-StaleFrontendProcesses
  return New-PromptCardDevRuntime `
    -RepoRoot $RepoRoot `
    -ManifestPath $RuntimeManifestPath `
    -FrontendUrlOverride $env:PROMPTCARD_FRONTEND_URL `
    -AgentHealthUrlOverride $env:PROMPTCARD_AGENT_HEALTH_URL `
    -StorageHealthUrlOverride $env:PROMPTCARD_STORAGE_HEALTH_URL
}

function Stop-StaleFrontendProcesses {
  $repoRootText = [string]$RepoRoot
  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $matchedProcessIds = @{}

  foreach ($process in $allProcesses) {
    $commandLine = [string]$process.CommandLine
    if (!$commandLine.Contains($repoRootText)) { continue }
    if (
      $commandLine.Contains("vite --strictPort") -or
      $commandLine.Contains("vite\bin\vite.js") -or
      $commandLine.Contains("npm-cli.js`" run dev") -or
      $commandLine.Contains("npm.cmd run dev")
    ) {
      $matchedProcessIds[[int]$process.ProcessId] = $true
    }
  }

  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $allProcesses) {
      if ($matchedProcessIds.ContainsKey([int]$process.ProcessId)) { continue }
      if ($matchedProcessIds.ContainsKey([int]$process.ParentProcessId)) {
        $matchedProcessIds[[int]$process.ProcessId] = $true
        $changed = $true
      }
    }
  }

  $processes = $allProcesses |
    Where-Object { $matchedProcessIds.ContainsKey([int]$_.ProcessId) } |
    Sort-Object CreationDate -Descending

  foreach ($process in $processes) {
    if ($process.ProcessId -eq $PID) { continue }
    Write-Host "Stopping stale Vite frontend process (PID $($process.ProcessId)): $($process.Name)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Write-TauriDevRuntimeConfig($Runtime) {
  New-Item -ItemType Directory -Force -Path (Split-Path $TauriDevConfigPath -Parent) | Out-Null
  $configPath = Join-Path $RepoRoot "src-tauri\tauri.conf.json"
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $config.build.devUrl = ([string]$Runtime.frontendUrl).TrimEnd("/")
  $config.build.beforeDevCommand = "cmd /c exit 0"
  [System.IO.File]::WriteAllText($TauriDevConfigPath, ($config | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
  return $TauriDevConfigPath
}

function Test-DesktopShellCurrent {
  param([switch]$IgnoreForceRebuild)

  if ((!$IgnoreForceRebuild -and $ForceRebuild) -or !(Test-Path -LiteralPath $DesktopShellExecutable)) { return $false }

  $executableTime = (Get-Item -LiteralPath $DesktopShellExecutable).LastWriteTimeUtc
  $inputs = Get-DesktopShellSourceFiles
  if ($inputs | Where-Object { $_.LastWriteTimeUtc -gt $executableTime } | Select-Object -First 1) { return $false }
  if (!(Test-Path -LiteralPath $DesktopShellBuildStampPath)) { return $false }

  try {
    $stamp = Get-Content -LiteralPath $DesktopShellBuildStampPath -Raw | ConvertFrom-Json
    return $stamp.sourceFingerprint -eq (Get-DesktopShellSourceFingerprint)
  }
  catch {
    return $false
  }
}

function Get-DesktopShellSourceFiles {
  @(
    Get-ChildItem -LiteralPath (Join-Path $RepoRoot "src-tauri\src") -Recurse -File
    Get-Item -LiteralPath (Join-Path $RepoRoot "src-tauri\tauri.conf.json")
    Get-Item -LiteralPath (Join-Path $RepoRoot "src-tauri\capabilities\default.json")
    Get-Item -LiteralPath (Join-Path $RepoRoot "src-tauri\capabilities\capture-toolbar.json")
    Get-Item -LiteralPath (Join-Path $RepoRoot "src-tauri\Cargo.toml")
    Get-Item -LiteralPath (Join-Path $RepoRoot "src-tauri\build.rs")
  )
}

function Get-DesktopShellSourceFingerprint {
  $hashInput = Get-DesktopShellSourceFiles |
    Sort-Object FullName |
    ForEach-Object {
      $fullPath = [System.IO.Path]::GetFullPath([string]$_.FullName)
      $relativePath = $fullPath.Substring(([string]$RepoRoot).Length).TrimStart("\", "/")
      $fileSha256 = [System.Security.Cryptography.SHA256]::Create()
      try {
        $fileHash = [System.BitConverter]::ToString($fileSha256.ComputeHash([System.IO.File]::ReadAllBytes($fullPath))).Replace("-", "").ToLowerInvariant()
      }
      finally {
        $fileSha256.Dispose()
      }
      "$relativePath=$fileHash"
    }

  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($hashInput -join "`n"))
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
  }
  finally {
    $sha256.Dispose()
  }
}

function Write-DesktopShellBuildStamp {
  New-Item -ItemType Directory -Force -Path (Split-Path $DesktopShellBuildStampPath -Parent) | Out-Null
  $stamp = [pscustomobject]@{
    sourceFingerprint = Get-DesktopShellSourceFingerprint
    executablePath = [string]$DesktopShellExecutable
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  [System.IO.File]::WriteAllText($DesktopShellBuildStampPath, ($stamp | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
}

function Start-DesktopShellExecutable {
  $process = Start-Process -FilePath $DesktopShellExecutable -WorkingDirectory (Split-Path $DesktopShellExecutable) -PassThru
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) {
    throw "Desktop shell exited immediately with code $($process.ExitCode)."
  }
  return $process
}

function Initialize-DesktopWindowInterop {
  if ("PromptCard.DesktopWindowInterop" -as [type]) { return }

  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace PromptCard {
  public static class DesktopWindowInterop {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
      public int Left;
      public int Top;
      public int Right;
      public int Bottom;
    }

    public sealed class WindowInfo {
      public int ProcessId { get; set; }
      public IntPtr Handle { get; set; }
      public string Title { get; set; }
      public string ClassName { get; set; }
      public bool Visible { get; set; }
      public bool Minimized { get; set; }
      public int Left { get; set; }
      public int Top { get; set; }
      public int Width { get; set; }
      public int Height { get; set; }
      public int Area { get { return Width * Height; } }
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    public static WindowInfo[] GetTopLevelWindows(int[] processIds) {
      var targets = new HashSet<int>(processIds);
      var windows = new List<WindowInfo>();

      EnumWindows((hWnd, lParam) => {
        uint rawPid;
        GetWindowThreadProcessId(hWnd, out rawPid);
        var pid = (int)rawPid;
        if (!targets.Contains(pid)) {
          return true;
        }

        RECT rect;
        GetWindowRect(hWnd, out rect);
        var title = new StringBuilder(512);
        var className = new StringBuilder(512);
        GetWindowText(hWnd, title, title.Capacity);
        GetClassName(hWnd, className, className.Capacity);

        windows.Add(new WindowInfo {
          ProcessId = pid,
          Handle = hWnd,
          Title = title.ToString(),
          ClassName = className.ToString(),
          Visible = IsWindowVisible(hWnd),
          Minimized = IsIconic(hWnd),
          Left = rect.Left,
          Top = rect.Top,
          Width = rect.Right - rect.Left,
          Height = rect.Bottom - rect.Top
        });

        return true;
      }, IntPtr.Zero);

      return windows.ToArray();
    }
  }
}
"@
}

function Get-CurrentDesktopShellProcesses {
  if (!(Test-Path -LiteralPath $DesktopShellExecutable)) { return @() }

  $expectedPath = [System.IO.Path]::GetFullPath([string]$DesktopShellExecutable)
  return Get-CimInstance Win32_Process -Filter "Name='promptcard-manager-dev-shell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and
        [System.StringComparer]::OrdinalIgnoreCase.Equals(
          [System.IO.Path]::GetFullPath([string]$_.ExecutablePath),
          $expectedPath
        )
    } |
    Sort-Object CreationDate -Descending
}

function Get-DesktopShellWindows($Processes) {
  $processIds = @($Processes | Select-Object -ExpandProperty ProcessId)
  if ($processIds.Count -eq 0) { return @() }

  Initialize-DesktopWindowInterop
  return [PromptCard.DesktopWindowInterop]::GetTopLevelWindows([int[]]$processIds)
}

function Get-ExistingDesktopShellWindow {
  $processes = @(Get-CurrentDesktopShellProcesses)
  if ($processes.Count -eq 0) { return $null }

  return Get-DesktopShellWindows $processes |
    Where-Object {
      $_.Visible -and
        $_.Title -eq $DesktopMainWindowTitle -and
        $_.Width -ge $DesktopMinMainWindowWidth -and
        $_.Height -ge $DesktopMinMainWindowHeight
    } |
    Sort-Object Area -Descending |
    Select-Object -First 1
}

function Stop-StaleDesktopShellProcesses($Processes) {
  foreach ($process in $Processes) {
    Write-Host "Stopping stale desktop shell process (PID $($process.ProcessId)); no main window was found."
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Show-DesktopShellWindow($Window) {
  if (!$Window) { return $false }

  Initialize-DesktopWindowInterop
  $handle = [System.IntPtr]$Window.Handle
  [PromptCard.DesktopWindowInterop]::ShowWindowAsync($handle, 9) | Out-Null
  [PromptCard.DesktopWindowInterop]::SetForegroundWindow($handle) | Out-Null
  return $true
}

function Wait-DesktopShellProcess($StartedAfter) {
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $mainWindow = Get-ExistingDesktopShellWindow
    if ($mainWindow -and (Show-DesktopShellWindow $mainWindow)) {
      return [pscustomobject]@{ ProcessId = $mainWindow.ProcessId }
    }

    Start-Sleep -Milliseconds 300
  }
  throw "Desktop shell did not open within $StartupTimeoutSeconds seconds."
}

$LaunchMutex = [System.Threading.Mutex]::new($false, $LaunchMutexName)
if (!$LaunchMutex.WaitOne(0)) {
  $LaunchMutex.Dispose()
  Write-Host "PromptCard Manager Dev Shell launch is already in progress."
  exit 0
}

Push-Location $RepoRoot
try {
  if (!(Test-Path -LiteralPath "node_modules")) {
    Write-Host "Installing frontend dependencies..."
    npm.cmd install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  if ($NoLaunch) {
    Write-Host "Desktop shell launch check passed."
    exit 0
  }

  $existingWindow = Get-ExistingDesktopShellWindow
  if ($existingWindow -and (Show-DesktopShellWindow $existingWindow)) {
    Write-Host "PromptCard Manager Dev Shell is already running (PID $($existingWindow.ProcessId)); restored the existing window."
    exit 0
  }

  $staleShellProcesses = @(Get-CurrentDesktopShellProcesses)
  if ($staleShellProcesses.Count -gt 0) {
    Stop-StaleDesktopShellProcesses $staleShellProcesses
  }

  Write-Host "[1/3] Preparing local runtime..."
  $env:PROMPTCARD_DEV_RUNTIME_MANIFEST = $RuntimeManifestPath
  $runtime = Get-OrCreateDevRuntime
  Set-PromptCardDevRuntimeEnvironment $runtime
  $env:PROMPTCARD_REUSE_DEV_RUNTIME = "1"
  $env:PROMPTCARD_DESKTOP_DEV = "1"

  Write-Host "[2/3] Starting or reusing local services in the background..."
  $servicesOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $StartDevWithAgentScript -ServicesOnly 2>&1
  $servicesExitCode = $LASTEXITCODE
  $servicesOutput | Set-Content -LiteralPath $DesktopServicesOutLog -Encoding UTF8
  if ($servicesExitCode -ne 0) {
    throw "Local services failed to start with exit code $servicesExitCode. See $DesktopServicesOutLog."
  }

  if (!(Test-PromptCardFrontend $runtime.frontendUrl)) {
    Write-Host "Starting Vite frontend at $($runtime.frontendUrl)..."
    Start-HiddenLoggedCommand `
      -Command "npm.cmd run dev" `
      -StdoutPath $ViteFrontendOutLog `
      -StderrPath $ViteFrontendErrLog
  }

  $runtime = Wait-DevRuntimeHealthy
  Set-PromptCardDevRuntimeEnvironment $runtime
  Write-Host "Frontend: $($runtime.frontendUrl)"

  $frontendUri = [System.Uri]$runtime.frontendUrl
  if ($frontendUri.Port -eq 3000 -and (Test-DesktopShellCurrent)) {
    Write-Host "[3/3] Starting current desktop shell directly..."
    $process = Start-DesktopShellExecutable
    Write-Host "PromptCard Manager Dev Shell opened (PID $($process.Id))."
    exit 0
  }

  Write-Host "[3/3] Desktop shell requires rebuild; starting tauri dev..."
  Write-Host "The launcher will remain visible until the application window opens."
  $devConfigPath = Write-TauriDevRuntimeConfig $runtime
  $startedAfter = Get-Date
  Start-HiddenLoggedCommand `
    -Command "npm.cmd run tauri:dev -- --config `"$devConfigPath`"" `
    -StdoutPath $TauriDevOutLog `
    -StderrPath $TauriDevErrLog
  $process = Wait-DesktopShellProcess $startedAfter
  Write-DesktopShellBuildStamp
  Write-Host "PromptCard Manager Dev Shell opened (PID $($process.ProcessId))."
}
finally {
  Pop-Location
  $LaunchMutex.ReleaseMutex() | Out-Null
  $LaunchMutex.Dispose()
}
