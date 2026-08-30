$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BackendRoot = Join-Path $RepoRoot "agent-runtime\backend"
$RuntimePython = Join-Path $BackendRoot ".venv\Scripts\python.exe"
$RuntimeEnvironment = [System.IO.Path]::GetFullPath((Join-Path $BackendRoot ".venv"))
$env:UV_CACHE_DIR = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot ".uv-cache"))
$env:UV_PYTHON_INSTALL_DIR = [System.IO.Path]::GetFullPath((Join-Path $BackendRoot ".python"))
$env:UV_PROJECT_ENVIRONMENT = $RuntimeEnvironment
$env:UV_LINK_MODE = "copy"

if (!(Test-Path -LiteralPath $RuntimePython)) {
  $RepairCommand = "`$env:UV_CACHE_DIR='$env:UV_CACHE_DIR'; `$env:UV_PYTHON_INSTALL_DIR='$env:UV_PYTHON_INSTALL_DIR'; `$env:UV_PROJECT_ENVIRONMENT='$RuntimeEnvironment'; uv sync --project '$BackendRoot'"
  throw "PromptCard runtime environment is missing. Repair it with: $RepairCommand"
}

Push-Location $BackendRoot
try {
  & $RuntimePython -c "import sys; sys.path.insert(0, r'$RepoRoot'); import keyring; from volcenginesdkarkruntime import Ark; from app.gateway.app import app; from app.gateway.model_management.catalog import MODELS; from promptcard_storage.store import SCHEMA_VERSION; agent_chat_catalog = [model for model in MODELS if model.get('modality') == 'chat']; assert SCHEMA_VERSION == 17; assert agent_chat_catalog; assert all(model.get('providerId') and model.get('id') for model in agent_chat_catalog); print({'promptcard_runtime': True, 'ark_sdk': True, 'storage_schema': SCHEMA_VERSION, 'agent_chat_catalog': len(agent_chat_catalog), 'model_credentials': 'configured at invocation'})"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  Pop-Location
}

npm.cmd run text-agent:check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
