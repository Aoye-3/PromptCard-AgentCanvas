import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

const contractDirectory = new URL(
  "../../contracts/promptcard-bridge/v1/",
  import.meta.url,
);

async function readJson(filename) {
  return JSON.parse(
    await readFile(new URL(filename, contractDirectory), "utf8"),
  );
}

async function loadContract() {
  const manifest = await readJson("manifest.json");
  const schema = await readJson("schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  return { ajv, manifest, schema };
}

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_DIGEST =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const emptySourceCodeLists = {
  promptBundleCodes: [],
  promptMediaCodes: [],
  canvasTemplateCodes: [],
  canvasMediaCodes: [],
  skillCodes: [],
};

function delivery(kind, item) {
  return {
    clientRequestId: "request-001",
    normalizedRequestDigest: DIGEST,
    cvcCode: `CVC-${ULID}`,
    kind,
    sourceCodeLists: emptySourceCodeLists,
    provenance: "codex-harness",
    items: [item],
  };
}

describe("PromptCard bridge contract package", () => {
  it("declares one version and every required stable entry point", async () => {
    const manifest = await readJson("manifest.json");

    assert.equal(manifest.contractVersion, "1.0.0");
    assert.equal(
      manifest.schemaDialect,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.deepEqual(Object.keys(manifest.entryPoints).sort(), [
      "contextPack",
      "delivery",
      "exactReferenceInput",
      "mediaResource",
      "promptBundle",
      "proposal",
      "searchResult",
      "skillHostPin",
      "skillPackage",
      "skillRevision",
      "status",
      "structuredError",
      "typedReference",
    ]);

    const ids = Object.values(manifest.entryPoints);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(
        id,
        /^https:\/\/schemas\.promptcard\.dev\/promptcard-bridge\/v1\/[a-z-]+\.schema\.json$/,
      );
    }
  });

  it("compiles every manifest entry point with Ajv 2020", async () => {
    const { ajv, manifest, schema } = await loadContract();

    assert.equal(schema.$schema, manifest.schemaDialect);
    assert.equal(typeof ajv.getSchema(schema.$id), "function", schema.$id);

    const resourceIds = Object.values(schema.$defs).map(
      (definition) => definition.$id,
    );
    assert.equal(new Set(resourceIds).size, resourceIds.length);
    for (const id of resourceIds) {
      assert.equal(typeof ajv.getSchema(id), "function", id);
    }

    for (const [name, id] of Object.entries(manifest.entryPoints)) {
      assert.equal(typeof ajv.getSchema(id), "function", `${name}: ${id}`);
      assert.doesNotThrow(() => ajv.compile({ $ref: id }), name);
    }
  });

  it("requires a closed kind-specific payload for every additive delivery item", async () => {
    const { ajv, manifest } = await loadContract();
    const validate = ajv.getSchema(manifest.entryPoints.delivery);

    const mediaItem = {
      kind: "canvas.media.add",
      mediaResource: {
        namespace: "canvasMedia",
        code: `CVM-${ULID}`,
        mediaType: "image/png",
        contentDigest: DIGEST,
        byteLength: 42,
      },
    };
    const nodeItem = {
      kind: "canvas.node.add",
      canvasTemplateCode: `CVT-${ULID}`,
      nodeContent: {
        nodeType: "prompt",
        content: "A governed prompt node",
        position: { x: 12, y: 34 },
      },
    };
    const skillItem = {
      kind: "skill.projection.add",
      skillRevision: {
        skillCode: `SKL-${ULID}`,
        revisionDigest: DIGEST,
        files: [{ path: "SKILL.md", content: "# Governed skill" }],
        sourceCodes: [],
      },
      hostPin: {
        host: "codex",
        skillCode: `SKL-${ULID}`,
        revisionDigest: DIGEST,
      },
    };

    assert.equal(validate(delivery("canvas.media.add", mediaItem)), true);
    assert.equal(validate(delivery("canvas.node.add", nodeItem)), true);
    assert.equal(validate(delivery("skill.projection.add", skillItem)), true);

    assert.equal(
      validate(delivery("canvas.media.add", { kind: "canvas.media.add" })),
      false,
    );
    assert.equal(
      validate(delivery("canvas.node.add", { kind: "canvas.node.add" })),
      false,
    );
    assert.equal(
      validate(
        delivery("skill.projection.add", {
          kind: "skill.projection.add",
          skillRevision: skillItem.skillRevision,
        }),
      ),
      false,
    );
    assert.equal(validate(delivery("skill.projection.add", mediaItem)), false);
    assert.equal(
      validate(
        delivery("canvas.media.update", {
          ...mediaItem,
          kind: "canvas.media.update",
        }),
      ),
      false,
    );
    assert.equal(
      validate(
        delivery("canvas.media.add", {
          ...mediaItem,
          label: "unexpected generic payload",
        }),
      ),
      false,
    );
  });

  it("exposes stable replay and delivery-conflict outcomes", async () => {
    const { ajv, manifest } = await loadContract();
    const validateStatus = ajv.getSchema(manifest.entryPoints.status);
    const validateError = ajv.getSchema(manifest.entryPoints.structuredError);

    const replayStatus = {
      clientRequestId: "request-001",
      normalizedRequestDigest: DIGEST,
      state: "applied",
      disposition: "replay",
      message: "Returned the existing delivery result",
      resultCodes: [`CVM-${ULID}`],
    };
    const conflictStatus = {
      ...replayStatus,
      state: "rejected",
      disposition: "conflict",
      message: "The request ID is bound to another digest",
      resultCodes: [],
    };
    const conflictError = {
      code: "delivery_conflict",
      message: "The request ID is bound to another digest",
      retryable: false,
      clientRequestId: "request-001",
      normalizedRequestDigest: DIGEST,
      existingRequestDigest: OTHER_DIGEST,
      details: [],
    };

    assert.equal(validateStatus(replayStatus), true);
    assert.equal(validateStatus(conflictStatus), true);
    assert.equal(
      validateStatus(
        Object.fromEntries(
          Object.entries(replayStatus).filter(([key]) => key !== "disposition"),
        ),
      ),
      false,
    );
    assert.equal(validateError(conflictError), true);
    const conflictWithoutNormalizedDigest = Object.fromEntries(
      Object.entries(conflictError).filter(
        ([key]) => key !== "normalizedRequestDigest",
      ),
    );
    assert.equal(validateError(conflictWithoutNormalizedDigest), false);
    assert.equal(
      validateError({ ...conflictError, code: "custom_error" }),
      false,
    );
  });

  it("rejects reference codes whose ULID overflows 128 bits", async () => {
    const { ajv } = await loadContract();
    const overflowUlid = "Z1ARZ3NDEKTSV4RRFFQ69G5FAV";
    const cases = [
      ["project-code.schema.json", `PRJ-${overflowUlid}`],
      ["prompt-bundle-code.schema.json", `PLP-${overflowUlid}`],
      ["prompt-media-code.schema.json", `PLM-${overflowUlid}`],
      ["canvas-template-code.schema.json", `CVT-${overflowUlid}`],
      ["canvas-media-code.schema.json", `CVM-${overflowUlid}`],
      ["canvas-code.schema.json", `CVC-${overflowUlid}`],
      ["skill-code.schema.json", `SKL-${overflowUlid}`],
      ["project-code-input.schema.json", `prj-${overflowUlid}`],
      ["prompt-bundle-code-input.schema.json", `plp-${overflowUlid}`],
      ["prompt-media-code-input.schema.json", `plm-${overflowUlid}`],
      ["canvas-template-code-input.schema.json", `cvt-${overflowUlid}`],
      ["canvas-media-code-input.schema.json", `cvm-${overflowUlid}`],
      ["canvas-code-input.schema.json", `cvc-${overflowUlid}`],
      ["skill-code-input.schema.json", `skl-${overflowUlid}`],
    ];

    for (const [resource, code] of cases) {
      const validate = ajv.getSchema(
        `https://schemas.promptcard.dev/promptcard-bridge/v1/${resource}`,
      );
      assert.equal(validate(code), false, `${resource} accepted ${code}`);
    }
  });
});
