param(
  [switch]$RealCodex
)

$ErrorActionPreference = 'Stop'

$runner = (Resolve-Path (Join-Path $PSScriptRoot 'run-e2e-tests.ps1')).Path
$spec = if ($RealCodex) {
  'tests/e2e/real-codex-total-loop.spec.ts'
}
else {
  'tests/e2e/bridge-document-delivery.spec.ts'
}
$acceptanceMode = if ($RealCodex) { '--real-codex' } else { '--real-gateway' }
$acceptanceName = if ($RealCodex) { 'Real Codex' } else { 'Bridge' }
$previousPhase = $env:PROMPTCARD_E2E_BRIDGE_PHASE
$exitCode = 1

try {
  foreach ($phase in @('prepare', 'recover')) {
    Write-Host "Running $acceptanceName restart acceptance phase: $phase"
    $env:PROMPTCARD_E2E_BRIDGE_PHASE = $phase
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner $acceptanceMode $spec --workers=1
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
