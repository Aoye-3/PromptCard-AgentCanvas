param(
  [ValidateSet('stdio', 'http')]
  [string]$Transport = 'stdio',
  [switch]$SkipGateway
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-promptcard-mcp.ps1'
$cli = Join-Path $repoRoot 'promptcard-bridge-cli\src\cli.ts'

function Write-Result {
  param(
    [bool]$Ok,
    [object]$Packaging,
    [object]$Gateway
  )

  [ordered]@{
    ok = $Ok
    packaging = $Packaging
    gateway = $Gateway
  } | ConvertTo-Json -Depth 6 -Compress
}

$launcherOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Transport $Transport -Check 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Result -Ok $false -Packaging ([ordered]@{
    ok = $false
    code = 'promptcard_mcp_packaging_check_failed'
  }) -Gateway ([ordered]@{ checked = $false })
  exit 1
}

try {
  $launcherCheck = $launcherOutput | ConvertFrom-Json
} catch {
  Write-Result -Ok $false -Packaging ([ordered]@{
    ok = $false
    code = 'promptcard_mcp_packaging_output_invalid'
  }) -Gateway ([ordered]@{ checked = $false })
  exit 1
}

$packaging = [ordered]@{
  ok = [bool]$launcherCheck.ok
  transport = $launcherCheck.transport
  nodeVersion = $launcherCheck.nodeVersion
  bridgeOrigin = $launcherCheck.bridgeOrigin
  credentialConfigured = [bool]$launcherCheck.credentialConfigured
  workspaceRootConfigured = [bool]$launcherCheck.workspaceRootConfigured
  httpCredentialConfigured = [bool]$launcherCheck.httpCredentialConfigured
  downloadsAtLaunch = [bool]$launcherCheck.downloadsAtLaunch
}

if ($SkipGateway) {
  Write-Result -Ok $true -Packaging $packaging -Gateway ([ordered]@{ checked = $false })
  exit 0
}

$gatewayOutput = & node --experimental-strip-types $cli runtime 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Result -Ok $false -Packaging $packaging -Gateway ([ordered]@{
    checked = $true
    ok = $false
    code = 'promptcard_bridge_gateway_unreachable_or_rejected'
  })
  exit 1
}

try {
  $null = $gatewayOutput | ConvertFrom-Json
} catch {
  Write-Result -Ok $false -Packaging $packaging -Gateway ([ordered]@{
    checked = $true
    ok = $false
    code = 'promptcard_bridge_gateway_response_invalid'
  })
  exit 1
}

Write-Result -Ok $true -Packaging $packaging -Gateway ([ordered]@{
  checked = $true
  ok = $true
  state = 'reachable'
})
