# ADR-021: Keep Project Documents Local And Provider Files Ephemeral

## Status

Accepted. Implementation status: Task 15.8 and the dependent Task 15.10 flow are implemented and technically accepted as the regression baseline; Checkpoint 3.5 manual probes are merged into final real-Codex acceptance and Task 16 is in progress.

## Date

2026-08-27

## Context

The existing asset store and project resource library are image/video-oriented. Project resources are `subject` or `material` records with image dimensions and provider asset identifiers. Extending those records with planning documents would weaken validation, mix unrelated lifecycle rules, and make document content appear eligible for image and Prompt media paths.

The first creative-document release must accept TXT, Markdown, PDF, and DOCX. Doubao Seed 2.0 Lite supports PDF input through Ark Responses and Files APIs; PDF pages are processed visually as well as textually, which also covers scanned PDFs. The existing Ark adapter uses Chat Completions and only accepts text/image blocks, so file-bearing calls require an isolated adapter rather than a silent expansion of every provider path.

## Decision

1. **Local PromptCard storage is canonical.** Each uploaded document is validated and stored locally before an Agent request can reference it. Model-provider file IDs are temporary transport handles, never the project asset identity.
2. **Documents and remote cleanup land together in schema v16.** The one v15 -> v16 migration adds both `project_document_resources` and `provider_file_cleanup`; there is no later mutation of the meaning of schema v16. Documents do not add a kind to image `project_resources`. Backup/restore, health diagnostics, and migration tests cover both new tables before either Gateway adapter consumes them.
3. **The accepted formats and budgets are fixed for the first release.** Accept UTF-8 TXT/Markdown up to 5 MiB, DOCX up to 20 MiB, and PDF up to 50 MiB; allow at most five document attachments and 100 MiB aggregate per turn. Extension, declared MIME, signature/container structure, project ownership, and current lifecycle must all agree.
4. **Local extraction is format-specific.** TXT/Markdown use strict UTF-8 decoding and reject NUL/binary content. DOCX uses exactly `python-docx==1.2.0` to extract paragraphs and tables in document order after ZIP/Office structure, encryption, expansion-ratio, entry-count, and total-uncompressed-size checks. Embedded executables and remote relationships are ignored and never fetched.
5. **PDF uses an Ark Responses file-bearing adapter.** For each invocation that explicitly attaches a PDF, Gateway reads the project-scoped local asset, uploads it through Ark Files, invokes Responses with the resulting file ID and the same bounded text/tool policy, then deletes the remote file in `finally`. The existing Chat Completions adapter remains unchanged for ordinary no-file turns and providers without file support.
6. **Remote cleanup is durable but minimal.** Failed deletion creates a `provider_file_cleanup` record containing only provider/connection identity, opaque remote file ID, creation/attempt timestamps, retry count, and a redacted error code. Startup and bounded retry processing repeat deletion. UI and ordinary logs never expose the remote file ID, local path, credential, or raw provider body. A provider expiry is set as a secondary safety net when supported, but it does not replace explicit deletion.
7. **Unsupported capability fails explicitly.** A PDF attached to a provider/model without the declared document-input capability returns `document_input_not_supported` before model invocation. The system does not silently OCR, switch providers, or change semantics. TXT/Markdown/DOCX normalized text may be used by compatible text models within the same budgets.
8. **The browser sends identities, not paths or provider handles.** Agent requests contain project document resource IDs only. Gateway resolves scope and bytes. Raw filesystem paths, browser object URLs, and provider file IDs never cross the public frontend contract.

## Alternatives Considered

### Add Documents To Existing Image Project Resources

Rejected because it would require meaningless dimensions/provider-image fields and would expose documents to image-specific UI and lifecycle logic.

### Send Browser Base64 Files Directly To The Model Runtime

Rejected because it bypasses project ownership, durable local identity, size enforcement, retry cleanup, and path/credential redaction.

### Parse Every PDF Locally

Rejected for the first release because the selected Ark model provides native visual PDF understanding, including scanned pages. A local OCR/parser fallback would add dependencies and produce different semantics across providers.

### Keep Ark Files Until Provider Expiry

Rejected because the user selected per-invocation deletion and the local asset is the only canonical copy.

## Consequences

- Storage gains a dedicated document validator/store and schema v16 migration; image asset and project-resource APIs stay compatible.
- Gateway gains a file-bearing Ark Responses adapter and cleanup reconciler; existing Chat Completions behavior remains the default.
- Reusing the same PDF in a later turn performs a new upload and deletion.
- Model capability metadata must distinguish document/PDF input from image input.
- DOCX fidelity is intentionally bounded to planning text and tables; layout, macros, embedded media, and tracked Word changes are not preserved.

## Verification

- Storage tests cover valid TXT/MD/PDF/DOCX, MIME/signature mismatch, invalid UTF-8, NUL bytes, corrupt/encrypted DOCX, ZIP bombs, oversize/count limits, project isolation, Trash, and backup/restore.
- Gateway tests prove PDF upload -> Responses -> `finally` delete, deletion retry after failure/restart, redacted diagnostics, and no Chat Completions regression.
- Provider tests prove unsupported PDF fails before invocation and normalized TXT/MD/DOCX remains bounded.
- Browser tests prove upload/drag-drop stores locally first and sends only document resource IDs.

## References

- [Doubao Seed 2.0 Lite: Responses and PDF input](https://www.volcengine.com/docs/82379/1795150)
- [Volcengine Responses API: Files and PDF document understanding](https://volcengine.github.io/veadk-python/cn/docs/framework/agent/responses-api/)
- [python-docx 1.2.0](https://pypi.org/project/python-docx/)
- [ADR-020: Separate Planning Documents From Executable Prompt Content](./ADR-020-separate-planning-documents-from-prompt-execution.md)
