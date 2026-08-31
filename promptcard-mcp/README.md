# PromptCard MCP Adapter

This optional adapter publishes the Local Agent Bridge as ten closed-schema MCP Tools. Both STDIO and loopback Streamable HTTP call the same Gateway client; neither transport reads PromptCard Storage, project JSON, provider credentials, or arbitrary paths directly.

Use the maintained [Local Agent Bridge operations guide](../docs/operations/local-agent-bridge.md) for profile setup, Codex registration, diagnostics, scope upgrades, failure isolation, and removal. The locked launcher is `scripts/start-promptcard-mcp.ps1`; it validates existing dependencies and never installs or downloads anything at launch.

## Repository checks

```text
npm.cmd run test:bridge-package
npm.cmd run mcp:check
npm.cmd run test:mcp
```

Codex is the verified real host for this release. The TRAE file under `config/promptcard-bridge/` is a contract candidate only and is not a compatibility claim.
