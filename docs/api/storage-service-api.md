# Storage Service API

The local storage service is the durable source of truth for projects, Prompt Library presets, asset metadata/bytes, Recent Capture metadata, image-generation conversations/runs, canvas placements, project document resources, provider-file cleanup retries, public references, typed creative references, context packs, canonical Skill packages, and Skill host pins. The frontend reaches it through the Vite proxy prefix `/storage-api/*`; the service itself exposes `/api/*` on the runtime-selected Storage port (the legacy default is `8002`).

## Health

`GET /health` returns `serviceVersion`, `schemaVersion`, `storage`, `database`, `pid`, and capabilities including `sqlite`, `assets`, `presetBatch`, `browserImportIdempotency`, `backup`, `recentCaptures`, `projectResources`, `projectDocumentResources`, `agentConversations`, `skillHub`, `contextPacks`, and `promptRetrieval`. The current service reports schema version `18`. Versions 10–18 add public reference codes, immutable Canvas context packs, canonical Skill packages, independent Skill host pins, exact-revision trust reviews, project document resources, durable remote-file cleanup retries, typed creative references, and transactional Prompt retrieval; see [Schema Notes](../database/schema-notes.md).

## Typed Creative References

- `GET /api/projects/references/{projectReferenceCode}/creative/{creativeReferenceCode}`

`creativeReferenceCode` must be an exact `CVD-*` or `CVS-*` code belonging to the exact active `PRJ-*`. Document responses expose the editor-neutral AST, revision and digest. Storyboard responses expose the sequence fields and ordered rows, replacing internal row identities with `rowOrdinal` and replacing an available source Document node identity with its `CVD-*` code. Internal Canvas IDs, row IDs, coordinates, model/connection data, arbitrary metadata, and local paths are never returned. Unknown, cross-project, retired, malformed, or no-longer-referenceable objects fail with structured lifecycle/reference errors.

- `GET /health`

Returns service status and the active data directory.

## Assets

- `POST /api/assets`
- `GET /api/assets/{asset_id}`
- `GET /api/assets/diagnostics`
- `GET /api/internal/context-packs/{cvcCode}/assets/{PLM-or-CVM}` (internal authentication only)

Asset uploads send the bytes as the request body, the MIME type in `Content-Type`, and the original filename in `X-File-Name`. The service accepts signature-validated image and video asset types supported by the asset store. The service stores files up to 200 MB and returns:

```json
{
  "id": "generated-id.png",
  "filename": "storyboard.png",
  "contentType": "image/png",
  "size": 12345
}
```

The generated ID is safe to persist in project metadata and Recent Capture metadata. The read endpoint serves the original bytes with their stored content type. Invalid types, empty or oversized bodies return `400`; unknown or malformed IDs return `404`.

`GET /api/assets/diagnostics` checks the asset manifest and reference graph. Active and Trash projects, active and Trash Prompt presets, and Recent Captures all participate in the reference scan. Registering or placing a capture therefore does not require a copied asset.

The internal context-asset route is the only binary read used by the Local Agent Bridge. It accepts no `assetId` or path: Storage resolves an exact public `PLM`/`CVM`, proves that it is included in an active non-revoked `CVC`, rechecks its owner and asset lifecycle, and returns current bytes plus public-reference metadata headers. Gateway applies the external 5 MiB response budget and never forwards the internal ID or relative path.

Succeeded image-generation runs also participate in the reference scan through `outputAssetIds`. Deleting a project or capture record must not make a historical generated output appear orphaned.

### Image import and derivatives

- `POST /api/image-assets/import`
- `POST /api/image-assets/derivations`
- `GET /api/image-assets/derivations/{sourceAssetId}`

Import accepts raw JPEG, PNG, WebP, BMP, TIFF, GIF, HEIC, and HEIF bytes. The request sends the MIME type in `Content-Type`, the URL-encoded original filename in `X-File-Name`, and the image bytes as the body. It validates the declared signature, 30 MB maximum, 36 million-pixel maximum, sides greater than 14, and `1:16–16:1` aspect ratio. The response returns the permanent original plus preview/provider-input assets and decoded dimensions:

```json
{
  "originalAsset": { "id": "original.heic", "contentType": "image/heic" },
  "previewAsset": { "id": "preview.jpg", "contentType": "image/jpeg" },
  "providerInputAsset": { "id": "provider.jpg", "contentType": "image/jpeg" },
  "width": 3024,
  "height": 4032
}
```

PNG/JPEG/WebP can be reused directly when no orientation conversion is required. BMP/TIFF/GIF/HEIC/HEIF are converted to a standard provider derivative; GIF/TIFF use the first frame/page, EXIF orientation is applied, alpha uses PNG, and opaque content uses high-quality JPEG.

The derivation POST records `sourceAssetId`, `derivedAssetId`, kind (`preview`, `provider-input`, or `annotation-flattened`), transform metadata, and an optional non-destructive annotation document. The GET endpoint returns `{ "derivations": [...] }` for the source asset. Both assets remain strong references. There is intentionally no derivative DELETE endpoint.

## Image Generation Runs

- `POST /api/image-generation-runs`
- `PATCH /api/image-generation-runs/{id}/state`
- `GET /api/image-generation-runs?projectId=&nodeId=&conversationId=&cursor=&limit=`
- `GET /api/image-generation-runs/{id}?projectId=`

There is intentionally no `DELETE` endpoint.

Runs are append-only request snapshots with a strict state machine:

```text
queued -> running -> succeeded
                  -> failed
```

Creation requires project, connection, provider, model, normalized request snapshot, an empty `outputAssetIds` list, and at least one of `conversationId` or legacy `nodeId`. The first conversation run atomically creates its conversation row with the queued run. Run detail and list reads require a matching `projectId`; cross-project IDs return `404`. State patches may only contain fields allowed for their target state. A succeeded patch uses `usage` for optional provider accounting; `providerUsage` is not an accepted state-patch field. Terminal records are immutable, and duplicate IDs return `409`.

## Image Generation Conversations And Placements

- `GET /api/image-generation-conversations?projectId=&cursor=&limit=`
- `GET /api/image-generation-conversations/{conversationId}?projectId=`
- `GET /api/image-generation-conversations/{conversationId}/runs?projectId=&cursor=&limit=`
- `GET /api/image-generation-placements?projectId=&state=pending`
- `PATCH /api/image-generation-placements/{runId}`

Conversation list/detail/run reads require the matching `projectId`. A mismatch returns `404` and does not disclose whether another project owns the conversation. Conversation summaries include the title, timestamps, latest run/state, preview asset, and turn count. The title is derived from the first non-empty prompt (32 visible characters) or a dated `图片创作` fallback.

A successful conversation run creates one permanent placement. Placement supports only `pending -> placed`; the patch body is `{ "state": "placed", "canvasNodeId": "..." }`. The frontend first hydrates the node carrying the same `generationRunId`, or creates a fallback result node for a legacy run, then persists the project. It marks the placement `placed` only after that save succeeds, so a retry remains idempotent and cannot acknowledge an unpersisted canvas update. There is no placement or conversation `DELETE` endpoint. Legacy node-only runs do not create placements.

A succeeded patch must reference assets already registered in the same Storage service. Those output IDs become strong historical references. Project/node removal and permanent project Trash deletion do not cascade into generation runs, output assets, or generated-result captures.

List results are ordered by `createdAt DESC, id DESC`, accept optional project/node filters, and use an opaque `nextCursor`. `limit` must be between 1 and 100. A retry or “generate again” action always creates another run rather than replacing the earlier record.

Storage rejects credential-, token-, URL-, URI-, and path-like field names anywhere inside persisted generation payloads. Prompt text may contain those ordinary words; the restriction applies to field names and sensitive structure, not user prose.

## Recent Captures

- `GET /api/recent-captures`
- `GET /api/recent-captures/{id}`
- `POST /api/recent-captures`
- `PUT /api/recent-captures/{id}`
- `DELETE /api/recent-captures/{id}`
- `POST /api/recent-captures/register-to-prompt-library`

Recent Capture records are metadata rows that point at existing assets by `assetId`. The current image intake accepts native screenshots and clipboard PNG/JPEG/WebP images. Recording/video capture remains gated behind Windows desktop acceptance. A stored item has this UI-facing shape:

```json
{
  "id": "capture-1",
  "assetId": "generated-id.png",
  "kind": "screenshot",
  "status": "recent",
  "purpose": "inspirationReference",
  "role": null,
  "title": "Screenshot",
  "prompt": "",
  "userNote": "",
  "sourcePlatform": "",
  "sourceUrl": "",
  "contentType": "image/png",
  "size": 12345,
  "width": 640,
  "height": 360,
  "capturedAt": 1770000000000,
  "origin": { "type": "floating-toolbar", "engine": "xcap" },
  "registeredPromptId": null,
  "registeredAt": null,
  "linkedProjectId": null,
  "linkedCanvasNodeId": null,
  "revision": 1
}
```

The Media UI labels deletion as **Remove record**. `DELETE /api/recent-captures/{id}` requires `{ "revision": <current revision> }` and only removes the metadata row. It intentionally does not delete the shared asset file or any Prompt Library/Canvas consumer that already references the same `assetId`; an asset left without consumers remains visible to asset diagnostics for later cleanup. Permanent asset deletion is not part of this endpoint.

Creates accept a complete capture metadata payload and return the stored item with service timestamps and `revision`. Updates require the current `revision` and replace only supplied mutable fields. Stale revisions return `409` with the current item. Malformed payloads return `400`.

Registration is one SQLite transaction. `mode: "separate"` creates one preset per Capture; `mode: "merged"` creates one preset whose `meta.media` contains every selected asset. Each request item carries Capture `id` and `revision`, while user-confirmed label/content/type/category fields are supplied per item or in the merged `prompt` object. `category` is optional and falls back to `type`. The response is `{ "presets": [...], "captures": [...] }`. Missing captures/assets, stale revisions, blank Prompt fields, or already-registered captures roll back the entire batch. Preset `meta.media[].assetId` is copied by reference, while `meta.recentCaptureSources` preserves Capture provenance.

Separate request:

```json
{
  "mode": "separate",
  "captures": [
    { "id": "capture-1", "revision": 2, "label": "Hero", "content": "cinematic hero portrait", "type": "subject", "category": "cinematic-characters" }
  ]
}
```

Merged request:

```json
{
  "mode": "merged",
  "captures": [
    { "id": "capture-1", "revision": 2 },
    { "id": "capture-2", "revision": 1 }
  ],
  "prompt": { "label": "Reference set", "content": "use the reviewed reference set", "type": "custom" }
}
```

Registration returns `400` for invalid modes, empty/blank Prompt fields, or already-registered items; `404` for missing Capture or asset records; and `409` for stale revisions. A failure response never contains a partially inserted Preset or partially updated Capture.

## Project Agent Conversations

- `POST /api/agent-conversations`
- `GET /api/agent-conversations?projectId=...&status=active|trash&cursor=...&limit=50`
- `GET /api/agent-conversations/{id}?projectId=...&includeTrash=false`
- `PATCH /api/agent-conversations/{id}`
- `PATCH /api/projects/{projectId}/agent-conversations/{id}/model`
- `PATCH /api/projects/{projectId}/conversations/{id}/interaction`
- `POST /api/agent-conversations/{id}/turns`
- `PATCH /api/agent-conversations/{id}/proposals/{proposalId}`
- `POST /api/agent-conversations/{id}/trash`
- `POST /api/agent-conversations/{id}/restore`
- `DELETE /api/agent-conversations/{id}`

Conversations are always owned by one active project and record `entrypoint`, `mode`, title, lifecycle status, timestamps, optimistic `revision`, `interactionMode`, `boundSkillIds`, and an optional `modelBinding` containing `connectionId`, `providerId`, and `modelId`. The project-scoped model route updates or clears that binding. The interaction route requires `{ "interactionMode": "prompt-edit" | "chat-experimental", "boundSkillIds": [], "expectedRevision": 1 }`; it atomically replaces the conversation-scoped binding and rejects stale revisions. Active and Trash lists are separate, ordered by `updatedAt DESC, id DESC`, and return `{ "conversations": [...], "nextCursor": "..." }`. The detail projection adds ordered `messages`, durable `proposals`, and stored turn results.

Creating a turn requires:

```json
{
  "projectId": "project-1",
  "requestId": "request-1",
  "userMessage": { "role": "user", "text": "Complete the selected prompt." },
  "assistantMessage": { "role": "assistant", "text": "A proposal is ready." },
  "proposals": [],
  "modelSnapshot": {
    "connectionId": "connection-1",
    "providerId": "volcengine-ark",
    "modelId": "doubao-seed-2-0-lite-260215",
    "displayName": "Doubao Seed 2.0 Lite",
    "capabilities": { "input": ["text", "image"], "toolCalling": true }
  },
  "skillSnapshots": [
    { "skillId": "SKL-canvas-prompt-editor", "revision": 3, "digest": "sha256:..." }
  ]
}
```

`(conversationId, requestId)` is unique. Repeating it returns the first stored result without inserting duplicate messages or proposals. Proposal status accepts only `approved` or `rejected` and is updated through the project-scoped proposal route.

Moving a conversation to Trash preserves all child records. Restore returns it to the active list. Permanent deletion is accepted only from Trash and cascades turns, messages, and proposals. Conversation Trash is independent of project, Prompt, and asset Trash.

## Skill Registry

- `GET /api/skills`
- `GET /api/skills/{skillId}`
- `POST /api/skills`
- `POST /api/skills/{skillId}/revisions`
- `POST /api/skills/{skillId}/archive`
- `POST /api/skills/{skillId}/restore`
- `POST /api/skills/{skillId}/revisions/{revision}/review`
- `GET /api/skill-hosts`
- `POST /api/skill-package-inspections/folder`
- `POST /api/skill-package-inspections/archive`
- `POST /api/skill-package-imports`
- `PUT /api/skills/{skillId}/host-pins/{host}`
- `GET /api/skills/{skillId}/host-pins/{host}?repositoryScope=...`
- `POST /api/skills/{skillId}/host-pins/codex/repair`
- `GET /api/skill-host-snapshots/local-agent?skillId=...`

The registry retains the two first-party Skills and immutable revision 3 of `canvas-prompt-editor`:

- `SKL-canvas-prompt-editor`, capability `canvas.prompt.edit`
- `SKL-media-prompt-reverse`, capability `media.prompt.reverse`

Each Skill summary exposes stable ID/slug, canonical `SKL` reference code, name, description, `builtin|external` source, trust state, lifecycle, optional capability ID, declared tool dependencies, current revision, digest, and the current revision's trust review. Detail returns immutable canonical revisions with package entries, provenance, declared capabilities, digest, creation time, and per-revision review state.

The mutation routes create external Skills and append external revisions only; built-in revisions remain application-managed. Folder/archive inspection is bounded and non-mutating, and import accepts only a matching clean inspection result. Archive and restore change package lifecycle without deleting immutable revisions. Package scripts and assets may be stored canonically but are never executed by the local Agent.

An exact revision review uses:

```json
{
  "expectedDigest": "sha256:...",
  "decision": "trusted"
}
```

`decision` is `trusted` or `untrusted`. The digest is compare-and-swap evidence for the reviewed immutable revision; a mismatch returns `409 skill_review_stale`. A new revision starts without inheriting a previous external revision's approval and does not move either host pin. Enabling or repairing an external Skill requires both globally permitted trust state and a trusted exact revision. Explicit disable/unpublish remains available for archived or revoked Skills so a discoverable projection can be removed safely.

### Independent host pins

`host` is either `codex` or `local-agent`. A pin update body is:

```json
{
  "enabled": true,
  "revision": 2,
  "repositoryScope": "local-repository",
  "publicationName": "my-skill"
}
```

`repositoryScope` is required for Codex and identifies a repository already mapped in Storage configuration; it is not a filesystem path. `publicationName` is optional and otherwise defaults to the Skill slug. Both fields are invalid for the global local-Agent host. Every response identifies the exact `revision` and `digest`; changing one host never advances the other host's pin.

`GET /api/skill-hosts` returns supported host IDs and configured opaque repository scope keys. It never exposes their filesystem mappings.

Codex publication writes the canonical package under the configured repository's `.agents/skills/<publicationName>` directory. `GET` adds `projectionHealth`, which is `healthy`, `drifted` with a bounded code, or `unhealthy` with a recovery-required code. Unowned collisions are preserved, and modified, missing, extra, linked, junction, or reparse content is never accepted as canonical. See [Skill Host Pins And Projections](../architecture/skill-host-projections.md) for locking, journal recovery, and residual transaction risk.

Explicit repair accepts `{ "repositoryScope", "expectedRevision", "expectedDigest" }`. It compare-and-swaps against the enabled durable Codex pin, rechecks exact-revision trust, rejects unsafe ancestors before mutation, and repairs only a projection proven to be PromptCard-owned. It does not move the pin or overwrite an unowned collision.

The local-Agent snapshot endpoint returns only the enabled exact pinned revision:

```json
{
  "skillId": "internal-skill-id",
  "skillReferenceCode": "SKL-01K...",
  "revision": 2,
  "digest": "sha256:...",
  "instructions": "...",
  "references": [],
  "declaredCapabilities": { "tools": [] }
}
```

Every snapshot read rechecks active lifecycle and `trusted|first-party` trust. It returns only root `SKILL.md` instructions and allowed UTF-8 `references/*` text; scripts/assets, disabled pins, archived packages, untrusted packages, malformed capabilities, and over-budget snapshots fail closed.

## Projects

- `GET /api/projects`
- `GET /api/projects/{id}`
- `POST /api/projects`
- `PUT /api/projects/{id}`
- `POST /api/projects/trash`
- `GET /api/projects/trash`
- `POST /api/projects/trash/restore`
- `DELETE /api/projects/trash`

Project writes require a `revision` in the request body:

```json
{
  "revision": 3,
  "updates": {
    "title": "Updated title"
  }
}
```

If the revision is stale, the service returns `409` with the current item in the response detail. The frontend project save coordinator adopts the returned revision and retries the newest complete local project snapshot, serially, up to three attempts. Local editable content is authoritative during this retry and is never replaced by the conflict payload.

Network failures and exhausted retries leave the newest local snapshot pending. A later automatic or manual save retries it; the UI reports failure without rolling back local edits.

### Project resources

- `GET /api/projects/{projectId}/resources`
- `POST /api/projects/{projectId}/resource-folders`
- `PUT|DELETE /api/projects/{projectId}/resource-folders/{folderId}`
- `POST /api/projects/{projectId}/resources`
- `PUT|DELETE /api/projects/{projectId}/resources/{resourceId}`
- `PUT /api/projects/{projectId}/resource-layout`

The snapshot response is `{ "folders": [], "resources": [] }`. Folders carry `parentId`, `sortOrder`, and `revision`. Resources are `subject` or `material` and retain `sourceAssetId`, `previewAssetId`, `providerAssetId`, decoded dimensions, MIME type, folder/order, and revision. Subject `folderId` is always null.

Names are trimmed and must contain 1-80 characters. A folder cannot become its own descendant (`409 folder_cycle`) and cannot be deleted while it contains folders or resources (`409 folder_not_empty`). Deleting a resource removes only its metadata row.

`resource-layout` receives folder/resource identities, destinations, orders, and current revisions. The service validates the complete proposal before writing it. One stale record returns `409 revision_conflict` and leaves every row unchanged.

Every endpoint verifies that the path project is active and owns the requested IDs. Missing, cross-project, and Trash-project requests all return `404`. Moving a project to Trash preserves its resources but makes them unavailable for editing; restore reveals them unchanged. Permanent project deletion cascades resource metadata without deleting shared image files.

## Project Document Resources And Provider Cleanup

- `POST /api/projects/{projectId}/document-resources`
- `GET /api/projects/{projectId}/document-resources`
- `GET /api/projects/{projectId}/document-resources/{resourceId}`
- `DELETE /api/projects/{projectId}/document-resources/{resourceId}`
- `POST /api/projects/{projectId}/document-resources/{resourceId}/restore`

Uploads send bytes in the request body, the exact supported MIME type in `Content-Type`, and the URL-encoded original filename in `X-File-Name`. Supported pairs are `.txt`/`text/plain`, `.md`/`text/markdown`, `.pdf`/`application/pdf`, and `.docx`/the Office Open XML document MIME type. Storage validates the extension, MIME type, signature/container, project state, and per-format size before writing. Limits are 5 MiB for TXT/Markdown, 20 MiB for DOCX, and 50 MiB for PDF.

The response contains the opaque resource ID, project ID, original filename, content type, size, SHA-256 digest, extraction kind/status, normalized-text digest when applicable, optimistic revision, lifecycle state, and timestamps. It never returns an absolute path, normalized document body, provider file ID, or credential. TXT/Markdown are strict UTF-8; DOCX extraction uses the pinned `python-docx==1.2.0`; PDF bytes remain canonical local input and have no local OCR fallback.

Document resources are separate from image `project_resources`, Prompt media, and Prompt Library records. Delete moves one resource to its own Trash lifecycle and restore reactivates it. Cross-project access and access through a trashed project fail closed. A turn may attach at most five resource IDs and at most 100 MiB in aggregate; Gateway re-resolves ownership and lifecycle before every invocation.

The following routes are internal-token-only Gateway/Storage coordination and are not browser APIs:

- `GET /api/internal/projects/{projectId}/document-resources/{resourceId}/content`
- `POST /api/internal/provider-file-cleanup`
- `GET /api/internal/provider-file-cleanup/due?now=&limit=`
- `POST /api/internal/provider-file-cleanup/succeeded`
- `POST /api/internal/provider-file-cleanup/retry`
- `POST /api/internal/bridge-deliveries/begin`
- `POST /api/internal/bridge-deliveries/{clientRequestId}/finish`
- `GET /api/internal/bridge-deliveries/{clientRequestId}?profileId=`
- `POST /api/internal/bridge-deliveries/reconcile`

The Bridge delivery routes implement the schema v19 profile-scoped idempotency ledger. `begin` receives trusted operation context separately from the untrusted delivery request; requests containing `profileId`, scopes, client identity, or an operation context are rejected. Only new operations require a current active CVC; replay and status return the first durable result without repeating the mutation. `finish` is compare-by-profile/request/digest, and recovery converts bounded stale `processing` rows to a durable redacted failure. These are coordination routes for Gateway only and do not constitute a browser or MCP write surface by themselves.

For Ark PDF input, Gateway uploads a remote file for one invocation and deletes it in `finally`. A failed remote deletion is stored as a redacted cleanup row and retried on Gateway startup with bounded backoff. Public responses and diagnostics expose counts/safe error codes only; remote file IDs are never returned to the browser.

## Prompt Library

- `GET /api/presets`
- `GET /api/presets/{id}`
- `POST /api/presets`
- `PUT /api/presets/{id}`
- `PUT /api/presets/batch`
- `POST /api/presets/reorder`
- `POST /api/presets/{id}/increment-usage`
- `POST /api/presets/trash`
- `GET /api/presets/trash`
- `POST /api/presets/trash/restore`
- `DELETE /api/presets/trash`

Preset updates and usage increments require the current revision. The batch endpoint atomically replaces the active Prompt Library: every supplied existing item must have its current revision, new IDs are inserted, and omitted active items move to Trash.

### Prompt retrieval (trusted service callers)

- `POST /api/prompt-retrieval/search`
- `GET /api/prompt-retrieval/health`
- `POST /api/prompt-retrieval/rebuild`

Search receives `query`, bounded `types`/`categories`, `limit`, and an authenticated service-supplied `callerKind`/`callerId`. It returns exact Prompt references with revision/digest evidence plus an audit ID; it never returns preset IDs, local paths, or raw asset paths. Gateway resolves the supplied `CVC-*` before invoking search. Rebuild is an explicit maintenance operation for migration or detected drift, not a normal write path.

## Trash Payloads

Project and preset Trash entries are API projections over records whose SQLite status is `trash`:

```json
{
  "id": "preset-1",
  "deletedAt": 1770000000000,
  "deletedBy": "user",
  "deleteReason": "optional",
  "payload": {}
}
```

Active list endpoints never return Trash entries.

## Migration

- `POST /api/migrations/browser-cache`

The request includes `migrationId`. Repeating a completed ID returns `alreadyApplied: true` without importing again. The complete import is transactional.

## Errors

Errors use FastAPI's `detail` envelope with `code`, `message`, optional `detail`, and optional `current`. Defined codes include `not_found`, `duplicate_item`, `revision_conflict`, `invalid_payload`, and `invalid_asset`.
