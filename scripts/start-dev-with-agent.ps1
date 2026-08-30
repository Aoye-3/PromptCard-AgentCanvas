param(
  [string]$StorageHealthUrl = "",
  [string]$AgentHealthUrl = "",
  [string]$TextAgentHealthUrl = "",
  [string]$FrontendUrl = "",
  [int]$HealthTimeoutSeconds = 30,
  [string]$FrontendCommand = "npm.cmd run dev",
  [string]$RuntimeManifestPath = "",
  [switch]$ServicesOnly
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$AgentScript = Join-Path $RepoRoot "scripts\start-agent-runtime.ps1"
$TextAgentScript = Join-Path $RepoRoot "scripts\start-text-agent-runtime.ps1"
$StorageScript = Join-Path $RepoRoot "scripts\start-storage-service.ps1"
$LogsDir = if ($env:PROMPTCARD_LOGS_DIR) { $env:PROMPTCARD_LOGS_DIR } else { Join-Path $RepoRoot "logs" }
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
$StorageServiceOutLog = Join-Path $LogsDir "storage-service.out.log"
$StorageServiceErrLog = Join-Path $LogsDir "storage-service.err.log"
$AgentRuntimeOutLog = Join-Path $LogsDir "agent-runtime.out.log"
$AgentRuntimeErrLog = Join-Path $LogsDir "agent-runtime.err.log"
$TextAgentRuntimeOutLog = Join-Path $LogsDir "text-agent-runtime.out.log"
$TextAgentRuntimeErrLog = Join-Path $LogsDir "text-agent-runtime.err.log"
. (Join-Path $PSScriptRoot "dev-port-runtime.ps1")

if (!$RuntimeManifestPath) {
  $RuntimeManifestPath = if ($env:PROMPTCARD_DEV_RUNTIME_MANIFEST) { $env:PROMPTCARD_DEV_RUNTIME_MANIFEST } else { Join-Path $LogsDir "dev-runtime.json" }
}
$env:PROMPTCARD_DEV_RUNTIME_MANIFEST = $RuntimeManifestPath
$HadRuntimeManifestBeforeStart = Test-Path -LiteralPath $RuntimeManifestPath
$PreviousRuntimeManifestText = if ($HadRuntimeManifestBeforeStart) { Get-Content -LiteralPath $RuntimeManifestPath -Raw } else { $null }

function Restore-RuntimeManifestAfterFailedStart {
  try {
    if ($HadRuntimeManifestBeforeStart) {
      [System.IO.File]::WriteAllText($RuntimeManifestPath, $PreviousRuntimeManifestText, [System.Text.UTF8Encoding]::new($false))
    }
    elseif (Test-Path -LiteralPath $RuntimeManifestPath) {
      Remove-Item -LiteralPath $RuntimeManifestPath -Force
    }
  }
  catch {
    Write-Host "Failed to restore previous runtime manifest: $($_.Exception.Message)"
  }
}

trap {
  Restore-RuntimeManifestAfterFailedStart
  break
}

$Runtime = $null
if ($env:PROMPTCARD_REUSE_DEV_RUNTIME -eq "1") {
  $Runtime = Read-PromptCardDevRuntime $RuntimeManifestPath
}
if (!$Runtime) {
  $Runtime = New-PromptCardDevRuntime `
    -RepoRoot $RepoRoot `
    -ManifestPath $RuntimeManifestPath `
    -FrontendUrlOverride $FrontendUrl `
    -AgentHealthUrlOverride $AgentHealthUrl `
    -TextAgentHealthUrlOverride $TextAgentHealthUrl `
    -StorageHealthUrlOverride $StorageHealthUrl
}
Set-PromptCardDevRuntimeEnvironment $Runtime
if (!$env:PROMPTCARD_INTERNAL_TOKEN) {
  $tokenBytes = New-Object byte[] 32
  $tokenGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $tokenGenerator.GetBytes($tokenBytes)
  }
  finally {
    $tokenGenerator.Dispose()
  }
  $env:PROMPTCARD_INTERNAL_TOKEN = [Convert]::ToBase64String($tokenBytes)
}
if (!$env:PROMPTCARD_IMAGE_GENERATION_NODE_V1) {
  $env:PROMPTCARD_IMAGE_GENERATION_NODE_V1 = "1"
}
$ExpectedStorageSchemaVersion = 17

$StorageHealthUrl = $Runtime.storageHealthUrl
$AgentHealthUrl = $Runtime.agentHealthUrl
$TextAgentHealthUrl = $Runtime.textAgentHealthUrl
$FrontendUrl = $Runtime.frontendUrl

function Test-HttpOk($Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 2
    return $response.StatusCode -eq 200
  }
  catch {
    return $false
  }
}

function Test-StorageService {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $StorageHealthUrl -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $false }
    $payload = $response.Content | ConvertFrom-Json
    if (
      $payload.serviceVersion -ne "2.0.0" -or
      $payload.schemaVersion -ne $ExpectedStorageSchemaVersion -or
      !$payload.capabilities.sqlite -or
      !$payload.capabilities.projectResources
    ) {
      Write-Host "PromptCard storage service is running an incompatible storage version (schema $($payload.schemaVersion); expected $ExpectedStorageSchemaVersion)."
      return $false
    }
    if (!$env:PROMPTCARD_STORAGE_DATA_DIR) { return $true }
    if (!$payload.storage) { return $false }
    $expected = [System.IO.Path]::GetFullPath($env:PROMPTCARD_STORAGE_DATA_DIR).TrimEnd('\')
    $actual = [System.IO.Path]::GetFullPath([string]$payload.storage).TrimEnd('\')
    if ($expected -ne $actual) {
      Write-Host "PromptCard storage service is healthy but uses $actual; expected $expected"
      return $false
    }
    return $true
  }
  catch {
    return $false
  }
}

function Test-AgentRuntime {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $AgentHealthUrl -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $false }
    if (!$env:PROMPTCARD_RUNTIME_STATE_DIR) { return $true }

    $payload = $response.Content | ConvertFrom-Json
    if (!$payload.runtimeStateDir) { return $false }
    $expected = [System.IO.Path]::GetFullPath($env:PROMPTCARD_RUNTIME_STATE_DIR).TrimEnd('\')
    $actual = [System.IO.Path]::GetFullPath([string]$payload.runtimeStateDir).TrimEnd('\')
    if ($expected -ne $actual) {
      Write-Host "Agent Runtime is healthy but uses $actual; expected $expected"
      return $false
    }
    return $true
  }
  catch {
    return $false
  }
}

function Test-TextAgentRuntime {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $TextAgentHealthUrl -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $false }
    $payload = $response.Content | ConvertFrom-Json
    return $payload.service -eq "promptcard-pi-text-agent" -and $payload.orchestrator -eq "pi"
  }
  catch {
    return $false
  }
}

function Test-Frontend {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $FrontendUrl -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $false }
    if ([string]$response.Content -notmatch '<title>\s*PromptCard-Agent\s*</title>') { return $false }
    $scriptMatch = [regex]::Match($response.Content, '<script[^>]+type=["'']module["''][^>]+src=["'']([^"'']+)["'']')
    if (!$scriptMatch.Success) { return $false }
    $entryUrl = [System.Uri]::new([System.Uri]$FrontendUrl, $scriptMatch.Groups[1].Value).AbsoluteUri
    $entry = Invoke-WebRequest -UseBasicParsing $entryUrl -TimeoutSec 2
    if ($entry.StatusCode -ne 200) { return $false }
    if ($entry.Content -match '/node_modules/(react|react-dom)/(index|client)\.js') {
      Write-Host "Vite frontend is serving unoptimized CommonJS React modules."
      return $false
    }
    return $true
  }
  catch {
    return $false
  }
}

function Wait-UntilHealthy($Name, $Probe) {
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Probe) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name did not become healthy within $HealthTimeoutSeconds seconds."
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
    -WindowStyle Hidden
}

function Stop-StalePromptCardServiceProcesses {
  param([string[]]$CommandLinePatterns)

  $repoRootText = [string]$RepoRoot
  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $matchedProcessIds = @{}

  foreach ($process in $allProcesses) {
    $commandLine = [string]$process.CommandLine
    if (!$commandLine.Contains($repoRootText)) { continue }
    foreach ($pattern in $CommandLinePatterns) {
      if ($commandLine.Contains($pattern)) {
        $matchedProcessIds[[int]$process.ProcessId] = $true
      }
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
    Where-Object {
      $matchedProcessIds.ContainsKey([int]$_.ProcessId)
    } |
    Sort-Object CreationDate -Descending

  foreach ($process in $processes) {
    if ($process.ProcessId -eq $PID) { continue }
    Write-Host "Stopping stale PromptCard service process (PID $($process.ProcessId)): $($process.Name)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    try {
      Wait-Process -Id $process.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
    catch {
      Write-Host "Timed out waiting for stale process $($process.ProcessId) to exit."
    }
  }
}

$StorageReady = Test-StorageService
if (-not $StorageReady) {
  Stop-StalePromptCardServiceProcesses -CommandLinePatterns @("promptcard_storage", "start-storage-service.ps1")
  Start-HiddenLoggedCommand `
    -Command "powershell -NoProfile -ExecutionPolicy Bypass -File `"$StorageScript`"" `
    -StdoutPath $StorageServiceOutLog `
    -StderrPath $StorageServiceErrLog
  Wait-UntilHealthy "PromptCard storage service at $StorageHealthUrl" ${function:Test-StorageService}
}
else {
  Write-Host "PromptCard storage service is already healthy at $StorageHealthUrl"
}

$AgentReady = Test-AgentRuntime
$TextAgentReady = Test-TextAgentRuntime
if (-not $TextAgentReady) {
  Stop-StalePromptCardServiceProcesses -CommandLinePatterns @("text-agent-runtime/src/server.ts", "start-text-agent-runtime.ps1")
  Start-HiddenLoggedCommand `
    -Command "powershell -NoProfile -ExecutionPolicy Bypass -File `"$TextAgentScript`"" `
    -StdoutPath $TextAgentRuntimeOutLog `
    -StderrPath $TextAgentRuntimeErrLog
  Wait-UntilHealthy "pi text Agent at $TextAgentHealthUrl" ${function:Test-TextAgentRuntime}
}
else {
  Write-Host "pi text Agent is already healthy at $TextAgentHealthUrl"
}

if (-not $AgentReady) {
  Stop-StalePromptCardServiceProcesses -CommandLinePatterns @("app.gateway.app", "start-agent-runtime.ps1")
  Start-HiddenLoggedCommand `
    -Command "powershell -NoProfile -ExecutionPolicy Bypass -File `"$AgentScript`"" `
    -StdoutPath $AgentRuntimeOutLog `
    -StderrPath $AgentRuntimeErrLog
  Wait-UntilHealthy "Agent Runtime at $AgentHealthUrl" ${function:Test-AgentRuntime}
}
else {
  Write-Host "Agent Runtime is already healthy at $AgentHealthUrl"
}

if ($ServicesOnly) {
  Write-Host "PromptCard local services are healthy."
  exit 0
}

if (Test-Frontend) {
  Write-Host "Vite frontend is already healthy at $FrontendUrl"
  exit 0
}

Push-Location $RepoRoot
try {
  $global:LASTEXITCODE = $null
  Invoke-Expression $FrontendCommand
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  Pop-Location
}
