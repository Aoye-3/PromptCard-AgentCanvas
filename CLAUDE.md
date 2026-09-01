# CLAUDE.md

Repository-wide development guidance is supplied by [AGENTS.md](./AGENTS.md). The following rules cover PromptCard model management and image generation.

## Secure model runtime

- The Gateway must start and remain healthy with no model credentials configured. Missing credentials are reported only when a model call is requested, using `credential_missing`.
- Never restore plaintext key-file bootstrapping, `sk-` extraction, provider-key environment injection, browser credential persistence, or secret-bearing logs.
- Provider credentials belong in the operating-system keyring. Durable connection files contain metadata and `credentialRef` only.
- All Python environments, dependency installs, caches, test output, and repair commands stay inside the current repository on its existing drive. Resolve the repository root dynamically and validate containment; never encode the current drive letter or absolute checkout path in committed code. Use `npm.cmd run agent:check` for keyring and Ark SDK diagnostics.

## Image-generation compatibility

- UI nodes bind the provider-neutral pair `connectionId + modelId`; keep vendor request details behind provider adapters.
- PromptCard Storage schema v3 introduced append-only generation runs and generated assets; the current schema is v19. Do not roll the active database back below its current schema or delete history when projects/nodes are removed.
- A rollout may hide the image-node entry with `imageGenerationNodeV1`; disabling the entry must preserve catalog, model connections, history, and assets.
- Update [the architecture guide](./docs/architecture/image-generation-and-model-management.md) whenever capability limits, provider adapters, migration, storage, or rollback behavior changes.

## Verification

```powershell
npm.cmd test -- --run --dir scripts start-dev-with-agent.test.ts app-startup.test.ts
npm.cmd run agent:check
```
