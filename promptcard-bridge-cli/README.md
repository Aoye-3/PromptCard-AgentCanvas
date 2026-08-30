# PromptCard Bridge CLI

Repository-owned deterministic JSON client for the Local Agent Bridge. It calls Gateway only; it never opens SQLite, project JSON, asset directories, or arbitrary paths.

Required environment:

- `PROMPTCARD_BRIDGE_URL`: loopback HTTP origin such as `http://127.0.0.1:8000`;
- `PROMPTCARD_BRIDGE_TOKEN`: high-entropy credential for one trusted Bridge profile.

Commands:

```text
npm.cmd run bridge:cli -- runtime
npm.cmd run bridge:cli -- workspace --project PRJ-... --context CVC-...
npm.cmd run bridge:cli -- resolve --context CVC-... --code CVD-...
npm.cmd run bridge:cli -- skill --skill SKL-... --revision 3 --digest sha256:...
```

Stdout contains exactly one deterministic JSON value. Diagnostics go to stderr. Exit codes are `0` success, `2` usage/configuration, `3` authentication/permission, `4` lifecycle/reference conflict, `5` offline, and `6` invalid/unexpected remote response.
