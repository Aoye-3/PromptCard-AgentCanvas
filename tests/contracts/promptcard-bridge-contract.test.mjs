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
    const manifest = await readJson("manifest.json");
    const schema = await readJson("schema.json");
    const ajv = new Ajv2020({ allErrors: true, strict: true });

    assert.equal(schema.$schema, manifest.schemaDialect);
    ajv.addSchema(schema);
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
});
