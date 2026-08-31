$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backendRoot = Join-Path $repoRoot 'agent-runtime\backend'
$python = Join-Path $backendRoot '.venv\Scripts\python.exe'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$viteCli = Join-Path $repoRoot 'node_modules\vite\bin\vite.js'
$playwrightCli = Join-Path $repoRoot 'node_modules\@playwright\test\cli.js'
$runtimeFixture = Join-Path $repoRoot 'tests\fixtures\image_generation_runtime.py'
$storageDataDir = Join-Path $repoRoot 'tests\.runtime\image-generation-storage'
$realCodexRepositoryRoot = Join-Path $repoRoot 'tests\.runtime\real-codex-repository'
$serviceLogRoot = Join-Path $repoRoot '.tmp\e2e-services'
$timeoutSeconds = 600
$ownedProcesses = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$exitCode = 1
$playwrightArgs = @($args)
$useRealCodex = $playwrightArgs -contains '--real-codex'
$useRealGateway = ($playwrightArgs -contains '--real-gateway') -or $useRealCodex
$playwrightArgs = @($playwrightArgs | Where-Object { $_ -notin @('--real-gateway', '--real-codex') })
if ($useRealCodex) {
  $timeoutSeconds = 1800
}

if ($env:PROMPTCARD_E2E_RUNNER_TIMEOUT_SECONDS) {
  $parsedTimeout = 0
  if (-not [int]::TryParse($env:PROMPTCARD_E2E_RUNNER_TIMEOUT_SECONDS, [ref]$parsedTimeout) -or $parsedTimeout -lt 1) {
    [Console]::Error.WriteLine('PROMPTCARD_E2E_RUNNER_TIMEOUT_SECONDS must be a positive integer.')
    exit 2
  }
  $timeoutSeconds = $parsedTimeout
}

$requiredFiles = @($python, $viteCli, $playwrightCli)
if (-not $useRealGateway) {
  $requiredFiles += $runtimeFixture
}
foreach ($requiredFile in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    [Console]::Error.WriteLine("Required E2E executable was not found: $requiredFile")
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $serviceLogRoot | Out-Null
New-Item -ItemType Directory -Force -Path $storageDataDir | Out-Null
if ($useRealCodex) {
  New-Item -ItemType Directory -Force -Path $realCodexRepositoryRoot | Out-Null
}

function ConvertTo-ProcessArgument {
  param([AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  $quoted = New-Object System.Text.StringBuilder
  [void]$quoted.Append('"')
  $backslashCount = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashCount += 1
      continue
    }
    if ($character -eq '"') {
      [void]$quoted.Append(('\' * (($backslashCount * 2) + 1)))
      [void]$quoted.Append('"')
      $backslashCount = 0
      continue
    }
    if ($backslashCount -gt 0) {
      [void]$quoted.Append(('\' * $backslashCount))
      $backslashCount = 0
    }
    [void]$quoted.Append($character)
  }
  if ($backslashCount -gt 0) {
    [void]$quoted.Append(('\' * ($backslashCount * 2)))
  }
  [void]$quoted.Append('"')
  return $quoted.ToString()
}

function Assert-PortsAvailable {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 38100,38101,38102 -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    $occupied = ($listeners | ForEach-Object { "$($_.LocalPort) (PID $($_.OwningProcess))" }) -join ', '
    throw "E2E service ports are already in use: $occupied"
  }
}

function Start-OwnedService {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentValues
  )

  $argumentLine = (($ArgumentValues | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join ' ')
  $stdoutPath = Join-Path $serviceLogRoot "$Name.stdout.log"
  $stderrPath = Join-Path $serviceLogRoot "$Name.stderr.log"
  $process = Start-Process -FilePath $FilePath -ArgumentList $argumentLine -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  $ownedProcesses.Add($process)
  return $process
}

function Wait-ForHealth {
  param(
    [string]$Name,
    [System.Diagnostics.Process]$Process,
    [string]$Url,
    [int]$TimeoutSeconds = 120
  )

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    if ($Process.HasExited) {
      throw "$Name exited before becoming healthy with code $($Process.ExitCode)."
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
        return
      }
    }
    catch {
      Start-Sleep -Milliseconds 250
    }
  }
  throw "$Name did not become healthy within $TimeoutSeconds seconds."
}

function Stop-ProcessTree {
  param([System.Diagnostics.Process]$Process)

  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  $taskkillProcess = Start-Process -FilePath $taskkill -ArgumentList @('/PID', $Process.Id, '/T', '/F') -WindowStyle Hidden -PassThru -Wait
  if ($taskkillProcess.ExitCode -ne 0 -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
  $taskkillProcess.Dispose()
}

function Wait-ForPortsReleased {
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($stopwatch.Elapsed.TotalSeconds -lt 10) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 38100,38101,38102 -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
      return $true
    }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

try {
  Assert-PortsAvailable

  $env:PYTHONPATH = "$repoRoot;$backendRoot"
  $env:PROMPTCARD_STORAGE_DATA_DIR = $storageDataDir
  $env:PROMPTCARD_STORAGE_PORT = '38102'
  $env:PROMPTCARD_STORAGE_URL = 'http://127.0.0.1:38102'
  $env:PROMPTCARD_AGENT_URL = 'http://127.0.0.1:38101'
  $env:PROMPTCARD_DESKTOP_DEV = '1'
  $env:PORT = '38101'

  if ($useRealCodex) {
    $env:PROMPTCARD_REAL_CODEX_ACCEPTANCE = '1'
    $env:PROMPTCARD_REPOSITORY_SCOPE = 'real-codex-e2e'
    $env:PROMPTCARD_REPOSITORY_ROOT = $realCodexRepositoryRoot
  }

  if ($useRealGateway) {
    $env:PROMPTCARD_INTERNAL_TOKEN = 'promptcard-e2e-internal-token-38101'
    $env:PROMPTCARD_E2E_BRIDGE_TOKEN = 'promptcard-e2e-bridge-token-38101'
    $env:GATEWAY_CORS_ORIGINS = 'http://127.0.0.1:38100,http://localhost:38100'
    $bridgeProfile = @{
      token = $env:PROMPTCARD_E2E_BRIDGE_TOKEN
      scopes = @(
        'bridge:read',
        'bridge:deliver:document',
        'bridge:deliver:storyboard',
        'bridge:deliver:prompt',
        'bridge:deliver:image',
        'bridge:status'
      )
      clientInfo = @{ name = 'codex'; version = 'e2e' }
    }
    if ($useRealCodex) {
      $bridgeProfile.repositoryScope = $env:PROMPTCARD_REPOSITORY_SCOPE
    }
    $env:PROMPTCARD_BRIDGE_PROFILES_JSON = (@{
      'codex-e2e' = $bridgeProfile
    } | ConvertTo-Json -Compress -Depth 5)
    if ($useRealCodex) {
      $env:PROMPTCARD_BRIDGE_URL = 'http://127.0.0.1:38101'
      $env:PROMPTCARD_BRIDGE_TOKEN = $env:PROMPTCARD_E2E_BRIDGE_TOKEN
      $env:PROMPTCARD_BRIDGE_WORKSPACE_ROOT = $repoRoot
    }
  }

  Write-Host 'Starting E2E storage service...'
  $storage = Start-OwnedService -Name 'storage' -FilePath $python -ArgumentValues @('-m', 'promptcard_storage')
  Wait-ForHealth -Name 'Storage service' -Process $storage -Url 'http://127.0.0.1:38102/health'

  if ($useRealGateway) {
    Write-Host 'Starting E2E real Gateway...'
    $runtime = Start-OwnedService -Name 'gateway' -FilePath $python -ArgumentValues @(
      '-m', 'uvicorn', 'app.gateway.app:app', '--host', '127.0.0.1', '--port', '38101'
    )
    Wait-ForHealth -Name 'Real Gateway' -Process $runtime -Url 'http://127.0.0.1:38101/health'
  }
  else {
    Write-Host 'Starting E2E Fake Runtime...'
    $runtime = Start-OwnedService -Name 'runtime' -FilePath $python -ArgumentValues @($runtimeFixture)
    Wait-ForHealth -Name 'Fake Runtime' -Process $runtime -Url 'http://127.0.0.1:38101/health'
  }

  Write-Host 'Starting E2E Vite frontend...'
  $frontend = Start-OwnedService -Name 'frontend' -FilePath $node -ArgumentValues @($viteCli, '--host', '127.0.0.1', '--port', '38100', '--strictPort')
  Wait-ForHealth -Name 'Vite frontend' -Process $frontend -Url 'http://127.0.0.1:38100'

  Write-Host 'E2E services are healthy. Starting Playwright...'
  $env:PROMPTCARD_E2E_EXTERNAL_SERVICES = '1'
  $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $repoRoot '.playwright-browsers'
  $playwrightArguments = @($playwrightCli, 'test') + $playwrightArgs
  $playwrightArgumentLine = (($playwrightArguments | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join ' ')
  $playwright = Start-Process -FilePath $node -ArgumentList $playwrightArgumentLine -WorkingDirectory $repoRoot -NoNewWindow -PassThru
  $null = $playwright.Handle

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while (-not $playwright.HasExited -and $stopwatch.Elapsed.TotalSeconds -lt $timeoutSeconds) {
    Start-Sleep -Milliseconds 200
    $playwright.Refresh()
  }

  if ($playwright.HasExited) {
    $playwright.WaitForExit()
    $exitCode = $playwright.ExitCode
    Write-Host "Playwright exited with code $exitCode."
  }
  else {
    Stop-ProcessTree -Process $playwright
    [Console]::Error.WriteLine("Playwright exceeded the runner timeout of $timeoutSeconds seconds.")
    $exitCode = 124
  }
  $playwright.Dispose()
}
catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $exitCode = 1
}
finally {
  Write-Host 'Stopping owned E2E services...'
  for ($index = $ownedProcesses.Count - 1; $index -ge 0; $index -= 1) {
    $ownedProcess = $ownedProcesses[$index]
    Stop-ProcessTree -Process $ownedProcess
    $ownedProcess.Dispose()
  }

  if (-not (Wait-ForPortsReleased)) {
    [Console]::Error.WriteLine('E2E service ports 38100-38102 were not released after cleanup.')
    if ($exitCode -eq 0) {
      $exitCode = 1
    }
  }
}

Write-Host "E2E runner exiting with code $exitCode."
exit $exitCode
