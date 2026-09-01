$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RuntimePython = Join-Path $RepoRoot "agent-runtime\backend\.venv\Scripts\python.exe"

if (!(Test-Path -LiteralPath $RuntimePython -PathType Leaf)) {
  throw "PromptCard Storage test environment is missing. Run 'npm.cmd run agent:check' from the repository root first."
}

Push-Location $RepoRoot
try {
  & $RuntimePython -m unittest discover -s promptcard_storage/tests -p "test_*.py"
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
