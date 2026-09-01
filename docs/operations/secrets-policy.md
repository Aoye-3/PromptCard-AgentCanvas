# Secrets Policy

Never commit, paste, log, screenshot, or document a real credential.

## PromptCard Model Credentials

PromptCard model credentials are stored only through Python `keyring` in the operating-system credential backend:

- service: `dev.promptcard.manager.shell`
- username: `connection:<connectionId>`

`$PROMPTCARD_RUNTIME_STATE_DIR/promptcard-model-connections.json` stores only provider/model metadata and `credentialRef`. Project JSON, PromptCard SQLite, Recent Captures, generation history, browser storage, logs, API responses, and generated assets must never contain credential values.

Connection create/update requests may carry a user-entered credential to Agent Runtime. The backend writes it to keyring and returns only `credentialConfigured` plus a display mask. Omitting the credential during update preserves it; an empty value removes it. If keyring is unavailable or read-back verification fails, the operation fails without a plaintext fallback.

The Runtime must start and report health without any model credential. A valid invocation that needs an unconfigured connection returns `credential_missing`; an unavailable keyring returns `credential_store_unavailable`.

## Platform Requirements

- Windows: run PromptCard and Agent Runtime as the same interactive user that owns the Windows credential entry.
- macOS: use the same user Keychain context.
- Linux: use an unlocked Secret Service or KWallet backend. Headless deployments must provision a supported secure backend explicitly.

Run `npm.cmd run agent:check` before enabling image generation. It verifies keyring and the pinned Volcengine Ark SDK using the repository-local environment on the repository's existing drive.

## Migration And Prohibited Sources

The legacy DeepSeek config migration writes any existing `apiKey` to keyring, reads it back, writes the new connection/assignment state, and only then removes the plaintext field. Failure restores the previous file and keyring state.

Maintained PromptCard launchers must not depend on or read provider credentials from:

- `API-Key.txt`;
- `DEEPSEEK_API_KEY` or `ARK_API_KEY`;
- `.env` files;
- localStorage, IndexedDB, or project metadata.

Environment variables used by unrelated third-party harness integrations are outside the PromptCard model-connection contract and must not be repurposed by new PromptCard UI features.

## Logging And Errors

Never log authorization headers, raw provider exceptions, keyring values, provider temporary URL query strings, or request bodies containing credentials. Public errors use normalized codes and safe messages. Image-generation responses contain only local run, asset, and Recent Capture identifiers.

Test fixtures must use unmistakably fake values and must assert that those values are absent from responses, persisted files, traceback chains, and logs.

If a real credential is exposed, stop using it, rotate/revoke it at the provider, remove it from every local artifact, and audit Git history and runtime logs before continuing.
