param(
  [ValidateSet('stdio', 'http')]
  [string]$Transport = 'stdio',

  [string]$BridgeUrl = $env:PROMPTCARD_BRIDGE_URL,

  [string]$BridgeToken = $env:PROMPTCARD_BRIDGE_TOKEN,

  [string]$WorkspaceRoot = $env:PROMPTCARD_BRIDGE_WORKSPACE_ROOT,

  [string]$HttpToken = $env:PROMPTCARD_MCP_HTTP_TOKEN,

  [ValidateRange(1, 65535)]
  [int]$Port = $(if ($env:PROMPTCARD_MCP_PORT) { [int]$env:PROMPTCARD_MCP_PORT } else { 8142 }),

  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source

function Stop-Safely {
  param([string]$Code)

  [Console]::Error.WriteLine($Code)
  exit 2
}

if (-not $node) {
  Stop-Safely 'promptcard_mcp_node_missing'
}

$nodeVersion = (& $node -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
  Stop-Safely 'promptcard_mcp_node_version_invalid'
}
$major = [int]$Matches[1]
$minor = [int]$Matches[2]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 6)) {
  Stop-Safely 'promptcard_mcp_node_version_unsupported'
}

$entrypoint = Join-Path $repoRoot $(
  if ($Transport -eq 'stdio') { 'promptcard-mcp\src\stdio.ts' }
  else { 'promptcard-mcp\src\http-entry.ts' }
)
$serverPackage = Join-Path $repoRoot 'node_modules\@modelcontextprotocol\server\package.json'
foreach ($requiredFile in @($entrypoint, $serverPackage)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    Stop-Safely 'promptcard_mcp_dependencies_missing_run_npm_ci_once'
  }
}

$parsedBridgeUri = $null
if (-not [Uri]::TryCreate($BridgeUrl, [UriKind]::Absolute, [ref]$parsedBridgeUri)) {
  Stop-Safely 'promptcard_mcp_bridge_origin_invalid'
}
$bridgeOriginInvalid = (
  ($parsedBridgeUri.Scheme -notin @('http', 'https')) -or
  ($parsedBridgeUri.Host -notin @('127.0.0.1', 'localhost', '::1')) -or
  [bool]$parsedBridgeUri.UserInfo -or
  ($parsedBridgeUri.AbsolutePath -ne '/') -or
  [bool]$parsedBridgeUri.Query -or
  [bool]$parsedBridgeUri.Fragment
)
if ($bridgeOriginInvalid) {
  Stop-Safely 'promptcard_mcp_bridge_origin_must_be_loopback'
}
if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
  Stop-Safely 'promptcard_mcp_bridge_credential_required'
}
if ($Transport -eq 'http' -and [string]::IsNullOrWhiteSpace($HttpToken)) {
  Stop-Safely 'promptcard_mcp_http_credential_required'
}

$resolvedWorkspaceRoot = $null
if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
  try {
    $resolvedWorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot -ErrorAction Stop).Path
  }
  catch {
    Stop-Safely 'promptcard_mcp_workspace_root_invalid'
  }
  if (-not (Test-Path -LiteralPath $resolvedWorkspaceRoot -PathType Container)) {
    Stop-Safely 'promptcard_mcp_workspace_root_invalid'
  }
}

if ($Check) {
  [ordered]@{
    ok = $true
    transport = $Transport
    nodeVersion = $nodeVersion
    bridgeOrigin = $parsedBridgeUri.GetLeftPart([UriPartial]::Authority)
    credentialConfigured = $true
    workspaceRootConfigured = $null -ne $resolvedWorkspaceRoot
    httpCredentialConfigured = $Transport -eq 'http'
    downloadsAtLaunch = $false
  } | ConvertTo-Json -Compress
  exit 0
}

$env:PROMPTCARD_BRIDGE_URL = $parsedBridgeUri.GetLeftPart([UriPartial]::Authority)
$env:PROMPTCARD_BRIDGE_TOKEN = $BridgeToken
if ($null -ne $resolvedWorkspaceRoot) {
  $env:PROMPTCARD_BRIDGE_WORKSPACE_ROOT = $resolvedWorkspaceRoot
}
else {
  Remove-Item Env:PROMPTCARD_BRIDGE_WORKSPACE_ROOT -ErrorAction SilentlyContinue
}
if ($Transport -eq 'http') {
  $env:PROMPTCARD_MCP_HTTP_TOKEN = $HttpToken
  $env:PROMPTCARD_MCP_PORT = [string]$Port
}

& $node --experimental-strip-types $entrypoint
exit $LASTEXITCODE
