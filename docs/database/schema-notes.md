# Schema Notes

Core frontend schemas:

- `ICard`
- `IPreset`
- `IPromptProject`
- `IStoryboardProject`
- `IThreeStageProject`
- `IThreeStagePage`
- `IThreeStageItem`
- `IThreeStageForm`
- `PromptLibraryWriteProposal`
- `AgentWorkspaceProposal`
- `AgentConversation`
- `AgentConversationMessage`
- `AgentConversationProposal`
- `AgentSkill`
- `AgentSkillRevision`
- `RecentCaptureItem`
- `RecentCaptureItemViewModel`
- `IFreeCanvasImageGeneratorNode`
- `ImageGenerationRun`
- `ImageGenerationConversation`
- `ImageGenerationCanvasPlacement`
- `ImageAssetDerivation`

Schema changes should be documented with migration or normalization behavior. The current PromptCard Storage schema is v19. Prefer extending `meta` for Prompt Library metadata rather than changing the top-level `IPreset` shape.

## Prompt Retrieval Index And Audit

Storage schema v18 adds the canonical `presets.retrieval_digest`, `prompt_retrieval_documents`, its external-content FTS5 index, lifecycle triggers, and `prompt_retrieval_audits`. Prompt create/update/trash/restore/delete and the lexical index update in the same SQLite transaction. Store writes calculate the digest before SQL execution, so triggers do not depend on a connection-private SQLite function; an out-of-band payload edit leaves a stale digest and is rejected by freshness validation. The v17-to-v18 migration creates the structures and explicitly rebuilds them from canonical active and trashed Prompt rows without changing Prompt identity or revision.

Search accepts at most 256 query characters, 16 type/category filters, and 20 results. Returned evidence is capped at 12,000 characters and contains only exact `PLP-*` identity, revision/digest, bounded text, score components, matched fields, reason, and safe `PLM-*` media metadata. Before returning each candidate, Storage compares the indexed revision/digest with the canonical Prompt row; stale candidates are rejected, counted, audited, and mark the response degraded. Audit rows retain a query digest and result codes rather than raw query text.

## Bridge Delivery Ledger

Storage schema v19 adds `bridge_delivery_ledger`. Its primary key is the trusted Bridge `profileId` plus client request ID; operation, normalized digest, exact CVC target/source manifests, trusted scopes/client audit metadata, `promptcard-bridge` provenance, state, result, and timestamps persist in one row. The same key and digest replays the first durable status, while a different digest or operation returns `delivery_conflict`. New rows validate an active, unrevoked CVC at its snapshotted project revision before entering `processing`; interrupted rows can be reconciled to a durable `delivery_interrupted` failure. Existing results remain inspectable after later context revocation, but no new operation can use the revoked or stale context. The v18-to-v19 migration creates the table and indexes atomically and never rewrites project JSON.

## Typed Creative References

Storage schema v17 adds `creative_references`, a dedicated stable-reference registry for current Canvas planning objects:

- `CVD-*` identifies an active Canvas Document;
- `CVS-*` identifies an active Canvas Storyboard.

The table binds one namespace/project/node tuple to one public code without writing that code into project JSON. Fresh databases reconcile supported nodes on startup, and the v16-to-v17 migration creates then reconciles the table transactionally. Resolution is project-scoped and returns only a bounded typed projection: Document AST plus revision/digest, or Storyboard sequence/rows with public source references and row ordinals. Canvas node IDs, row IDs, model bindings, coordinates, arbitrary metadata, and filesystem paths are not exposed. Context packs may snapshot these two namespaces as immutable typed entries; the public code remains stable across project reload and process restart.

## Three-stage Project Shape

`IThreeStageProject` is stored inside `IPromptProject.threeStage`. The durable JSON format may contain both the current page-based model and legacy compatibility fields.

Current fields:

- `pages?: IThreeStagePage[]`
- `selectedPageId?: string | null`
- `selectedFormId?: string | null`
- `selectedPairId?: string | null`

Compatibility fields:

- `character: IThreeStageSection`
- `storyboard: IThreeStageSection`
- `videoPrompt: IThreeStageSection`
- `selectedStage`
- `selectedFieldId`

The compatibility fields are synchronized from the selected page/form by `syncThreeStageLegacyFields()`. New code should not treat them as the source of truth for multi-page or multi-form behavior.

`IThreeStagePage.items` stores independent form items:

- `form`: contains one independent `IThreeStageForm` with `type` set to `character`, `object`, `storyboard`, or `videoPrompt`.

Legacy readers may still encounter `character` and `storyVideoPair` item shapes. `normalizeThreeStagePages()` converts them into adjacent independent `form` items. New code must not create or depend on `storyVideoPair`.

Normalization behavior:

- Old fixed three-stage projects migrate into one page with independent character, storyboard, and video-prompt forms.
- Legacy `storyVideoPair` items split into adjacent independent storyboard and video-prompt forms.
- Form numbering is monotonic per form type and is not compacted after deletion.
- `selectedPairId` is retained only for input compatibility and is synchronized to `null`.

## Asset Lifecycle And Classification

PromptCard Storage schema v6 adds lifecycle metadata to each asset:

- `lifecycle_status: "active" | "trash" | "deleted"`
- `trashed_at?`, `trashed_by?`, and `trash_reason?`
- `deleted_at?`

Existing assets migrate to `active` without changing their files. Image derivation relationships form an asset family: source, preview, provider-input, and annotation-flattened files are counted and lifecycle-managed together, while the Files page lists only the user root asset.

Source classification is derived from current references in priority order: successful generation output, Recent Capture/external media, project/Prompt/preset material, then other or orphaned files. An asset in Trash is hidden from active Files and Media lists but remains readable for existing references. Permanent deletion requires Trash state, refuses strong project/Prompt/preset dependencies, removes family bytes, and retains metadata as a tombstone. Generation runs remain immutable; their `outputAssetStates` projection marks deleted or missing local outputs without removing run parameters.

## Project Resource Tables

PromptCard Storage schema v7 adds `project_resource_folders` and `project_resources`. Both rows carry `project_id`; project permanent deletion cascades their metadata, while project Trash retains it unchanged.

Folders use nullable `parent_id`, integer `sort_order`, and optimistic `revision`. The application rejects cycles and non-empty deletion. Resources use `kind: "subject" | "material"`, name, source/preview/provider asset IDs, decoded dimensions, MIME type, nullable folder, order, and revision. Subject folders are prohibited by a database check, and `(project_id, kind, source_asset_id)` is unique.

All three asset IDs are foreign-key and diagnostics references. Removing a resource never deletes those assets. Layout changes validate every supplied revision and commit parent/folder/order changes in one transaction.

## Agent Conversation And Skill Tables

PromptCard Storage schema v9 introduced SQLite as the durable authority for project Agent conversations and the minimal Skill registry. It added nullable `agent_conversations.model_binding_json`; all v8 conversation and Skill tables remain unchanged.

Project conversation tables:

- `agent_conversations` stores the owning `project_id`, `entrypoint`, `mode`, title, `active | trash` status, lifecycle timestamps, and optional conversation-level model binding. It is separate from image-generation conversations.
- `agent_conversation_messages` stores ordered user, assistant, and tool-visible records. Visible text, normalized content blocks, and tool summaries are retained so Gateway can reconstruct bounded model history after any process restart.
- `agent_conversation_proposals` stores proposal payloads and `pending | approved | rejected` status against the originating message. Reloading a conversation therefore restores both the transcript and unresolved approvals.
- `agent_conversation_turns` keys each completed turn by `(conversation_id, request_id)` and stores the response envelope, including the first invocation's model snapshot, used for idempotent retry handling.

Every conversation lookup is project-scoped. Moving a conversation to Trash retains its messages, proposals, and completed turns; permanent deletion is accepted only from Trash and cascades those child rows. Permanent project deletion also cascades its Agent conversations. Media analysis does not write any of these tables.

Skill registry tables:

- `agent_skills` stores the stable Skill identity and slug, source, trust state, capability binding, declared Runtime tool dependencies, active revision, and lifecycle timestamps.
- `agent_skill_revisions` stores immutable revision content, digest, instructions, allowed references, and creation metadata. A digest identifies the exact snapshot supplied to a run.

Schema v9 keeps the trusted first-party `canvas-prompt-editor` and `media-prompt-reverse` Skills. `canvas-prompt-editor` revision 3 is current; revisions 1 and 2 remain immutable for audit and persisted-proposal compatibility. First-party Skills are read-only through the public Storage API. External Skills may be registered and revised, but the initial implementation supplies only their instructions and references to the local text Agent; it does not execute Skill scripts.

## Public References, Context Packs, And Canonical Skill Packages

Schema v10 adds `public_references`. Public `PREFIX-ULID` codes are stored uppercase with case-insensitive lookup and map a namespace plus owner scope to an existing internal identity. The public code is an adapter contract, not a replacement primary key. Startup reconciliation backfills and repairs required mappings without changing internal IDs.

Schema v11 adds immutable `context_packs` addressed by `CVC`. A pack records its exact `PRJ`, project revision, entries, source codes/boundaries, placement hint, digest, and creator. Its snapshot fields cannot be updated or deleted; revocation is a one-way lifecycle transition. Schema v12 also prohibits `INSERT OR REPLACE` from replacing an existing pack.

Schema v13 upgrades the Skill registry to canonical packages:

- `skills` gains `active | archived` lifecycle and archive time;
- `skill_revisions` gains digest version, legacy digest, provenance, and declared capabilities;
- `skill_package_entries` stores ordered immutable `instruction`, `reference`, `script`, and `asset` bytes with canonical path, content type, size, and digest.

Migration converts every legacy instruction/reference revision into canonical entries, retains its legacy digest for audit, and protects package/revision content with immutability triggers. Canonical storage does not authorize execution: local-Agent snapshots still omit scripts and assets.

## Independent Skill Host Pins

Schema v14 adds `skill_host_pins` with primary key `(skill_id, host, scope)`. Supported hosts are `codex` and `local-agent`. The local-Agent scope must be empty; a Codex scope is a non-empty configured repository key. Each row stores enabled state, exact pinned revision and digest, optional Codex projection metadata, and update time.

The `(skill_id, pinned_revision)` foreign key prevents a pin from naming a missing immutable revision. Insert/update triggers additionally require `pinned_digest` to equal that revision's digest. Codex projection metadata is prohibited for local-Agent pins. Built-in Skills receive an exact enabled local-Agent pin during initialization; no host follows `skills.current_revision` implicitly.

Codex files remain derived filesystem state rather than SQLite rows. Cross-instance lock files and a prepared filesystem journal compensate around the database commit; recovery finalizes when SQLite matches the desired pin, rolls back when it matches the prior pin, and retains evidence with `recovery-required` when neither state is provable. SQLite and filesystem rename are not claimed to be one hardware-atomic transaction. See [Skill Host Pins And Projections](../architecture/skill-host-projections.md).

## Exact Revision Trust Reviews

Schema v15 adds `skill_revision_reviews` with primary key `(skill_id, revision)`. Each row stores the canonical revision digest, `trusted | untrusted` decision, and review time. A composite foreign key ties the review to an immutable revision, while insert/update triggers reject a digest that does not equal the canonical `skill_revisions.digest`.

Migration seeds reviews only for revisions whose Skill was already `first-party` or `trusted`; first-party trust is normalized to the review state `trusted`. New external revisions do not inherit another revision's review. Host enablement and Codex repair require the exact `(skill_id, revision, digest)` to remain trusted as well as the Skill's global trust state to permit use. Marking a review untrusted blocks future snapshot execution and repair, but explicit disable/unpublish remains available so revoked or archived content can be removed safely.

## Project Document Resources And Provider Cleanup

Schema v16 adds both `project_document_resources` and `provider_file_cleanup` in one migration.

`project_document_resources` stores the project owner, opaque resource ID, repository-relative local path, original filename, validated content type and size, byte digest, extraction kind/status, normalized text and its digest when applicable, optimistic revision, lifecycle state, and timestamps. It is separate from image `project_resources`, Prompt media, provider identities, and Canvas nodes. Project Trash preserves rows; permanent project deletion cascades their metadata and locally owned document bytes through the document-store cleanup path.

`provider_file_cleanup` stores the minimum durable state required to retry a failed ephemeral provider-file deletion: cleanup/provider/connection identity, remote file identity, attempt timestamps/count, next-attempt time, and one redacted error code. Internal reads may supply the remote identity to the authenticated Gateway worker, but health diagnostics, browser APIs, logs, and public error responses expose only bounded counts or safe codes.

Gateway uploads each PDF for one invocation and attempts deletion in `finally`. A failed deletion is idempotently enqueued; Gateway startup drains due rows with bounded retry/backoff and deletes the row only after provider deletion succeeds or is already complete. Schema v16 does not authorize OCR, permanent provider storage, or a second document authority.

## Recent Capture Shape

`RecentCaptureItem` is durable metadata stored by the local storage service. It references the physical asset file by `assetId`; it does not duplicate image bytes inside project JSON or capture JSON.

Current durable fields:

- `id`
- `assetId`
- `kind: "screenshot" | "pastedMedia" | "screenRecording"`
- `status`
- `purpose`
- `role?: string | null`
- `title`
- `prompt`
- `userNote`
- `sourcePlatform`
- `sourceUrl`
- `contentType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4"`
- `originalFilename?`
- `registeredPromptId?`
- `registeredAt?`
- `linkedProjectId?`
- `linkedCanvasNodeId?`
- `durationMs?`
- `hasAudio?`
- `size`
- `width`
- `height`
- `capturedAt`
- `origin`
- `createdAt`
- `updatedAt`
- `revision`

The current producers create native `screenshot` records and clipboard `pastedMedia` records. `screenRecording` and `video/mp4` are reserved by the schema for the final recording phase, but no recording producer is implemented yet. Raw Recent Capture items are not Agent-visible or Prompt Library-visible until the explicit transaction registration flow creates a Prompt preset and writes `registeredPromptId`.

UI code converts durable records to `RecentCaptureItemViewModel` through the media normalization helpers. Preview surfaces resolve image thumbnails from `storage.assets.url(assetId)`. Prompt `meta.media` and Free Canvas image nodes retain that same `assetId`; linkage fields record relationships but never represent additional physical files.

## Image Generation Conversation, Legacy Node, And Run Shapes

New generation work is owned by the project-level Image Generation conversation UI. Its unsent `ImageGenerationComposerDraft` is frontend-only and contains the current `PromptDocument`, ordered image inputs, input roles, regions, selected model binding, resolution/ratio/custom size, prompt optimization, format, watermark, and optional annotation document. A draft is cleared after submission except for retained model/size preferences; it is not durable history.

`IFreeCanvasImageGeneratorNode` remains a compatibility shape persisted inside older `IPromptProject.freeCanvas.nodes` records with `kind: "image-generator"`. It stores the former provider-neutral intent:

- `mode: "generate" | "edit" | "region-edit"`
- `binding: { connectionId, modelId }`
- `settings: { resolution, aspectRatio, width?, height?, outputFormat, watermark }`
- `promptDocument` with versioned text/reference segments
- `regions` with stable `referenceId` and normalized point/bbox coordinates
- optional `activeRunId` and `primaryAssetId`

Legacy Free Canvas edges persist `targetHandle`, input order, and stable `referenceId`. Those fields remain part of project normalization so old projects load without loss. The node is now read-only: no Inspector, node mutation, edge change, reload, or selection event may invoke image generation. Its only creation action is an explicit user command that opens the project Image Generation tab and pre-fills a new draft.

`ImageGenerationRun` is not embedded in the project. PromptCard Storage persists it independently with:

- project plus conversation or legacy node identity, connection/provider/model identity;
- immutable `requestSnapshot` containing structured prompt, ordered input assets, regions, and settings;
- `queued`, `running`, `succeeded`, or `failed` state and lifecycle timestamps;
- local `outputAssetIds` for success, or a normalized error for failure;

`ImageGenerationConversation` stores project-scoped title/timestamps and derives latest-run, preview-asset, and turn-count summaries from runs. `ImageGenerationCanvasPlacement` stores one successful conversation run as `pending` or `placed` with its ordinary image node ID. Neither record has a normal delete transition.

Runs may additionally contain an optional provider request ID and sanitized numeric usage fields.

Terminal runs are immutable and have no DELETE endpoint. Run snapshots reject sensitive field names and never contain credentials, provider temporary URLs, or local filesystem paths.

`ImageAssetDerivation` records a permanent source/derived relationship:

- `sourceAssetId`
- `derivedAssetId`
- `kind: "preview" | "provider-input" | "annotation-flattened"`
- conversion/transform metadata
- optional `ImageAnnotationDocument`
- creation timestamp

Original and derived assets are both strong references for diagnostics and backup/restore. Visual annotations are non-destructive documents with normalized coordinates; the submitted provider image is a separately stored rasterized derivative.
