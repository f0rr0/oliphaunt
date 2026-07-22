import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  activeBlockedExtensionPublications,
  assertExtensionPublicationLegalClearance,
  declaredExtensionPublicationBlockers,
} from "./check-extension-publication-legal-clearance.mjs";
import { extensionQualificationCandidates } from "./extension-qualification-candidates.mjs";

function writeFixture(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function deferredPublicationFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-publication-blocker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const product = "oliphaunt-extension-fixture";
  const reason = "The fixture remains private until its publication contract is deliberately cleared.";
  writeFixture(root, "src/extensions/catalog/extensions.promoted.toml", `
format-version = 1

[[extensions]]
id = "fixture_extension"
build = true
stable = false
blocker = ${JSON.stringify(reason)}
`.trimStart());
  writeFixture(root, "tools/release/extension-target-profiles.toml", `
schema = "oliphaunt-extension-artifact-target-profiles-v1"

[[profiles]]
id = "native-desktop-v1"
[[profiles.targets]]
family = "native"
kind = "native-dynamic"
target = "linux-x64-gnu"
`.trimStart());
  writeFixture(root, "src/extensions/external/fixture_extension/publication-blocker.toml", `
schema = "oliphaunt-extension-publication-blocker-v2"
extension_id = "fixture_extension"
product = "${product}"
reason = ${JSON.stringify(reason)}
resolutions = ["defer-product-from-publication-catalog"]
sql_name = "fixture_extension"
status = "deferred"
`.trimStart());
  writeFixture(root, "src/extensions/external/fixture_extension/recipe.toml", `
sql_name = "fixture_extension"
source = "fixture_extension"
`.trimStart());
  writeFixture(root, "src/extensions/external/fixture_extension/source.toml", `
name = "fixture_extension"
commit = "0123456789abcdef0123456789abcdef01234567"

[extension-control]
sql-name = "fixture_extension"
default-version = "1.2.3"
`.trimStart());
  writeFixture(root, "src/extensions/external/fixture_extension/targets/artifacts.toml", `
schema = "oliphaunt-extension-artifact-targets-v1"
profiles = ["native-desktop-v1"]
`.trimStart());
  writeFixture(root, "src/extensions/external/fixture_extension/moon.yml", "tags: []\n");
  writeFixture(root, "release-please-config.json", "{\"packages\":{}}\n");
  writeFixture(root, ".release-please-manifest.json", "{}\n");
  for (const relative of [
    "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml",
    "src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml",
    "src/runtimes/liboliphaunt/wasix/crates/assets/build.rs",
  ]) {
    writeFixture(root, relative, "# fixture intentionally exposes no deferred extension\n");
  }
  return { product, reason, root };
}

test("the live tree has no publication blockers and keeps the legal gate active", () => {
  assert.match(
    readFileSync("tools/release/release-metadata-check.mjs", "utf8"),
    /check-extension-publication-legal-clearance[.]mjs/u,
  );
  assert.deepEqual(extensionQualificationCandidates(), []);
  assert.deepEqual(declaredExtensionPublicationBlockers(), []);
  assert.deepEqual(activeBlockedExtensionPublications(), []);
  assert.doesNotThrow(() => assertExtensionPublicationLegalClearance());

  const result = spawnSync(process.execPath, [
    "tools/release/check-extension-publication-legal-clearance.mjs",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /validated 0 deferred blocker[(]s[)]; 0 active blocked publications/u);
});

test("the legal gate validates a dormant fixture blocker and fails closed if it becomes active", (t) => {
  const { product, reason, root } = deferredPublicationFixture(t);
  const declared = declaredExtensionPublicationBlockers({ root, activeProducts: [] });
  assert.deepEqual(declared.map((row) => row.product), [product]);
  assert.equal(declared[0].reason, reason);
  assert.deepEqual(activeBlockedExtensionPublications({ root, activeProducts: [] }), []);
  assert.doesNotThrow(() => assertExtensionPublicationLegalClearance({ root, activeProducts: [] }));
  assert.throws(
    () => assertExtensionPublicationLegalClearance({ root, activeProducts: [product] }),
    /oliphaunt-extension-fixture is legally blocked but remains in the active release graph/u,
  );
});
