$ErrorActionPreference = 'Stop'

$runner = (Resolve-Path (Join-Path $PSScriptRoot 'run-e2e-tests.ps1')).Path
$spec = 'tests/e2e/bridge-document-delivery.spec.ts'
$previousPhase = $env:PROMPTCARD_E2E_BRIDGE_PHASE
$exitCode = 1

try {
  foreach ($phase in @('prepare', 'recover')) {
    Write-Host "Running Bridge restart acceptance phase: $phase"
    $env:PROMPTCARD_E2E_BRIDGE_PHASE = $phase
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner --real-gateway $spec --workers=1
    if ($LASTEXITCODE -ne 0) {
      $exitCode = $LASTEXITCODE
      break
    }
    $exitCode = 0
  }
}
finally {
  if ($null -eq $previousPhase) {
    Remove-Item Env:PROMPTCARD_E2E_BRIDGE_PHASE -ErrorAction SilentlyContinue
  }
  else {
    $env:PROMPTCARD_E2E_BRIDGE_PHASE = $previousPhase
  }
}

exit $exitCode
