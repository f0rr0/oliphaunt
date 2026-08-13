#!/usr/bin/env bun

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { expectedJsrPublishedManifest } from "./jsr-publish-normalization.mjs";
import { verifyLockedCarrierIntegrity } from "./registry-integrity.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const CURRENT_SOURCE = path.join(ROOT, "src/sdks/js");
const FROZEN_RAW_SOURCE = path.join(
  import.meta.dir,
  "fixtures/jsr-publish-normalization/oliphaunt-ts-0.1.1",
);
// These are immutable publication-evidence bytes. Reading them from the
// current SDK or spawning Git would respectively retarget the proof or make
// the release gate depend on repository history and subprocess behavior.
const FROZEN_RAW_FILES = new Set(["src/jsr.ts", "src/query.ts"]);
const EXACT_SOURCE = Object.freeze({
  commit: "ae3d29ba16245e9345a8d337cd17c53f9bf2e853",
  tree: "673e8f249d2f51d10997f0036a7e471bf35a388e",
});
const EXACT_LOCK_DIGEST = "d1a9f799c1fd40582e7a824ccc6ec6650cba55b8a95592d3d2f626ba33cd6188";
const EXACT_CARRIER = Object.freeze({
  id: "jsr:@oliphaunt/ts",
  product: "oliphaunt-js",
  ecosystem: "jsr",
  name: "@oliphaunt/ts",
  version: "0.1.1",
  publishOrder: 0,
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stageNormalizationFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-jsr-normalization-"));
  const config = JSON.parse(readFileSync(path.join(CURRENT_SOURCE, "jsr.json"), "utf8"));
  for (const relative of config.publish.include) {
    const target = path.join(directory, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    const sdkSource = path.join(CURRENT_SOURCE, ...relative.split("/"));
    const source = relative === "LICENSE" || relative === "THIRD_PARTY_NOTICES.md"
      ? path.join(ROOT, relative)
      : FROZEN_RAW_FILES.has(relative)
      ? path.join(FROZEN_RAW_SOURCE, ...`${relative}.raw`.split("/"))
      : sdkSource;
    writeFileSync(target, readFileSync(source));
  }
  return directory;
}

function directoryEnvelope(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(root);
  const hash = createHash("sha256");
  let size = 0;
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const bytes = readFileSync(file);
    hash.update(`${relative}\0${bytes.length}\0`);
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest("hex"), size };
}

function exactLock(directory) {
  return {
    lockDigest: EXACT_LOCK_DIGEST,
    source: EXACT_SOURCE,
    carriers: [{
      ...EXACT_CARRIER,
      artifacts: [{ path: directory, ...directoryEnvelope(directory) }],
    }],
  };
}

test("admits only the exact immutable 0.1.1 raw-to-published JSR proofs", async () => {
  const directory = stageNormalizationFixture();
  try {
    const lock = exactLock(directory);
    const carrier = lock.carriers[0];
    const manifest = expectedJsrPublishedManifest({ carrier, directory, lock });
    assert.deepEqual(manifest["/src/jsr.ts"], {
      checksum: "sha256-5deab23099b38b44af86bcafbcdc8a4fb487444880e23b260e74d1c8b6379774",
      size: 938,
    });
    assert.deepEqual(manifest["/src/query.ts"], {
      checksum: "sha256-b25ea0cf76c117e0f681a4c4dd2b506c62b4fb0abacaa0319472bd1c87186191",
      size: 19095,
    });
    assert.deepEqual(manifest["/src/protocol.ts"], {
      checksum: `sha256-${sha256(readFileSync(path.join(directory, "src/protocol.ts")))}`,
      size: statSync(path.join(directory, "src/protocol.ts")).size,
    });

    const receipt = await verifyLockedCarrierIntegrity(lock, EXACT_CARRIER.id, {
      fetchImpl: async () => Response.json({ manifest }),
    });
    assert.deepEqual(receipt.registryProof.files, manifest);

    const wrongPublished = structuredClone(manifest);
    wrongPublished["/src/jsr.ts"].checksum = `sha256-${"0".repeat(64)}`;
    await assert.rejects(
      () => verifyLockedCarrierIntegrity(lock, EXACT_CARRIER.id, {
        fetchImpl: async () => Response.json({ manifest: wrongPublished }),
      }),
      /published file manifest does not match/u,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects wrong immutable identity fields and wrong frozen raw bytes", () => {
  const directory = stageNormalizationFixture();
  try {
    const exact = exactLock(directory);
    for (const [label, lock, carrier] of [
      ["lock", { ...exact, lockDigest: "0".repeat(64) }, exact.carriers[0]],
      ["commit", { ...exact, source: { ...EXACT_SOURCE, commit: "0".repeat(40) } }, exact.carriers[0]],
      ["tree", { ...exact, source: { ...EXACT_SOURCE, tree: "0".repeat(40) } }, exact.carriers[0]],
      ["carrier", exact, { ...exact.carriers[0], id: "jsr:@oliphaunt/substitute" }],
    ]) {
      assert.throws(
        () => expectedJsrPublishedManifest({ carrier, directory, lock }),
        /without an exact pre-recorded publish normalization/u,
        label,
      );
    }
    assert.throws(
      () => expectedJsrPublishedManifest({
        carrier: { ...exact.carriers[0], version: "0.1.2" },
        directory,
        lock: exact,
      }),
      /identity does not match/u,
    );
    const wrongVersionDirectory = stageNormalizationFixture();
    try {
      const config = JSON.parse(readFileSync(path.join(wrongVersionDirectory, "jsr.json"), "utf8"));
      config.version = "0.1.2";
      writeFileSync(
        path.join(wrongVersionDirectory, "jsr.json"),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      assert.throws(
        () => expectedJsrPublishedManifest({
          carrier: { ...exact.carriers[0], version: "0.1.2" },
          directory: wrongVersionDirectory,
          lock: exact,
        }),
        /without an exact pre-recorded publish normalization/u,
      );
    } finally {
      rmSync(wrongVersionDirectory, { force: true, recursive: true });
    }

    writeFileSync(
      path.join(directory, "src/query.ts"),
      `${readFileSync(path.join(directory, "src/query.ts"), "utf8")}\n`,
    );
    assert.throws(
      () => expectedJsrPublishedManifest({ carrier: exact.carriers[0], directory, lock: exact }),
      /no longer matches its exact publish-time normalization record/u,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("future rewrite-prone JSR source fails before publication without an exact record", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-jsr-future-"));
  try {
    mkdirSync(path.join(directory, "src"), { recursive: true });
    writeFileSync(path.join(directory, "jsr.json"), `${JSON.stringify({
      name: "@example/future",
      version: "9.0.0",
      exports: "./src/mod.ts",
      publish: { include: ["jsr.json", "src/dep.ts", "src/mod.ts"] },
    }, null, 2)}\n`);
    writeFileSync(path.join(directory, "src/dep.ts"), "export const value = 1;\n");
    writeFileSync(path.join(directory, "src/mod.ts"), "export { value } from './dep.js';\n");
    const carrier = {
      id: "jsr:@example/future",
      name: "@example/future",
      version: "9.0.0",
    };
    const lock = {
      lockDigest: "a".repeat(64),
      source: { commit: "b".repeat(40), tree: "c".repeat(40) },
    };
    writeFileSync(
      path.join(directory, "src/mod.ts"),
      "export const data = './dep.js'; // import './dep.js'\n",
    );
    assert.doesNotThrow(
      () => expectedJsrPublishedManifest({ carrier, directory, lock }),
      "data strings and comments are not import specifiers",
    );
    writeFileSync(path.join(directory, "src/mod.ts"), "export { value } from './dep.js';\n");
    assert.throws(
      () => expectedJsrPublishedManifest({ carrier, directory, lock }),
      /rewrite-prone.*without an exact pre-recorded publish normalization/u,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("import scanning ignores data strings, honors exact JavaScript targets, and fails closed on syntax errors", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-jsr-scan-"));
  try {
    mkdirSync(path.join(directory, "src"), { recursive: true });
    const config = {
      name: "@example/scan",
      version: "9.0.0",
      exports: "./src/mod.ts",
      publish: { include: ["jsr.json", "src/dep.ts", "src/mod.ts"] },
    };
    const writeConfig = () => writeFileSync(
      path.join(directory, "jsr.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    writeConfig();
    writeFileSync(path.join(directory, "src/dep.ts"), "export const value = 1;\n");
    writeFileSync(
      path.join(directory, "src/mod.ts"),
      "const example = './dep.js'; // export { value } from './dep.js'\nexport { example };\n",
    );
    const carrier = {
      id: "jsr:@example/scan",
      name: config.name,
      version: config.version,
    };
    const lock = {
      lockDigest: "a".repeat(64),
      source: { commit: "b".repeat(40), tree: "c".repeat(40) },
    };
    assert.doesNotThrow(() => expectedJsrPublishedManifest({ carrier, directory, lock }));

    config.publish.include.push("src/dep.js");
    writeConfig();
    writeFileSync(path.join(directory, "src/dep.js"), "export const value = 2;\n");
    writeFileSync(path.join(directory, "src/mod.ts"), "export { value } from './dep.js';\n");
    assert.doesNotThrow(() => expectedJsrPublishedManifest({ carrier, directory, lock }));

    writeFileSync(path.join(directory, "src/mod.ts"), "import {");
    assert.throws(
      () => expectedJsrPublishedManifest({ carrier, directory, lock }),
      /cannot parse included JSR source/u,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an exact normalization record must cover all and only rewrite-prone files", () => {
  const directory = stageNormalizationFixture();
  try {
    const query = path.join(directory, "src/query.ts");
    writeFileSync(query, readFileSync(query, "utf8").replace("'./protocol.js'", "'./protocol.ts'"));
    const lock = exactLock(directory);
    assert.throws(
      () => expectedJsrPublishedManifest({ carrier: lock.carriers[0], directory, lock }),
      /must cover precisely the rewrite-prone files/u,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
