# PromptCard Bridge contract v1

This directory is the repository-neutral, language-neutral public contract shared by future Gateway, CLI, and MCP adapters. `manifest.json` declares the single contract version and every supported schema entry point; `schema.json` is a JSON Schema 2020-12 resource bundle.

## Public references

Public references use `PREFIX-ULID`: `PRJ`, `PLP`, `PLM`, `CVT`, `CVM`, `CVC`, or `SKL`, followed by a hyphen and a 26-character ULID. The ULID's first character is limited to `0`–`7`, preserving the standard 128-bit range. Contract inputs accept either letter case. Contract producers must normalize codes to uppercase before persistence or output.

Prefixes are semantic namespaces, not interchangeable labels. In particular, `PLM` and `CVM` remain different identities even when they describe identical bytes. Internal database keys are neither accepted nor exposed by these schemas.

Exact execution targets use the `exactReferenceInput` entry point, which accepts only a typed public code string. A `searchResult` is discovery output and cannot be supplied where an exact execution target is required.

## Delivery boundary

`proposal` describes a non-mutating candidate. `delivery` is limited to the additive kinds declared by `additive-kind.schema.json`; it cannot express update, replace, or delete behavior. Every delivery requires:

- caller-supplied `clientRequestId`;
- canonical `normalizedRequestDigest` in `sha256:<lowercase-hex>` form;
- an exact `CVC` in `cvcCode`;
- all namespace-separated `sourceCodeLists`;
- `codex-harness` provenance; and
- one or more additive items whose closed payload matches the delivery kind.

Each additive item is discriminated by `kind`. `canvas.media.add` carries a complete Canvas media resource, `canvas.node.add` carries an exact `CVT` plus closed node content, and `skill.projection.add` carries an immutable Skill revision plus its host pin. Kind and item payloads must match; update, replace, delete, internal-ID, and search-result payloads are not valid.

`status.disposition` reports `original`, `replay`, or `conflict` independently from processing state. A reused `clientRequestId` with a different normalized digest produces the stable `delivery_conflict` structured-error code together with both the submitted `normalizedRequestDigest` and authoritative `existingRequestDigest`.

Storage remains the durable authority. These schemas define the adapter boundary only and do not implement resolution, normalization, authorization, idempotency, or mutation behavior.

## Validation

Consumers load `schema.json` into a JSON Schema 2020-12 validator and resolve the absolute IDs from `manifest.json`. The repository contract check uses the directly pinned Ajv 8.17.1 `Ajv2020` entry point; an older transitive Ajv is not compatible with this dialect.

Run it directly with `npm run test:contracts`. The standard `npm test` entry point invokes the same contract check through its `pretest` hook before Vitest starts.

## Fixtures

`fixtures/*.json` are sorted and executed individually by the contract check. Every fixture declares `name`, `entryPoint`, `schemaId`, `instance`, and `expectedSchemaValidity`; `schemaId` must exactly equal the selected manifest entry point. Schema-valid business-error and status examples additionally declare `expectedOutcome` with its own entry point, schema ID, and schema-valid instance. This keeps malformed boundary inputs distinct from well-formed requests whose authoritative outcome is an error or replay state.
