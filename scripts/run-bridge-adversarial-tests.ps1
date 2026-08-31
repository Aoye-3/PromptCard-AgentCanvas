$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $repoRoot 'agent-runtime\backend\.venv\Scripts\python.exe'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$npx = (Get-Command npx.cmd -ErrorAction Stop).Source
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$e2eRunner = Join-Path $repoRoot 'scripts\run-e2e-tests.ps1'

$requiredFiles = @($python, $e2eRunner)
foreach ($requiredFile in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    [Console]::Error.WriteLine("Required Bridge adversarial dependency was not found: $requiredFile")
    exit 1
  }
}

function Invoke-Gate {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentValues
  )

  Write-Host "Running Bridge adversarial gate: $Name"
  & $FilePath @ArgumentValues
  if ($LASTEXITCODE -ne 0) {
    throw "Bridge adversarial gate '$Name' failed with exit code $LASTEXITCODE."
  }
}

Push-Location $repoRoot
try {
  Invoke-Gate 'v1-v3 contracts' $npm @('run', 'test:contracts')
  Invoke-Gate 'deterministic Bridge CLI' $npm @('run', 'test:bridge-cli')
  Invoke-Gate 'STDIO and loopback HTTP MCP' $npm @('run', 'test:mcp')
  Invoke-Gate 'MCP-absent Canvas, Agent, and startup workflows' $npx @(
    'vitest', 'run',
    'src/domain/free-canvas/free-canvas-project.test.ts',
    'src/services/agent-runtime-service.test.ts',
    'src/domain/bridge/agent-work-environment.test.ts',
    'scripts/app-startup.test.ts'
  )
  Invoke-Gate 'Storage authority, Skill, CVC, and delivery boundaries' $python @(
    '-m', 'pytest',
    'promptcard_storage/tests/test_bridge_delivery_ledger_v19.py',
    'promptcard_storage/tests/test_bridge_document_delivery_v19.py',
    'promptcard_storage/tests/test_bridge_storyboard_delivery_v19.py',
    'promptcard_storage/tests/test_bridge_prompt_delivery_v19.py',
    'promptcard_storage/tests/test_bridge_image_delivery_v19.py',
    'promptcard_storage/tests/test_context_packs_v11.py',
    'promptcard_storage/tests/test_skill_management_v15.py',
    'promptcard_storage/tests/test_skill_hosts_v14.py',
    '-q', '-p', 'no:cacheprovider', '--basetemp=.test-tmp/task27-storage'
  )
  Invoke-Gate 'Gateway profile, retrieval, Skill, and redaction boundaries' $python @(
    '-m', 'pytest',
    'agent-runtime/backend/tests/test_bridge_gateway.py',
    'agent-runtime/backend/tests/test_bridge_environment.py',
    'agent-runtime/backend/tests/test_skill_snapshot_resolver.py',
    '-q', '-p', 'no:cacheprovider', '--basetemp=.test-tmp/task27-gateway'
  )
  Invoke-Gate 'real Gateway cross-project and revoked-context attacks' $powershell @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $e2eRunner,
    '--real-gateway', 'tests/e2e/bridge-adversarial-boundaries.spec.ts', '--workers=1'
  )
}
finally {
  Pop-Location
}

Write-Host 'All Bridge adversarial gates passed.'
