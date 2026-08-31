# Agent Runtime API

The maintained frontend contract is the PromptCard Runtime Boundary. In development, Vite proxies:

```text
/agent-api/* -> ${PROMPTCARD_AGENT_URL}/api/*
```

## Local Agent Bridge v3

The external-Agent surface is separate from the browser Runtime boundary and uses `/api/promptcard/bridge/v3/*`. It accepts only `Authorization: Bearer <bridge-token>` backed by `PROMPTCARD_BRIDGE_PROFILES_JSON`; the internal Runtime token and browser session do not authorize it, and a Bridge credential cannot call internal-chat, model-management, or image-generation routes. These Bridge routes are intentionally outside the browser cookie/CSRF boundary because they have no browser session authority: POST without a valid Bridge Bearer profile is rejected, while ordinary authenticated browser mutations still require double-submit CSRF.

Each trusted profile declares fixed scopes and may bind one configured Codex `repositoryScope`. Neither `profileId`, scopes, client identity, nor repository scope is accepted from a Tool request. The current Bridge exposes:

- `GET /api/promptcard/bridge/v3/runtime`
- `GET /api/promptcard/bridge/v3/workspace?projectCode=PRJ-...&cvcCode=CVC-...`
- `GET /api/promptcard/bridge/v3/reference?cvcCode=CVC-...&code=...`
- `GET /api/promptcard/bridge/v3/skill?skillCode=SKL-...&revision=...&digest=sha256:...`
- `POST /api/promptcard/bridge/v3/prompt-search`
- `GET /api/promptcard/bridge/v3/asset?cvcCode=CVC-...&code=PLM-...|CVM-...`
- `POST /api/promptcard/bridge/v3/assets/stage`
- `POST /api/promptcard/bridge/v3/delivery/preview`
- `POST /api/promptcard/bridge/v3/delivery/commit`
- `GET /api/promptcard/bridge/v3/delivery/status?clientRequestId=...`

`runtime` returns Bootstrap v5 with its executable `instructions`, not merely a name and digest. The guide tells a new host to discover the exact Workspace, stop on stale/revoked context, copy the closed four-field Skill pins, use the six kind-specific target/payload shapes, preview before commit, and stop at visual review. Its Document-change instructions freeze the exact `payload.operations` wrapper and operation fields; its Storyboard instructions freeze the full sequence, nine-field row, and `payload.changes` shapes. `promptcard-bootstrap` is built in and is not an `SKL-*` readable through `skill_read`.

`workspace` requires an explicit project/context pair, rejects a CVC whose project revision is behind the current project as `context_stale`, lists only objects snapshotted into a fresh CVC, and resolves only active, trusted, enabled exact Codex Skill pins in the profile's configured repository scope. `reference` refuses codes outside the CVC. An exact authorized `CVD-*` response adds `documentEditEvidence.blocks`: each bounded entry contains `blockId`, concatenated leaf `text`, `utf8Length`, and the SHA-256 `textDigest`. The Agent copies that digest to `expectedTextDigest` and uses byte offsets, while the authoritative Document AST and revision/digest remain unchanged; malformed or oversized Storage evidence fails closed. `prompt-search` reuses Storage v18 retrieval with the trusted Bridge profile as caller identity. `asset` accepts only a `PLM` or `CVM` explicitly contained by the CVC, limits the body to 5 MiB, validates current lifecycle/MIME/size/reference metadata, and returns filename, MIME, size, SHA-256 and Base64 without an internal asset ID or path. Delivery preview/commit/status use the profile-scoped v19 ledger; Prompt, image, Document, and Storyboard kinds are end-to-end implemented. Gateway accepts the closed v3 `storyboard.create` and `storyboard.change` unions, requires `bridge:deliver:storyboard`, canonicalizes exact CVC/CVD/CVS/source references, validates approved Skill pins, and routes preview/commit only to the protected Storyboard Storage adapter. External row changes remain ordinal-addressed at the contract boundary; internal row IDs are never accepted or returned. A Storyboard CVC projection includes `pendingFieldChanges` as a bounded identity-only list (`scope/field` or `scope/rowOrdinal/field`), omits internal change/edit/row IDs and values, and makes new writes fail closed when the selected field was already pending. Browser parsing preserves this closed shape, creates one native Storyboard with a Storage-owned `CVS-*`, and maps accepted external changes into the existing per-field review UI. Preview/commit/decision/replay and a pending field proposal have been verified across separate Storage/Gateway/browser process lifetimes. Status remains read-only through the shared ledger, and absent optional fields are omitted before forwarding so Gateway payloads remain byte-shape compatible with the closed Storage contracts.

The repository CLI in `promptcard-bridge-cli/` calls only these Gateway routes, including bounded search and exact asset read. It accepts the Bridge origin/token from process environment, refuses non-loopback origins before sending the token, produces one stable JSON value on stdout, sends diagnostics to stderr, and assigns stable exit classes for usage/auth/lifecycle/offline/remote failures. CLI and Gateway success payloads are JSON-equivalent; the CLI does not read Storage or project files.

`promptcard-mcp/` wraps that same client with ten closed-schema Tools: six bounded reads plus delivery preview, delivery commit, delivery status, and image staging. `npm.cmd run mcp:stdio` reserves stdout for JSON-RPC. `npm.cmd run mcp:http` binds only `127.0.0.1` (default port `8142`), serves `/mcp`, validates loopback Host/Origin, and requires a separate `PROMPTCARD_MCP_HTTP_TOKEN`. Both transports support the 2025-11-25 and 2026-07-28 protocol eras from one server factory; no legacy SSE endpoint exists. Preview/commit are idempotent, proposal-only mutations; status is read-only and never repeats a mutation.

Required process environment is intentionally small:

- both transports: `PROMPTCARD_BRIDGE_URL`, `PROMPTCARD_BRIDGE_TOKEN`;
- image staging: `PROMPTCARD_BRIDGE_WORKSPACE_ROOT`, an explicit absolute root whose real path contains every file eligible for staging;
- HTTP only: `PROMPTCARD_MCP_HTTP_TOKEN`, optional `PROMPTCARD_MCP_PORT`;
- platform launch essentials such as `PATH`, `SystemRoot`, `ComSpec`, `TEMP`, and `TMP` may be passed by the host.

The MCP process has no direct SQLite, shell, keyring, arbitrary-filesystem, or general network Tool. Only `promptcard_asset_stage` reads a caller-declared relative path; it resolves both root and candidate through the filesystem, rejects traversal and symlink/junction escape, validates regular-file status, 30 MiB size, image signature, declared length, and SHA-256, then uploads multipart bytes to Gateway. Codex is the first real acceptance host; other MCP hosts use the identical Tool names, schemas, permissions, and results.

### Browser Agent work-environment view

`GET /agent-api/promptcard/runtime/bridge-environment` is the authenticated local-browser view used by the Canvas Agent work-environment panel. Optional `projectCode`, `cvcCode`, and `profileId` query parameters select the project/context/profile to display. They do not authorize an external Bridge request.

The response is a closed, redacted composition of:

- Gateway health and Bridge configuration state;
- configured profile IDs, client labels, fixed scopes, repository-scoped boolean, and bounded recent-activity state;
- Bridge v3 contract version, Bootstrap Skill identity plus executable instructions, Tool descriptions, writeback kinds, and fixed constraints;
- when both references are explicit and valid, the PRJ/CVC revision/digest, exact Skill pins, public creative objects, CVC member `objectCodes`, and pending delivery count.

The response never contains a Bridge token, repository path, internal Canvas node ID, arbitrary file path, or provider credential. `profileId` changes display only; the external caller's Bearer profile remains authority. Recent activity means a valid Bridge Bearer request was observed within the bounded display window and is telemetry, not a durable connection or permission grant. A CVC is switched in the browser only after the Storage inspection confirms the requested project and confirms that the CVC is not revoked.

The Canvas CVC creation action first flushes the current Free Canvas through the project save coordinator and uses the authoritative Storage revision returned by that save. The coordinator records the persisted edit sequence, so a later idle timer with no new edit does not perform a metadata-only project update that would immediately stale the new CVC.

`objectCodes` is derived from `resolve.entries[].reference.code`. It is deliberately separate from context-pack `sourceCodes`, which describe dependencies/evidence and must not be interpreted as CVC membership or write authority.

## PromptCard Runtime Boundary

Authenticated browser mutations are protected by the Runtime CSRF middleware. The maintained frontend client sends the session cookie with `credentials: "include"`, reads the CSRF cookie, and copies it to `X-CSRF-Token`. Direct callers that omit or mismatch the token receive a structured rejection before model, keyring, Storage, or provider work begins.

### `GET /agent-api/promptcard/runtime/status`

Returns a compact health view for the Python Gateway, pi text Agent, Storage, and `chat.primary` assignment:

```json
{
  "runtime": { "ok": true, "service": "promptcard-runtime", "orchestrator": "pi" },
  "auth": { "ok": true, "mode": "local-process-token" },
  "models": { "ok": true, "count": 1 },
  "tools": { "ok": true, "count": 4 },
  "storage": { "ok": true },
  "textAgent": { "ok": true, "payload": { "service": "promptcard-pi-text-agent", "orchestrator": "pi" } }
}
```

### `POST /agent-api/promptcard/runtime/bootstrap`

Creates the process-local PromptCard browser session and sets the HttpOnly runtime cookie. There is no separate DeerFlow account or login flow.

### `GET /agent-api/promptcard/runtime/catalog`

Returns the focused text-Agent catalog. The catalog advertises the four stable surface capabilities: Prompt Library search, Canvas Prompt edit, Prompt Library create proposal, and media Prompt preview. Document/Storyboard/Prompt-handoff emitters are operation-scoped runtime tools supplied only after Gateway validates an explicit `chat-experimental` write context; they are not general catalog grants. `skills` is populated from the Storage Skill registry with revision, digest, source, trust state, capability, and tool dependencies. Subagents remain disabled.

```json
{
  "models": [
    {
      "key": "connection-id:doubao-seed-2-0-lite-260215",
      "connectionId": "connection-id",
      "providerId": "volcengine-ark",
      "modelId": "doubao-seed-2-0-lite-260215",
      "displayName": "Doubao Seed 2.0 Lite",
      "capabilities": { "input": ["text", "image"], "toolCalling": true },
      "available": true,
      "unavailableReason": null,
      "isDefault": true
    }
  ],
  "skills": [
    { "id": "SKL-canvas-prompt-editor", "revision": 3, "source": "builtin", "trustState": "first-party" }
  ],
  "tools": [
    { "name": "search_prompt_library" },
    { "name": "emit_canvas_prompt_edit" },
    { "name": "emit_prompt_library_create" },
    { "name": "emit_media_prompt_preview" }
  ],
  "builtins": [],
  "subagentEnabled": false,
  "agents": [{ "id": "promptcard-text-agent", "name": "PromptCard Text Agent" }]
}
```

## Model Management

Model management separates provider definitions, model capabilities, named connections, and use-case assignments. The only maintained slots are `chat.primary` and `image.primary`. Connection credentials are written to the operating-system keyring and never returned by these APIs.

### `GET /agent-api/promptcard/runtime/model-catalog`

Returns provider definitions and model catalog entries. The current image entry is `doubao-seedream-5-0-pro-260628` with capability metadata for modes, reference count, regions, resolutions, ratios, custom-size limits, prompt optimization, official input constraints, raster annotations, output transports, output count, and streaming.

Provider definitions declare a modality-specific integration family. The initial text families are `PI 原生` and `方舟 SDK`; the initial image family is `方舟 SDK`:

```json
{
  "providers": [
    {
      "id": "deepseek",
      "displayName": "DeepSeek",
      "defaultApiBase": "https://api.deepseek.com",
      "integrationGroups": {
        "chat": { "id": "pi-native", "displayName": "PI 原生", "kind": "pi-native" }
      }
    }
  ],
  "models": [
    {
      "id": "deepseek-chat",
      "providerId": "deepseek",
      "displayName": "DeepSeek Chat",
      "modality": "chat",
      "integrationGroup": { "id": "pi-native", "displayName": "PI 原生", "kind": "pi-native" },
      "source": "provider-catalog",
      "assignable": true
    }
  ]
}
```

The frontend must filter by `modality` before grouping by `integrationGroup`. A connection may support both chat and image models, but `chat.primary` and `image.primary` remain independent assignments.

The catalog is the frontend source of truth for image controls. UI code must consume `modes`, `resolutions`, `aspectRatios`, `customSize`, `promptOptimization`, `inputConstraints`, `annotationInputs`, `outputFormats`, `responseTransports`, `watermark`, `maxReferenceImages`, `regionInputs`, `outputCount`, and `streaming` instead of branching on a Seedream model ID.

### `GET /agent-api/promptcard/runtime/image-generation-status`

Re-runs the read-only image-runtime diagnostics and returns no installation command, local path, credential, or provider response body:

```json
{
  "serverEnabled": true,
  "checkedAt": 1752572345678,
  "credentialStore": { "available": true },
  "providers": [
    {
      "providerId": "volcengine-ark",
      "status": "ready",
      "sdk": {
        "packageName": "volcengine-python-sdk",
        "installedVersion": "5.0.36",
        "requiredVersion": "5.0.36",
        "compatible": true,
        "error": null
      }
    }
  ]
}
```

Provider status is `ready`, `missing`, `incompatible`, or `check_failed`. Calling the same GET endpoint again is the supported re-detection operation; the Runtime does not expose dependency installation or command execution.

### `GET /agent-api/promptcard/runtime/model-connections`

Returns `{ "connections": [...] }`. A connection response contains:

```json
{
  "id": "uuid",
  "providerId": "volcengine-ark",
  "displayName": "Seedream production",
  "apiBase": "https://ark.cn-beijing.volces.com/api/v3",
  "enabled": true,
  "agentChatModelIds": ["doubao-seed-2-0-lite-260215", "doubao-seed-2-0-pro-260215"],
  "credentialConfigured": true,
  "credentialMask": "<masked>",
  "createdAt": 1784000000000,
  "updatedAt": 1784000000000,
  "lastTest": {
    "ok": true,
    "checkedAt": 1784000001000,
    "message": "Connection ok."
  }
}
```

`credentialRef` is internal persisted metadata and is not returned. The credential value is never returned.

### `POST /agent-api/promptcard/runtime/model-connections`

Creates a connection and returns the masked response above:

```json
{
  "providerId": "volcengine-ark",
  "displayName": "Seedream production",
  "apiBase": "https://ark.cn-beijing.volces.com/api/v3",
  "enabled": true,
  "agentChatModelIds": ["doubao-seed-2-0-lite-260215", "doubao-seed-2-0-pro-260215"],
  "credential": "user-entered-secret"
}
```

`agentChatModelIds` is optional for compatibility and is validated as a unique same-provider chat-model whitelist from the maintained catalog. Saving `chat.primary` automatically adds that model to the corresponding connection whitelist. Clearing the assignment does not clear the whitelist.

The endpoint is exact-provider-endpoint only. It rejects alternate schemes, hosts, ports, query strings, fragments, and embedded credentials. If keyring storage is unavailable, creation fails; there is no plaintext fallback.

### `PUT /agent-api/promptcard/runtime/model-connections/{id}`

Replaces the mutable connection fields using the same request shape. Omitting `credential` preserves the current keyring value; an empty value removes it. An assigned connection cannot be disabled or moved to another provider.

### `DELETE /agent-api/promptcard/runtime/model-connections/{id}`

Deletes unused connection metadata and its keyring credential. Before offering deletion, clients must query the dependency endpoint below. Unknown canvas dependency counts fail closed: the UI must not treat an unavailable count as zero.

### `POST /agent-api/promptcard/runtime/model-connections/{id}/test`

Tests the stored credential from Agent Runtime and records `lastTest`. The response is `{ "success": true|false, "message": "..." }`; raw provider or credential errors are not returned.

Changing provider, API base, credential, or enabled state clears the persisted successful test. A recorded test has no time-to-live; it remains valid until one of those material fields changes or a later test replaces it.

Provider probes are registered per provider. DeepSeek currently probes `/models`; Volcengine Ark uses its registered `/ping` connectivity probe. The test route does not assume every provider implements a model-list endpoint.

### `GET /agent-api/promptcard/runtime/model-connections/{id}/models`

Returns assignable catalog entries scoped to the connection's provider:

```json
{
  "connectionId": "uuid",
  "providerId": "volcengine-ark",
  "models": [
    {
      "id": "doubao-seed-2-0-lite-260215",
      "providerId": "volcengine-ark",
      "displayName": "Doubao Seed 2.0 Lite",
      "modality": "chat",
      "integrationGroup": { "id": "volcengine-ark-sdk", "displayName": "方舟 SDK", "kind": "sdk" },
      "source": "provider-catalog",
      "assignable": true
    }
  ]
}
```

`source: "provider-catalog"` means the maintained PromptCard support catalog, not private account endpoint enumeration. The current connection stores an inference API Key. Ark foundation-model and endpoint management APIs require a future, separately modeled AK/SK management credential.

### `GET /agent-api/promptcard/runtime/model-connections/{id}/dependencies`

Returns assignments and the number of persisted canvas-node references known to the Runtime:

```json
{
  "assignments": ["image.primary"],
  "canvasNodeCount": null,
  "canvasNodeCountAvailable": false
}
```

The current Gateway does not yet own a reliable Storage query for cross-project canvas references, so it reports `null/false` rather than a misleading zero. Connection deletion remains blocked in the model-management UI until that count is available and zero.

### `GET /agent-api/promptcard/runtime/model-assignments`

Returns `{ "assignments": [...] }` where each item contains `slot`, `connectionId`, and `modelId`.

### `PUT /agent-api/promptcard/runtime/model-assignments/{slot}`

Assigns a compatible enabled connection and model:

```json
{
  "connectionId": "uuid",
  "modelId": "doubao-seedream-5-0-pro-260628"
}
```

An assignment is accepted only when the connection is enabled, has a credential, matches the model provider and slot modality, has a latest successful connection test, and, for Ark image models, the required SDK is compatible.

### `DELETE /agent-api/promptcard/runtime/model-assignments/{slot}`

Clears the selected default slot and returns `204`. It does not delete the connection, credential, canvas nodes, history, or assets.

### Model-management error envelope

Model-management failures use a sanitized FastAPI `detail` object:

```json
{
  "detail": {
    "code": "connection_not_tested",
    "message": "The model connection must be tested before assignment.",
    "action": "test_connection",
    "retryable": false,
    "field": "connectionId"
  }
}
```

The browser client normalizes this to `{code, message, action, retryable, field?}` and maps it to safe Chinese copy. Neither layer exposes exception stacks, filesystem paths, shell commands, credentials, or raw provider bodies.

### Deprecated model-config compatibility routes

`GET/PUT /agent-api/promptcard/runtime/model-config` and `POST /agent-api/promptcard/runtime/model-config/test` remain only as legacy chat-configuration compatibility routes. New UI and integrations must use model connections and assignments. Compatibility writes still store credentials through keyring; they are not authorization for browser-local credential storage.

## Image Generation

### `POST /agent-api/promptcard/runtime/image-generations`

The frontend sends normalized intent, local asset IDs, and may supply a stable run ID. The Runtime localizes the provider result and returns no provider URL:

```json
{
  "runId": "image-run-0123456789abcdef0123456789abcdef",
  "projectId": "project-1",
  "conversationId": "image-conversation-1",
  "connectionId": "uuid",
  "modelId": "doubao-seedream-5-0-pro-260628",
  "mode": "region-edit",
  "promptDocument": {
    "version": 1,
    "segments": [
      { "type": "text", "text": "Replace the material on " },
      { "type": "reference", "referenceId": "subject", "label": "subject" }
    ]
  },
  "inputs": [
    {
      "referenceId": "subject",
      "role": "source-image",
      "assetId": "provider-input.jpg",
      "sourceAssetId": "original-input.heic",
      "order": 0
    }
  ],
  "regions": [
    { "type": "bbox", "referenceId": "subject", "x1": 100, "y1": 120, "x2": 700, "y2": 800 }
  ],
  "resolution": "2K",
  "aspectRatio": "smart",
  "promptOptimization": "standard",
  "outputFormat": "png",
  "watermark": false
}
```

`runId` is optional for compatibility. When supplied, it must match `^image-run-[0-9a-f]{32}$`; Runtime uses that exact ID for the durable run and returns the same value. When omitted, Runtime generates the ID as before. An invalid supplied value is rejected during request validation before run creation or provider access.

`conversationId` identifies a project-level Image Generation Agent conversation and does not require `nodeId`. Legacy node-bound callers may send `nodeId` instead; at least one identity is required. When a conversation already exists, Runtime verifies that it belongs to `projectId` before provider access and maps a mismatch to a sanitized not-found response. Runtime compiles only this request's prompt, inputs, regions, and settings; it never reads or appends earlier conversation runs.

For `aspectRatio: "custom"`, positive integer `width` and `height` are required and must satisfy 921600–4624220 total pixels and `1:16–16:1`. The total image count includes the source image and cannot exceed ten. At most one input may use `role: "source-image"`. `edit` and `region-edit` require a source image; `region-edit` also requires at least one point or bounding box.

`promptOptimization` is `standard` or `fast` and defaults to `standard`. The adapter sends the value through Ark `OptimizePromptOptions`. The backend may request provider output as URL or `b64_json`; this transport is not an ordinary UI parameter, and the successful Runtime response never contains either provider payload.

Success:

```json
{
  "runId": "image-run-0123456789abcdef0123456789abcdef",
  "state": "succeeded",
  "assetId": "generated-local-asset.png",
  "captureId": "generated-result-capture",
  "contentType": "image/png",
  "width": 2048,
  "height": 2048
}
```

If the request supplied `runId`, the browser treats a different response `runId` as an invalid Runtime response rather than associating the result with another canvas placeholder.

New requests require `PROMPTCARD_IMAGE_GENERATION_NODE_V1=true`; otherwise the endpoint returns `403 image_generation_disabled` before creating a run or reading a credential. Validation/provider/storage failures use a sanitized `detail` object with `code`, `message`, `retryable`, and, after run creation, `runId`. Capacity and rate-limit errors return `429`; retryable infrastructure errors return `503`; other request/provider errors return `422`.

The project Image Generation tab is independent from the pi text Agent message route. It does not create a text-Agent session, call the chat model, or append previous image-generation turns to the provider prompt.

### `POST /agent-api/promptcard/runtime/messages`

Request:

```json
{
  "conversationId": "persistent-project-conversation",
  "requestId": "client-generated-idempotency-key",
  "content": "User message",
  "mode": "free-canvas",
  "permissionScope": "workspace-chatbot-agent",
  "projectId": "project",
  "selectedSkillIds": ["SKL-external-example"],
  "canvasNodeContext": {
    "mode": "rewrite",
    "targetNodeId": "text-node-1",
    "referenceNodeIds": ["text-node-2"],
    "mentions": [
      { "nodeId": "text-node-1", "label": "TXT-A1B2C3" },
      { "nodeId": "text-node-2", "label": "构图参考" }
    ]
  },
  "workspaceContext": {
    "contextId": "canvas:project",
    "mode": "free-canvas",
    "projectId": "project",
    "projectTitle": "Project",
    "snapshot": {
      "selectedNodeId": "text-node-1",
      "selectedNode": {
        "id": "text-node-1",
        "kind": "text",
        "revision": 1770000000000,
        "segments": [
          { "id": "preset-1", "source": "preset", "text": "protected template" },
          { "id": "user-1", "source": "user", "text": "existing prompt" }
        ],
        "userText": "existing prompt"
      }
    }
  }
}
```

Response:

```json
{
  "threadId": "persistent-project-conversation",
  "conversationId": "persistent-project-conversation",
  "requestId": "client-generated-idempotency-key",
  "text": "assistant text",
  "proposals": [
    {
      "kind": "free_canvas_text_create",
      "sourceNodeId": "text-node-1",
      "userText": "complete rewritten prompt",
      "basis": {
        "baseNodeRevision": 1770000000000,
        "templateDigest": "sha256:...",
        "baseSegmentsDigest": "sha256:..."
      },
      "status": "pending"
    }
  ],
  "canvasEdits": [],
  "diagnostics": { "proposalCount": 0 }
}
```

Current proposal behavior:

- `canvasNodeContext` may attach at most ten unique text nodes. It has at most one writable target; every `referenceNodeId` is read-only. Mention IDs must be part of that attached set.
  - With `mode: complete`, Gateway exposes only `emit_canvas_prompt_edit` with at most 16 exact segment/text insertion anchors. A text anchor includes both `segmentId` and `text`; its text must occur exactly once inside that named segment, then the insertion is made immediately before or after that substring. Validated output becomes `free_canvas_text_insertions`; approval preserves every existing segment's characters, order, source, and color while adding black user segments at the anchors.
- With `mode: rewrite`, the same tool accepts only a complete `userText`. Validated output becomes `free_canvas_text_create`; approval creates a derived node while leaving the source unchanged.
- With `mode: prompt-library`, `targetNodeId` must be `null`. The Gateway exposes only `search_prompt_library` for this Canvas mode and rejects every Canvas creation or update proposal.
- Without an explicit target, ordinary discussion remains available but all Canvas mutation proposals are rejected.
- `prompt-library-agent` may return only additive `prompt_library_write_proposal` records.
- All proposals remain pending until the frontend user selects Apply or Reject.
- Preset/template segments, every existing target segment, and all reference nodes are read-only through the revision 3 tool schema.
- Gateway resolves node bodies from the current project snapshot and attaches the current node revision, template digest, and canonical segment digest. The frontend rechecks all three and every anchor before applying a proposal.

`canvasEdits` is separate from the legacy proposal array. It contains at most one Gateway-enriched `document_create`, `document_changes`, `storyboard_create`, or `storyboard_changes` edit for an explicitly authorized experimental-chat operation. The edit carries deterministic request/edit/node identity, authoritative base revision/digest, expected result digest, and exact model/Skill provenance. Browser-supplied identity, Tiptap JSON, arbitrary JSON Patch, and more than one successful write tool are rejected.

Persistent project calls use `conversationId + requestId`. Gateway loads up to 40 normalized messages from PromptCard Storage, validates the conversation's project, entrypoint, mode, and saved model binding, invokes the stateless Node runtime, and stores the new turn plus its model snapshot. Retrying the same `requestId` returns the first stored result and model snapshot instead of appending duplicates or switching models.

In `prompt-edit`, `selectedSkillIds` accepts at most eight external Skill IDs and affects only that request. In `chat-experimental`, the authoritative Skill IDs come from the conversation's persisted `boundSkillIds`; the browser cannot replace them in the message body. Gateway resolves the exact enabled local-Agent host pin for every turn and records `skillId + revision + digest`; it never falls back to the package's current revision. Storage and Gateway independently reject disabled, archived, untrusted, malformed, over-budget, non-tool-capability, or out-of-scope-tool snapshots before model invocation.

The Python Gateway validates the browser request and returned proposals. The pi runtime owns prompt orchestration, the PI provider collection, and proposal tools. Gateway resolves the conversation's non-secret model descriptor for each request; PI-native models use PI's API implementation through the credential-injecting Gateway proxy, and SDK-backed models use the Gateway text-SDK registry. Provider credentials never enter the Node process.

#### Experimental conversation and planning writes

An ordinary experimental turn adds `"interactionMode": "chat-experimental"`. It may attach up to five project document resource IDs and explicitly referenced Document nodes:

```json
{
  "conversationId": "persistent-project-conversation",
  "requestId": "client-generated-idempotency-key",
  "content": "Use these references to plan the character.",
  "mode": "free-canvas-workspace",
  "permissionScope": "workspace-chatbot-agent",
  "projectId": "project",
  "interactionMode": "chat-experimental",
  "documentResourceIds": ["0123456789abcdef0123456789abcdef"],
  "explicitDocumentNodeIds": ["document-node-1"],
  "documentWriteContext": { "operationKind": "document_create" },
  "workspaceContext": null
}
```

`documentWriteContext` is a closed explicit action union: `document_create`, `document_changes` with one node ID, `storyboard_create` with one Document node ID, `storyboard_changes` with one Storyboard node ID, or `prompt_handoff` with a Document-selection/Storyboard-shot basis. Gateway discards browser-authored authority and rebuilds the full write context from Storage and the current Canvas. Without that explicit context, experimental chat is discussion-only.

TXT/Markdown/DOCX normalized text and ephemeral PDF provider input are resolved only for the current invocation. Ambient workspace context contains Document identity/title/revision/digest plus a bounded excerpt, never an implicit full body. Document/Storyboard content is not added to Prompt Library, Prompt search, Prompt compilation, image-generation input, or media reference codes.

Prompt handoff is the only planning action returned in `proposals`: it creates one pending `free_canvas_text_create` proposal whose `handoffBasis` binds the exact Document selection or Storyboard shot. Approval may create one new all-`user` Prompt node; it cannot update an existing Prompt or read/write Prompt Library.

### `PATCH /agent-api/promptcard/runtime/projects/{projectId}/conversations/{conversationId}/model`

Persists a conversation model selection immediately:

```json
{
  "modelBinding": {
    "connectionId": "connection-id",
    "providerId": "volcengine-ark",
    "modelId": "doubao-seed-2-0-pro-260215"
  }
}
```

Gateway—not the browser—checks that the conversation belongs to the project and is active, the model belongs to the connection's current `agentChatModelIds`, and the connection is enabled, credentialed, and most recently tested successfully. The route then forwards the validated binding to Storage. Passing `null` is supported by the storage contract, while the project UI normally selects another available model instead.

### Document/Storyboard apply acknowledgement and reconciliation

- `POST /agent-api/promptcard/runtime/projects/{projectId}/conversations/{conversationId}/edits/{editId}/ack`
- `POST /agent-api/promptcard/runtime/projects/{projectId}/conversations/{conversationId}/edits/reconcile`

The frontend persists the changed node and its `AgentAppliedEditMarker` in one project save before acknowledging `applied`. ACK carries the originating `requestId` plus `status: "applied" | "failed"`; a failed ACK is advisory until Gateway reloads Storage.

Gateway never trusts the browser receipt alone. It reloads the project, requires exactly one matching Canvas target and marker, and verifies project/node kind, deterministic identity, request/edit identity, and result digest. Reconciliation returns `pending_apply`, `applied`, `failed_conflict`, `failed_integrity`, `failed_target_missing`, or `idle`, with the identical replay edit only when the stored base is still revalidatable. This is the saved-before-ACK and restart-recovery boundary.

#### Explicit Prompt Library lookup

Prompt Library access is opt-in per request. A normal project Agent request, including `complete`, `rewrite`, ordinary discussion, media analysis, and `chat-experimental`, omits `promptRetrieval`; Gateway injects no library evidence and the Runtime does not expose `search_prompt_library`. To perform a read-only lookup from the Canvas Agent or dedicated Prompt Library assistant, the browser sends only a bounded request:

```json
{
  "permissionScope": "workspace-chatbot-agent",
  "canvasNodeContext": {
    "mode": "prompt-library",
    "targetNodeId": null,
    "referenceNodeIds": [],
    "mentions": []
  },
  "promptRetrieval": {
    "query": "cool industrial light",
    "types": ["style"],
    "categories": ["cinematic"],
    "exactCodes": [],
    "limit": 10
  }
}
```

`query` is at most 256 characters; type/category filters, exact `PLP` codes, and result count have fixed limits. Gateway queries Storage, revalidates revision/digest evidence, caps total injected label/content to 12,000 characters, and sends no internal preset ID, local path, raw asset bytes, or unrestricted metadata to the pi Runtime. The returned `diagnostics.promptRetrieval` contains `auditId`, query digest, stale rejection/result counts, degraded/error state, and citations (`referenceCode`, title, revision, digest). The frontend persists citations with the assistant message and renders them outside model-authored Markdown.

If retrieval Storage is unavailable, Gateway invokes the Agent with an empty evidence list and returns `degraded: true` plus `prompt_retrieval_unavailable`; the UI makes that state visible. A malformed request, forbidden mode, or unknown exact code fails closed. In `prompt-library` Canvas mode `allowedProposalKinds` remains empty, so retrieval has no Canvas write target.

### `POST /agent-api/promptcard/runtime/media-analysis`

Request:

```json
{
  "assetId": "selected-media-asset",
  "contentType": "image/png",
  "analysisType": "freeform",
  "content": "Discuss the lighting before producing a prompt.",
  "history": [
    { "role": "user", "text": "Focus on the hard-surface design." },
    { "role": "assistant", "text": "The image uses cool industrial lighting." }
  ],
  "mediaAction": "chat",
  "mediaPreview": null,
  "selection": null
}
```

`analysisType` remains `style`, `freeform`, or `prompt` for compatibility. `mediaAction` is `chat`, `preview`, or `selection-rewrite`. The Gateway bounds history to 40 messages, reloads exactly the requested asset from PromptCard Storage on every request, accepts image content only, limits the asset to 30 MiB, and sends one image attachment through pi to the assigned multimodal text provider.

- `chat` returns discussion text and no structured Prompt proposal.
- `preview` permits one `media_prompt_preview` proposal containing editable `label`, `type`, `category`, `content`, and rationale.
- `selection-rewrite` receives the current preview plus `{ start, end, text }` and returns a replacement candidate. The frontend applies it only after confirmation.

Media history is deliberately ephemeral and has no `conversationId`. Closing the dialog discards it. Writing a preview to Prompt Library uses the Storage Recent Capture registration endpoint; this Runtime route never writes a preset directly.

Video analysis is not part of the current API behavior.

## Internal Routes

These routes are local-service-only, require `X-PromptCard-Internal-Token` at the route boundary, and are not browser integration contracts:

- `GET /api/promptcard/runtime/internal/text-model` returns the current `chat.primary` connection ID, provider ID, model descriptor, capabilities, and integration group. It returns neither `apiBase` nor a credential.
- `POST /api/promptcard/runtime/internal/pi-proxy/{connectionId}/chat/completions` is the PI-native OpenAI-compatible stream boundary. It accepts only the current PI-native assignment, exact `chat/completions` path, and exact assigned model ID; the Gateway replaces incoming authorization with the keyring credential.
- `POST /api/promptcard/runtime/internal/chat` is the SDK-backed text boundary. It accepts only an SDK integration group and dispatches through the registered `TextProviderAdapter`; Volcengine Ark is the first adapter.

A browser local-session cookie is insufficient for these routes.

## Removed Routes

DeerFlow-native thread, run, auth, model, tool, skill, agent, memory, channel, MCP, upload, and sandbox routes are removed. New integrations must use the PromptCard Runtime Boundary above.
