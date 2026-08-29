# Image Generation and Model Management

## Scope and invariants

PromptCard uses provider-neutral model connections and durable, local image-generation history. New work may be submitted from the project-level Image Generation tab or from an explicit selected-image operation workbench. A conversation turn binds `connectionId + modelId` and is independent from every earlier turn. A contextual operation binds an immutable recipe snapshot to a source image node and does not enter or mutate the right-side conversation. Legacy `image-generator` canvas nodes are read-only previews. The browser never receives a stored provider credential or talks directly to a provider SDK. [ADR-008](../decisions/ADR-008-provider-neutral-image-generation.md) records the provider boundary, [ADR-010](../decisions/ADR-010-project-image-generation-conversations.md) records the conversation and placement boundary, [ADR-013](../decisions/ADR-013-recoverable-image-generation-placeholders.md) records the stable-run placeholder lifecycle, and [ADR-015](../decisions/ADR-015-explicit-multi-view-request-groups.md) records explicit multi-view member semantics.

The Gateway must start, report health, and serve the model catalog without any configured credential. Credentials are read only for a valid model invocation. A valid request with no credential fails as `credential_missing`; keyring failure is `credential_store_unavailable`.

The Agent panel separates `Text models` and `Image generation models`, but both pages consume provider-neutral providers, catalog entries, connections, and assignments. Each page filters by modality and owns its default slot (`chat.primary` or `image.primary`). Text bindings are grouped first by `PI 原生` and then SDK family; image bindings are grouped by image SDK family and never receive chat entries. The Ark endpoint is fixed and read-only in the normal UI; connection forms support cancel, save-only, and save-and-test.

`GET /api/promptcard/runtime/model-connections/{connectionId}/models` returns the assignable catalog scoped to that connection's provider. For an Ark inference API Key this is the supported PromptCard provider catalog, marked `source: "provider-catalog"`; it is not an enumeration of private account endpoints. Ark account-management APIs require separately modeled AK/SK signing credentials, which are outside the current connection contract and must not be inferred from an inference API Key.

For text connections, `agentChatModelIds` selects the catalog subset exposed to project Agent conversations. The primary chat assignment is inserted automatically, while clearing `chat.primary` leaves the whitelist intact. Each durable conversation stores its own validated `{connectionId, providerId, modelId}`; the Gateway resolves it per request and records a model snapshot per idempotent turn. Media's temporary analysis dialog intentionally continues to use the default chat assignment.

The model catalog is the only source of frontend capability controls. Inspector code must not infer ratios, resolutions, region tools, formats, or reference limits from the Seedream model ID. [ADR-009](../decisions/ADR-009-capability-driven-image-model-readiness.md) records the readiness and diagnostics boundary.

## Readiness and diagnostics

An assignment is valid only when all of these conditions hold:

1. The connection is enabled and has a keyring credential.
2. Provider, model, modality, and assignment slot match.
3. The persisted latest connection test succeeded.
4. The provider runtime dependency is ready; Ark requires the exact compatible SDK version.

Changing provider, API base, credential, or enabled state invalidates the recorded test result. Test results do not expire by time; a later material configuration change or explicit test replaces them.

`GET /api/promptcard/runtime/image-generation-status` performs read-only re-detection. It reports the Runtime flag, keyring availability, provider readiness, and Ark package/installed/required/compatible state. It never installs dependencies or returns a command, local path, stack, credential, or raw provider body. Provider readiness is `ready`, `missing`, `incompatible`, or `check_failed`.

Connection deletion is dependency-aware. Assignment references are authoritative, while the current Gateway cannot yet query all canvas-node references from PromptCard Storage. It therefore reports `canvasNodeCount: null` and `canvasNodeCountAvailable: false`; the frontend fails closed instead of treating an unknown count as zero.

## Data flow

1. After validating and preparing the current turn, the project Image Generation tab creates a stable `image-run-<32 lowercase hex>` ID and a matching ordinary image placeholder. It persists the placeholder before sending any provider request. If that project save fails, the turn becomes a local failed placeholder and the Runtime is not called.
2. The tab submits the stable `runId` plus only the current turn's normalized prompt document, ordered local image inputs, roles (`source-image` or `reference-image`), optional original `sourceAssetId`, point/bounding-box regions, resolution/custom size, prompt-optimization mode, output format, watermark, `connectionId`, `modelId`, and `conversationId` through the browser boundary `POST /agent-api/promptcard/runtime/image-generations`. The shared Runtime HTTP client includes cookies, copies the CSRF cookie into `X-CSRF-Token`, and normalizes string/object error responses. The Gateway owns the internal `/api/promptcard/runtime/image-generations` route. Browser code must not send Runtime requests through Vite's vendor-facing `/api` proxy. It does not send prior messages. Legacy callers may send `nodeId` instead and may omit `runId`, in which case the Runtime generates one.
3. The Gateway creates a queued run in PromptCard Storage with that exact ID, transitions it to running, then validates connection metadata, catalog capability, prompt/region references, decoded local image assets, and request limits.
4. Only after validation does the Gateway retrieve the connection credential from the operating-system keyring and construct the selected provider adapter.
5. The Seedream adapter compiles ordered image mentions and region markup, sends an explicit watermark value, maps `standard`/`fast` to the SDK's native `OptimizePromptOptions`, and calls the Volcengine Ark SDK. It accepts exactly one URL or Base64 result; sequential, stream, web-search, mask, groups, and multi-output parameters are never sent.
6. URL result localization accepts only the documented official Seedream HTTPS output hosts (`ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com` and `ark-acg-cn-beijing.tos-cn-beijing.volces.com`), revalidates and pins a public DNS address on every redirect hop, preserves Host/TLS SNI, limits downloads to the same 200 MB ceiling accepted by Storage and 40 megapixels, and verifies PNG/JPEG/WebP bytes with Pillow. Base64 results pass the same byte, MIME, decode, and pixel checks before Storage receives them. Localization failures log only the normalized error code, local run ID, provider request ID, and sanitized hostname; signed URL paths and query strings are never logged.
7. PromptCard Storage stores the generated file as a local asset, creates a `generatedResult` Recent Capture, and commits the run as succeeded. Provider accounting is written through the Storage state-patch field `usage`; `providerUsage` is not part of that contract. Failures commit a normalized failed state. Provider URLs and credentials are never persisted.
8. The frontend fills the matching placeholder in place after success, or retains it as a failed placeholder after failure. It changes only the asset and generation metadata, so movement and resizing performed while the request was running are preserved.

## Contextual image-operation flow

Contextual operations reuse the same catalog, adapter, Runtime request and durable run boundaries without reusing right-workspace UI state.

1. Command availability is resolved only after selection narrows to one ready image node with an asset.
2. Opening a workbench resolves the visible canvas image. Crop, flip and annotations produce a persistent provider-input derivative; otherwise the existing provider-safe asset is reused.
3. The modal owns a transient `ImageOperationDraft`. Preset, reference, region and output changes do not call the provider.
4. Explicit Generate compiles an `ImageOperationRecipeSnapshot` containing product operation, recipe ID/version, original/canvas/provider source identities, preservation intents, parameters and optional multi-view group/item/view IDs.
5. The frontend creates and persists a `contextual-image-operation` placeholder before invoking Runtime. It has a stable run ID but no conversation ID.
6. The browser submits the normal provider-neutral image request with `nodeId` ownership and the operation snapshot. The right-side `Agent / 图片生成 / Prompt库` active tab and drafts remain unchanged.
7. Success fills the placeholder in place. Failure retains a terminal placeholder and safe error code. A single-operation retry creates a new run; multi-view retries follow the stricter member-binding contract below.

Product reference roles (`identity`, `style`, `material`, `layout`, `content`) belong to PromptCard recipes. The compiler translates them into ordered images and prompt instructions; the provider request receives only documented source/reference input roles.

Multi-view is N independent runs tied by one application group ID, not one native grouped-output request. Submission has three ordered phases: persist the complete placeholder canvas, atomically prepare every queued member run, then invoke the provider with concurrency one. A canvas-persist or batch-prepare failure results in zero provider calls. Group state is derived from member runs/canvas metadata, so partial success is durable without a schema-v8 group table. Results are AI-inferred views, not exact 3D reconstruction.

See [Contextual Image Actions](../frontend/contextual-image-actions.md) for frontend ownership, menus, workbenches, visible export and current verification state.

The request may contain at most ten total input images. Each provider input is limited to 30 MB and 36 million pixels, both sides must be greater than 14 pixels, and its aspect ratio must be within `1:16–16:1`; ten maximum-sized inputs therefore have a 300 MB aggregate ceiling. The Runtime permits two concurrent generations per connection and four globally. These are trusted server limits; frontend validation is only an earlier usability check.

Run snapshots and API errors may contain technical identifiers and normalized error codes, but never credentials, authorization headers, provider URL query strings, local filesystem paths, or raw exception text.

## Credential storage and platform requirements

Connection metadata lives at `$PROMPTCARD_RUNTIME_STATE_DIR/promptcard-model-connections.json`. It contains provider/model assignments and a `credentialRef`; the secret is stored by Python `keyring` under service `dev.promptcard.manager.shell` and username `connection:<connectionId>`. On first model-management access, the Gateway idempotently merges missing connection IDs and unassigned slots from the former sibling `.deer-flow/promptcard-model-connections.json`. Stable IDs preserve existing keyring references; no secret is copied into JSON and newer destination state is never overwritten.

The runtime account must have an available keyring backend:

- Windows: Credential Locker for the same interactive user that runs the Gateway.
- macOS: Keychain access for the Gateway user.
- Linux: an unlocked Secret Service or KWallet session. Headless services need an explicitly provisioned supported backend; plaintext fallback is not acceptable.

Run `npm.cmd run agent:check`. It imports `keyring` and the Ark SDK and prints a workspace-local repair command if dependencies are incomplete. The command sets `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, and `UV_PROJECT_ENVIRONMENT` inside this F: repository before running `uv sync`.

Do not use `API-Key.txt`, parse `sk-` strings, set `DEEPSEEK_API_KEY`/`ARK_API_KEY` in maintained PromptCard launchers, or persist credentials in `.env`, localStorage, IndexedDB, project JSON, SQLite, logs, or generated assets.

## Migration and transactional rollback

The deprecated model-config compatibility API writes through the same provider-neutral connection store and keyring. New text-Agent configuration assigns any compatible, tested chat connection to `chat.primary`; PI-native and SDK-backed text invocation are resolved independently from `image.primary`.

PromptCard Storage migrates schema v3 to v4 in place by adding permanent project conversations, nullable `conversation_id`/`node_id` run ownership, project/conversation indexes, and canvas placements. Old runs are deterministically grouped by `projectId + nodeId`; migration never creates placement work for old successful runs.

Schema v5 adds permanent `image_asset_derivations`. Official input formats are JPEG, PNG, WebP, BMP, TIFF, GIF, HEIC, and HEIF. The original upload is always retained. BMP/TIFF/GIF/HEIC/HEIF, rotated standard images, and visual annotations produce provider-safe PNG/JPEG derivatives; GIF/TIFF use the first frame/page, EXIF orientation is applied, and alpha is preserved through PNG. Derivations of kind `preview`, `provider-input`, and `annotation-flattened` strongly reference both source and derived assets. The migration does not delete projects, captures, presets, conversations, runs, placements, or assets and must not be rolled back below v5. See [ADR-011](../decisions/ADR-011-original-and-derived-image-assets.md).

Schema v6 adds asset lifecycle and deletion audit metadata. Original and derived files are managed as one family, and generated outputs take precedence when classifying a file that is also present in Recent Captures. Moving a family to file Trash preserves bytes and project readability; permanent deletion is blocked by active or recoverable project, canvas, Prompt, and preset references. Generation history does not block permanent deletion: it retains the request snapshot and exposes output availability so the UI can render a stable “local file deleted” placeholder. Storage capacity thresholds are warnings only and do not reject generation or automatically evict valid output.

Schema v7 adds project-scoped resource folders and subject/material records. The three image identities retained by a resource—original source, UI preview, and provider-ready input—are strong references. Only an explicit Subject Library action can append the provider-ready identity to an in-memory Composer draft; material organization and canvas placement never mutate or submit an image-generation request.

Schema v9 retains durable text-Agent conversations and the minimal Skill registry, and adds persistent conversation-level text-model bindings. These tables are independent from image-generation conversations, runs, and placements and do not change their lifecycle rules.

Schema v9 adds nullable conversation-level `model_binding_json` and keeps all image-generation tables unchanged. Model connection state version 2 adds `agentChatModelIds`; version 1 state migrates in place by adding the existing `chat.primary` model to the owning connection whitelist.

## History capacity, backup, and restore

Generation runs use `queued -> running -> succeeded|failed`; terminal rows are immutable. Image-generation project conversations are projections over immutable run snapshots rather than a duplicated chat transcript. A blank image-generation conversation exists only in frontend memory; its first queued run and conversation row are created in one Storage transaction. Conversations and runs remain queryable after a canvas node or project is removed because history is an independent consistency boundary. List requests are cursor-paginated and accept 1-100 rows per page. There is no automatic total-count or age-based pruning, so permanent-history capacity is the available disk space for SQLite plus generated assets.

Each submitted foreground turn first creates an ordinary image node identified by `free-image-generation-${runId}`. Its `generationRunId`, `conversationId`, `generationState`, and source metadata are durable project data. A running placeholder is movable and resizable but cannot be deleted or opened in image-editing tools. Success fills that same node without replacing its frame; failure preserves a deletable failed placeholder with a safe error code.

Each successful conversation run also creates a `pending` canvas placement. When that project is active, the frontend checks for an existing ordinary image node with the same `generationRunId`, hydrates it when present, and creates a result node near the real viewport center only for legacy runs that have no placeholder. The project must be saved before the placement advances to `placed`. Returning to a project reconciles running placeholders against the durable run and resumes pending work idempotently; a missing run becomes `generation_run_missing`, and a successful run without an output asset becomes `generation_output_missing`. Deleting an already placed node never reopens the placement. Canvas selection, edge changes, reload, and node edits never invoke the provider.

PromptCard Storage backups include the SQLite database, assets directory, and a manifest. From the repository root:

```powershell
python -m promptcard_storage.maintenance --data-dir data backup backups\manual-image-generation
python -m promptcard_storage.maintenance --data-dir data restore backups\manual-image-generation
```

Stop writers before restore. Restore validates schema/integrity and creates a pre-restore snapshot when live storage exists. The Storage backup does not contain operating-system keyring secrets or `$PROMPTCARD_RUNTIME_STATE_DIR/promptcard-model-connections.json`; after moving to another OS user/profile, restore non-secret connection metadata separately and re-enter credentials through model management.

## Seedream 5.0 Pro contract

The authoritative source snapshots for this contract are indexed in [Seedream 官方参考资料](../references/volcengine/seedream/README.md). Check the online document timestamp before changing provider mappings or advertised capabilities.

| Capability | Supported contract |
| --- | --- |
| Modes | `generate`, `edit`, `region-edit` |
| Reference images | 0-10, unique `referenceId` and order; prompt mentions compile to ordered image labels |
| Regions | point or bounding box, integer coordinates 0-999; bounding-box minimums must be less than maximums |
| Resolution | 1K or 2K |
| Aspect ratio | smart, eight documented presets, or custom dimensions within 921600–4624220 pixels and `1:16–16:1` |
| Prompt optimization | `standard` (default) or `fast` |
| Input formats | JPEG, PNG, WebP, BMP, TIFF, GIF, HEIC, HEIF through original + provider-derivative import |
| Visual markup | freehand, arrow, rectangle, ellipse, and text; saved non-destructively and rasterized to a derived image |
| Output | exactly one PNG or JPEG; no streaming |
| Provider response transport | URL or `b64_json`, selected by the backend adapter rather than the ordinary UI |
| Watermark | boolean request option |
| Native mask/cancel/4K | not advertised by the current adapter |

Region edit uses Seedream prompt markup tied to a reference image. It is not a native binary mask-upload workflow.

The frontend exposes four user workflows over the three provider modes:

- text to image -> `generate` without required image input;
- reference generation -> `generate` with ordered reference images;
- smart edit -> `edit` with a source image;
- region edit -> `region-edit` with a source image and point/bounding-box instruction.

A non-empty local PromptDocument overrides an upstream prompt connection; upstream text is used only when the local document is empty. Structured `@` tokens persist stable `referenceId` values. Reordering modifies `order`, and the Runtime compiler derives the current `图N` labels from that order. Removing an image does not silently remove its token; the unresolved token blocks generation until it is removed or rebound.

## Composer v2 interaction and validation boundary

The project Image Generation tab uses one fixed, rounded Composer rather than separate prompt, reference, and parameter forms. Its attachment strip contains the add action and the current ordered images; the middle is one auto-sizing textarea; the bottom row contains capability-driven workflow, model, size, reference, advanced-setting, count, and submit controls. Workflow/model/size/advanced options open on demand. The ordinary surface must not expose unsupported 4K, multi-output, subject-library, group, sequential, streaming, cancellation, or native-mask controls.

Attachments have three explicit sources: injection of the current canvas selection, local upload, and `加入本轮` from the active project's Subject Library. Local upload may start from the attachment picker or from external image files dropped anywhere inside the right image-generation workbench; both paths append ordered draft references, enforce the active model's reference limit, and never submit a request. Selection injection is disabled when there is no eligible selection and never happens as a side effect of selecting, moving, connecting, restoring, or editing a canvas node. Subject Library append uses the provider-ready asset plus original `sourceAssetId`, rejects duplicate asset IDs and model-limit overflow, opens the image-generation panel, and never submits a request. Project materials are not a Composer source: their internal drag payload is accepted only by the central canvas, not by the right workbench. Each attachment keeps a stable `referenceId`, explicit order, source/reference role, and optional visual annotations. Reordering changes only compiled `图N`; per-image annotation actions pass the exact `referenceId` back to `FreeCanvasBuilderScreen`.

`ReferencePromptEditor` remains a textarea, not a rich-text surface. `reference-prompt-document.ts` is the pure coordination layer between visible text, mention ranges, and persisted `PromptDocument` segments:

- typing ASCII `@` outside IME composition opens candidates from the images already present in the current draft;
- name filtering, pointer selection, Arrow Up/Down, Enter/Tab, Escape, and the toolbar `@` action share the same insertion path;
- inserting a candidate writes readable `@label` text while retaining `{ type: "reference", referenceId, label }`;
- ordinary edits are reconciled through the longest common prefix/suffix; an edit that intersects a mention degrades that mention to plain text;
- duplicate mentions may point to the same stable `referenceId`;
- removing an attachment leaves its mention unresolved, exposes a focused error, and blocks generation until the mention is removed or rebound.

Composer validation has separate blocking and presentation channels. `blockingRequirements` is authoritative for submit-button enablement and includes empty prompt, readiness, connection, reference, workflow, region, and size checks. `missingRequirements` contains only issues useful inside the Composer. An untouched empty prompt and model-readiness guidance are intentionally quiet in the Composer: the send button remains disabled, while readiness remediation stays in the session header. Invalid custom dimensions, unresolved mentions, missing workflow inputs, and missing regions remain visible near the send action. Runtime validation remains authoritative even when a frontend issue is intentionally not rendered.

## Atomic multi-view preparation and recovery

Multi-view remains a group of independent single-image runs; it is not represented as a Provider-native batch and does not claim exact 3D reconstruction. Its submission boundary is deliberately three-stage: the browser creates stable group/item/run/view identities and persists the complete placeholder canvas; it then atomically prepares all run rows; only after both stages succeed does it start provider work with concurrency one. The prepare stage is:

```text
POST /agent-api/promptcard/runtime/image-generation-batches/prepare
```

The request contains 1-11 complete `ImageGenerationRequest` members. Gateway requires one project, source node, connection, model, operation group, and unique run/item/view identities. Preparation does not read credentials, load Provider state, or invoke a Provider. It delegates to `POST /api/image-generation-runs/batch`, which inserts every queued run in one SQLite transaction. If preparation fails, no member is submitted to a provider. The current Storage schema is v16, but multi-view still introduces no group table; the v10-v16 reference/context-pack/Skill changes do not alter image-run preparation.

After preparation succeeds, the browser uses the existing single-member `POST /image-generations` boundary and schedules exactly one provider request at a time. A prepared run is claimable only when its project/node or conversation identity, connection/provider/model identity, immutable request snapshot, and empty output identity match exactly and its state is `queued`. A mismatch returns `run_conflict`; an already running or terminal run returns `run_already_started`. Neither path overwrites the existing record.

On reload or project switch, persisted placeholders are reconciled with Storage by both `generationRunId` and canvas `nodeId`. `queued` authorized multi-view runs rebuild the same provider-neutral request from the immutable snapshot and resume sequentially; `running` runs only poll; terminal runs hydrate or fail the existing node in place. Browser-local active/scheduled run-ID sets plus node-ID matching prevent duplicate provider work and duplicate placement.

A failed-member retry is authorized by the clicked failed `nodeId` and remains bound to that member's group ID, item ID, view specification, original/canvas/provider source identities, and source node identity. The retry replaces the run metadata on that same canvas node with a new run while preserving node ID, position, width and height. The old failed run remains immutable in Storage, and successful group members are never resubmitted.

## Common operational errors

| Code | Meaning / action |
| --- | --- |
| `credential_missing` | Configure the selected connection; startup remains healthy. |
| `credential_store_unavailable` | Fix/unlock the OS keyring and rerun `agent:check`. |
| `connection_disabled`, `connection_not_tested`, `connection_test_failed` | Enable and successfully test the selected connection before assigning it. |
| `assignment_missing`, `provider_model_mismatch` | Select a compatible provider/model for the requested modality slot. |
| `ark_sdk_missing`, `ark_sdk_incompatible`, `ark_sdk_check_failed` | Repair the workspace-managed dependency outside the API, then re-run diagnostics. |
| `invalid_size`, `invalid_input`, `missing_reference`, `region_coordinate_out_of_range` | Correct the request before credential access/provider invocation. |
| `rate_limited`, `timeout`, `service_unavailable`, `generation_failed` | Retry according to `retryable`; inspect provider account/quota without logging secrets. |
| `unsafe_image_url`, `image_download_failed`, `invalid_image_data` | Provider output failed the remote-result security/decoding boundary. |
| `storage_write_failed`, `terminal_persistence_failed` | Verify PromptCard Storage health and disk space before retrying. |
| `image_generation_disabled` | Enable the trusted server rollout flag only after dependencies and a connection are ready. |
| `input_images_too_large` | Reduce the aggregate bytes of all source/reference images below 300 MB and keep every image at or below 30 MB. |
| `generation_busy`, `generation_capacity_reached` | Wait for the per-connection or global concurrency slot to become available. |
| `invalid_operation_context`, `invalid_operation_source`, `invalid_operation_mode`, `invalid_operation_group` | Rebuild the contextual operation from the current source and recipe; rejection occurs before run creation, credentials, and Provider invocation. |
| `run_conflict` | Do not reuse the run ID; create a new operation attempt. |
| `run_already_started` | Do not resubmit; poll the existing run to a terminal state. |

## Adding a second image provider

1. Add provider metadata and model capability records to the catalog. Keep UI decisions capability-based rather than branching on provider names.
2. Implement `ImageGenerationProvider` to translate the normalized request, compile provider-specific prompts, enforce output count, and normalize errors without raw secrets.
3. Extend the provider factory/connection validation for the new provider. Keep credential access behind `ConnectionResolver` and keyring.
4. Add an exact result-host allowlist or a provider-owned localization strategy; never weaken DNS pinning, redirect checks, byte/pixel limits, or MIME/decode validation.
5. Add contract, adapter, orchestration, redaction, and end-to-end tests before exposing the model in the canvas.
6. Document capability differences and operational dependencies here and in the backend catalog docs.

## Rollout and rollback

New generation requires both rollout gates:

- frontend user settings: `meta.featureFlags.imageGenerationNodeV1 === true`;
- Agent Runtime environment: `PROMPTCARD_IMAGE_GENERATION_NODE_V1=true`.

The Runtime itself treats an absent server flag as disabled and checks it before run creation, credential access, or provider invocation. The combined development launcher sets the server flag to `1` when no explicit override is present; production deployment must opt into its own rollout. The frontend flag defaults on in development and off in production unless a persisted setting overrides it. Run `npm.cmd run agent:check`, create and successfully test a Volcengine Ark connection, and assign it to `image.primary` before real-provider smoke testing. Disabling either gate stops new UI generations but leaves existing nodes, connection metadata, run history, Recent Captures, and assets readable.

Never roll the active PromptCard Storage database back below schema v16. A code rollback must preserve forward-compatible reading of image-generation conversations, text-Agent conversations and model bindings, public references, context packs, canonical Skill packages, exact-revision reviews, host pins, document resources, cleanup attempts, runs, placements, originals, derivatives, lifecycle state, project resources, and tombstones or keep the current Storage service running until compatible code is restored.
