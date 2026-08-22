# PromptCard Bridge contract v1

This directory is the repository-neutral, language-neutral public contract shared by future Gateway, CLI, and MCP adapters. `manifest.json` declares the single contract version and every supported schema entry point; `schema.json` is a JSON Schema 2020-12 resource bundle.

## Public references

Public references use `PREFIX-ULID`: `PRJ`, `PLP`, `PLM`, `CVT`, `CVM`, `CVC`, or `SKL`, followed by a hyphen and a 26-character ULID. Contract inputs accept either letter case. Contract producers must normalize codes to uppercase before persistence or output.

Prefixes are semantic namespaces, not interchangeable labels. In particular, `PLM` and `CVM` remain different identities even when they describe identical bytes. Internal database keys are neither accepted nor exposed by these schemas.

Exact execution targets use the `exactReferenceInput` entry point, which accepts only a typed public code string. A `searchResult` is discovery output and cannot be supplied where an exact execution target is required.

## Delivery boundary

`proposal` describes a non-mutating candidate. `delivery` is limited to the additive kinds declared by `additive-kind.schema.json`; it cannot express update, replace, or delete behavior. Every delivery requires:

- caller-supplied `clientRequestId`;
- canonical `normalizedRequestDigest` in `sha256:<lowercase-hex>` form;
- an exact `CVC` in `cvcCode`;
- all namespace-separated `sourceCodeLists`;
- `codex-harness` provenance; and
- one or more additive items.

Storage remains the durable authority. These schemas define the adapter boundary only and do not implement resolution, normalization, authorization, idempotency, or mutation behavior.

## Validation

Consumers load `schema.json` into a JSON Schema 2020-12 validator and resolve the absolute IDs from `manifest.json`. The repository contract check uses the directly pinned Ajv 8.17.1 `Ajv2020` entry point; an older transitive Ajv is not compatible with this dialect.
