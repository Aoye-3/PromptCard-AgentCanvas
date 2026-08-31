# PromptCard Bridge configuration templates

These files are inert examples. Replace every placeholder locally and never commit a real Bridge or HTTP token.

- `profiles.read-only.example.json`: least-authority Gateway profile for discovery and exact reads.
- `profiles.full-review.example.json`: opt-in profile for all four review-only delivery kinds plus status.
- `codex-stdio.example.toml`: verified Codex STDIO configuration with only the six read Tools enabled initially.
- `trae-stdio.candidate.json`: unverified contract candidate that uses the same launcher; it is not evidence of TRAE compatibility.

Gateway profiles are supplied through `PROMPTCARD_BRIDGE_PROFILES_JSON`. Host templates may express command and environment fields differently, but they must not rename Tools, change schemas, add scopes, or alter budgets and results. See the [operations guide](../../docs/operations/local-agent-bridge.md).
