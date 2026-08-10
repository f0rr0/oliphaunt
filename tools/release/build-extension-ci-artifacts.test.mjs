import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  productReleaseExtensionMetadata,
  readProductReleaseExtensionMetadata,
} from "./build-extension-ci-artifacts.mjs";

const roots = [];
const GENERATED_FROM = [
  { name: "extension-catalog", path: "src/extensions/generated/extensions.catalog.json" },
  { name: "extension-evidence", path: "src/extensions/generated/docs/extension-evidence.json" },
];

function fixtureMetadata(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-release-extension-metadata-"));
  roots.push(root);
  const file = path.join(root, ".release-extension-metadata.json");
  writeFileSync(file, `${JSON.stringify({
    "format-version": 1,
    consumer: "release-product",
    "release-product": "oliphaunt-extension-example",
    "generated-from": GENERATED_FROM,
    extensions: [
      {
        id: "example",
        "sql-name": "example",
        "release-product": "oliphaunt-extension-example",
      },
    ],
    ...overrides,
  }, null, 2)}\n`);
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("release assembly resolves the product-local neutral extension contract", () => {
  const rows = productReleaseExtensionMetadata("oliphaunt-extension-pg-textsearch");
  assert.deepEqual([...rows.keys()], ["pg_textsearch"]);
  assert.equal(rows.get("pg_textsearch")["release-product"], "oliphaunt-extension-pg-textsearch");
});

test("release extension metadata rejects SDK ownership and mismatched product membership", () => {
  const sdkOwned = fixtureMetadata({
    "generated-from": [
      { name: "kotlin-extension-catalog", path: "src/extensions/generated/sdk/kotlin.json" },
    ],
  });
  assert.throws(
    () => readProductReleaseExtensionMetadata(sdkOwned, {
      product: "oliphaunt-extension-example",
      sqlNames: ["example"],
    }),
    /generated directly from the canonical extension catalog and evidence/u,
  );

  const wrongMembers = fixtureMetadata({
    extensions: [
      {
        id: "other",
        "sql-name": "other",
        "release-product": "oliphaunt-extension-example",
      },
    ],
  });
  assert.throws(
    () => readProductReleaseExtensionMetadata(wrongMembers, {
      product: "oliphaunt-extension-example",
      sqlNames: ["example"],
    }),
    /must contain exactly the ordered release members/u,
  );
});
