import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

const contractDirectory = new URL(
  "../../contracts/promptcard-bridge/v1/",
  import.meta.url,
);
const fixtureDirectory = new URL("fixtures/", contractDirectory);
const v2ContractDirectory = new URL(
  "../../contracts/promptcard-bridge/v2/",
  import.meta.url,
);
const v2FixtureDirectory = new URL("fixtures/", v2ContractDirectory);

async function readJson(filename) {
  return JSON.parse(
    await readFile(new URL(filename, contractDirectory), "utf8"),
  );
}

async function loadContract() {
  const manifest = await readJson("manifest.json");
  const schema = await readJson(manifest.schemaFile);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  return { ajv, manifest, schema };
}

async function loadFixtures() {
  const filenames = (await readdir(fixtureDirectory))
    .filter((filename) => filename.endsWith(".json"))
    .sort();
  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      fixture: JSON.parse(await readFile(new URL(filename, fixtureDirectory), "utf8")),
    })),
  );
}

async function readV2Json(filename) {
  return JSON.parse(
    await readFile(new URL(filename, v2ContractDirectory), "utf8"),
  );
}

async function loadV2Contract() {
  const manifest = await readV2Json("manifest.json");
  const v1Schema = await readJson("schema.json");
  const schema = await readV2Json(manifest.schemaFile);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(v1Schema);
  ajv.addSchema(schema);
  return { ajv, manifest, schema };
}

async function loadV2Fixtures() {
  const filenames = (await readdir(v2FixtureDirectory))
    .filter((filename) => filename.endsWith(".json"))
    .sort();
  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      fixture: JSON.parse(
        await readFile(new URL(filename, v2FixtureDirectory), "utf8"),
      ),
    })),
  );
}

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_DIGEST =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LIFECYCLE_OUTCOME_EXPECTATIONS = [
  {
    fixtureName: "successful additive canvas media delivery",
    violation: "successful delivery cannot lose its applied/original result",
    entryPoint: "status",
    state: "applied",
    disposition: "original",
    resultCodes: [`CVM-${ULID}`],
  },
  {
    fixtureName: "unknown exact code has a not-found outcome",
    violation: "unknown code cannot replace not_found/unknown_code",
    entryPoint: "structuredError",
    code: "not_found",
    details: [{ path: "/target", reason: "unknown_code" }],
  },
  {
    fixtureName: "trashed media has a not-found outcome",
    violation: "trashed media cannot replace not_found/trashed_media",
    entryPoint: "structuredError",
    code: "not_found",
    details: [{ path: "/target", reason: "trashed_media" }],
  },
  {
    fixtureName: "revoked context has a permission-denied outcome",
    violation: "revoked context cannot replace permission_denied/context_revoked",
    entryPoint: "structuredError",
    code: "permission_denied",
    details: [{ path: "/cvcCode", reason: "context_revoked" }],
  },
  {
    fixtureName: "revision conflict is schema-valid with a validation outcome",
    violation: "revision conflict cannot replace validation_error/revision_conflict",
    entryPoint: "structuredError",
    code: "validation_error",
    details: [{ path: "/revisionDigest", reason: "revision_conflict" }],
  },
];

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
  it("declares one version, its schema bundle, and every required stable entry point", async () => {
    const manifest = await readJson("manifest.json");

    assert.equal(manifest.contractVersion, "1.0.0");
    assert.equal(
      manifest.schemaDialect,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(manifest.schemaFile, "schema.json");
    assert.deepEqual(manifest.entryPoints, {
      typedReference:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/typed-reference.schema.json",
      exactReferenceInput:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/exact-reference-input.schema.json",
      searchResult:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/search-result.schema.json",
      promptBundle:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/prompt-bundle.schema.json",
      mediaResource:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/media-resource.schema.json",
      contextPack:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/context-pack.schema.json",
      skillPackage:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/skill-package.schema.json",
      skillRevision:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/skill-revision.schema.json",
      skillHostPin:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/skill-host-pin.schema.json",
      proposal:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/proposal.schema.json",
      delivery:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/delivery.schema.json",
      status:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/status.schema.json",
      structuredError:
        "https://schemas.promptcard.dev/promptcard-bridge/v1/structured-error.schema.json",
    });

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

  it("validates named positive and negative contract fixtures", async (t) => {
    const fixtures = await loadFixtures();
    assert.ok(fixtures.length > 0, "at least one contract fixture is required");

    for (const { filename, fixture } of fixtures) {
      await t.test(fixture.name ?? filename, async () => {
        const { ajv, manifest } = await loadContract();

        assert.equal(typeof fixture.name, "string", `${filename}: name`);
        assert.equal(typeof fixture.entryPoint, "string", `${fixture.name}: entryPoint`);
        assert.equal(
          typeof fixture.expectedSchemaValidity,
          "boolean",
          `${fixture.name}: expectedSchemaValidity`,
        );
        assert.equal(
          manifest.entryPoints[fixture.entryPoint],
          fixture.schemaId,
          `${fixture.name}: schemaId must match manifest entry point`,
        );

        const validate = ajv.getSchema(fixture.schemaId);
        assert.equal(typeof validate, "function", `${fixture.name}: schema must compile`);
        assert.equal(
          validate(fixture.instance),
          fixture.expectedSchemaValidity,
          `${fixture.name}: schema validity`,
        );

        if (fixture.expectedOutcome) {
          assert.equal(
            typeof fixture.expectedOutcome.entryPoint,
            "string",
            `${fixture.name}: expectedOutcome.entryPoint`,
          );
          const outcomeValidate = ajv.getSchema(fixture.expectedOutcome.schemaId);
          assert.equal(
            manifest.entryPoints[fixture.expectedOutcome.entryPoint],
            fixture.expectedOutcome.schemaId,
            `${fixture.name}: outcome schemaId must match manifest entry point`,
          );
          assert.equal(
            outcomeValidate(fixture.expectedOutcome.instance),
            true,
            `${fixture.name}: expected outcome must be schema-valid`,
          );
        }
      });
    }
  });

  it("rejects schema-valid swaps of lifecycle fixture outcomes", async (t) => {
    const fixtures = new Map(
      (await loadFixtures()).map(({ fixture }) => [fixture.name, fixture]),
    );

    for (const expected of LIFECYCLE_OUTCOME_EXPECTATIONS) {
      await t.test(expected.violation, () => {
        const outcome = fixtures.get(expected.fixtureName).expectedOutcome;

        assert.equal(outcome.entryPoint, expected.entryPoint);
        if (expected.state) {
          assert.equal(outcome.instance.state, expected.state);
          assert.equal(outcome.instance.disposition, expected.disposition);
          assert.deepEqual(outcome.instance.resultCodes, expected.resultCodes);
        } else {
          assert.equal(outcome.instance.code, expected.code);
          assert.deepEqual(outcome.instance.details, expected.details);
        }
      });
    }
  });

  it("rejects drift in replay/conflict digest bindings and host-pin revision bindings", async () => {
    const fixtures = new Map(
      (await loadFixtures()).map(({ fixture }) => [fixture.name, fixture]),
    );
    const replay = fixtures.get("same request key and digest replays the first result");
    const conflict = fixtures.get("same request key and different digest conflicts");
    const hostPins = fixtures.get("independent local-agent and Codex host pins");

    assert.equal(replay.instance.clientRequestId, "replay-key-001");
    assert.equal(conflict.instance.clientRequestId, "replay-key-001");
    assert.equal(replay.instance.normalizedRequestDigest, DIGEST);
    assert.equal(conflict.instance.normalizedRequestDigest, OTHER_DIGEST);
    assert.equal(
      replay.instance.normalizedRequestDigest,
      conflict.expectedOutcome.instance.existingRequestDigest,
    );
    assert.equal(
      conflict.instance.normalizedRequestDigest,
      conflict.expectedOutcome.instance.normalizedRequestDigest,
    );
    assert.notEqual(
      replay.instance.normalizedRequestDigest,
      conflict.instance.normalizedRequestDigest,
    );
    assert.equal(replay.expectedOutcome.instance.disposition, "replay");
    assert.equal(conflict.expectedOutcome.instance.code, "delivery_conflict");
    assert.deepEqual(
      hostPins.instance.items.map((item) => item.hostPin.host).sort(),
      ["codex", "local-agent"],
    );
    for (const item of hostPins.instance.items) {
      assert.equal(item.hostPin.skillCode, `SKL-${ULID}`);
      assert.equal(item.hostPin.revisionDigest, DIGEST);
      assert.equal(item.hostPin.skillCode, item.skillRevision.skillCode);
      assert.equal(item.hostPin.revisionDigest, item.skillRevision.revisionDigest);
    }
    assert.equal(hostPins.expectedOutcome.entryPoint, "status");
    assert.equal(hostPins.expectedOutcome.instance.state, "applied");
    assert.equal(hostPins.expectedOutcome.instance.disposition, "original");
    assert.deepEqual(hostPins.expectedOutcome.instance.resultCodes, [`SKL-${ULID}`]);
  });
});

describe("PromptCard bridge v2 host-neutral boundary", () => {
  it("declares the trusted context, delivery request, and delivery record entry points", async () => {
    const { ajv, manifest, schema } = await loadV2Contract();

    assert.equal(manifest.contractVersion, "2.0.0");
    assert.equal(manifest.compatibleBase, "../v1/manifest.json");
    assert.equal(schema.$schema, manifest.schemaDialect);
    assert.deepEqual(Object.keys(manifest.entryPoints).sort(), [
      "deliveryRecord",
      "deliveryRecordCollection",
      "deliveryRequest",
      "operationContext",
    ]);
    for (const [name, id] of Object.entries(manifest.entryPoints)) {
      assert.match(
        id,
        /^https:\/\/schemas\.promptcard\.dev\/promptcard-bridge\/v2\/[a-z-]+\.schema\.json$/,
      );
      assert.equal(typeof ajv.getSchema(id), "function", `${name}: ${id}`);
      assert.doesNotThrow(() => ajv.compile({ $ref: id }), name);
    }
  });

  it("validates host-neutral v2 fixtures", async (t) => {
    const fixtures = await loadV2Fixtures();
    assert.ok(fixtures.length >= 4, "v2 boundary fixtures are required");

    for (const { filename, fixture } of fixtures) {
      await t.test(fixture.name ?? filename, async () => {
        const { ajv, manifest } = await loadV2Contract();
        assert.equal(
          manifest.entryPoints[fixture.entryPoint],
          fixture.schemaId,
          `${fixture.name}: schemaId must match manifest entry point`,
        );
        const validate = ajv.getSchema(fixture.schemaId);
        assert.equal(typeof validate, "function");
        assert.equal(
          validate(fixture.instance),
          fixture.expectedSchemaValidity,
          `${fixture.name}: ${JSON.stringify(validate.errors)}`,
        );
      });
    }
  });

  it("does not let a delivery request self-report a trusted profile", async () => {
    const fixtures = new Map(
      (await loadV2Fixtures()).map(({ fixture }) => [fixture.name, fixture]),
    );
    const valid = fixtures.get("host-neutral delivery request");
    const spoofed = fixtures.get("delivery request cannot forge profile context");
    const legacy = fixtures.get("new delivery rejects legacy Codex provenance");

    assert.equal(valid.expectedSchemaValidity, true);
    assert.equal(valid.instance.provenance, "promptcard-bridge");
    assert.equal(Object.hasOwn(valid.instance, "profileId"), false);
    assert.equal(spoofed.expectedSchemaValidity, false);
    assert.equal(spoofed.instance.profileId, "forged-admin");
    assert.equal(legacy.expectedSchemaValidity, false);
    assert.equal(legacy.instance.provenance, "codex-harness");
  });

  it("keys replay identity by trusted profile as well as client request ID", async () => {
    const fixtures = new Map(
      (await loadV2Fixtures()).map(({ fixture }) => [fixture.name, fixture]),
    );
    const isolated = fixtures.get("same request key is isolated across profiles");
    const [codexRecord, traeRecord] = isolated.instance.records;

    assert.equal(isolated.expectedSchemaValidity, true);
    assert.equal(
      codexRecord.request.clientRequestId,
      traeRecord.request.clientRequestId,
    );
    assert.equal(
      codexRecord.request.normalizedRequestDigest,
      traeRecord.request.normalizedRequestDigest,
    );
    assert.notEqual(
      codexRecord.operationContext.profileId,
      traeRecord.operationContext.profileId,
    );
    assert.equal(codexRecord.operationContext.clientInfo.name, "codex");
    assert.equal(traeRecord.operationContext.clientInfo.name, "trae");
  });
});
