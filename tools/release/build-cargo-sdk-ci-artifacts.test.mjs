import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { cargoSdkPackageClosure } from "./build-cargo-sdk-ci-artifacts.mjs";
import { currentProductVersionSync } from "./release-artifact-targets.mjs";
import { ROOT } from "./release-cli-utils.mjs";

test("selects exact final-crate closure checks only for the two Cargo SDKs", () => {
  const rustVersion = currentProductVersionSync("oliphaunt-rust", "cargo-sdk-wrapper.test");
  const rust = cargoSdkPackageClosure("oliphaunt-rust");
  assert.equal(
    rust.cratePath,
    path.join(ROOT, `target/sdk-artifacts/oliphaunt-rust/oliphaunt-${rustVersion}.crate`),
  );
  assert.equal(rust.allFeatures, true);
  assert.deepEqual(rust.stubDependencies, ["oliphaunt-tools"]);
  assert.deepEqual(rust.stubDependencyPrefixes, [
    "liboliphaunt-native-",
    "oliphaunt-broker-",
  ]);

  const wasixVersion = currentProductVersionSync(
    "oliphaunt-wasix-rust",
    "cargo-sdk-wrapper.test",
  );
  const wasix = cargoSdkPackageClosure("oliphaunt-wasix-rust");
  assert.equal(
    wasix.cratePath,
    path.join(
      ROOT,
      `target/sdk-artifacts/oliphaunt-wasix-rust/oliphaunt-wasix-${wasixVersion}.crate`,
    ),
  );
  assert.equal(wasix.noDefaultFeatures, true);
  assert.deepEqual(wasix.features, ["extensions", "tools", "icu"]);
  assert.deepEqual(wasix.pathDependencyManifests, [
    path.join(ROOT, "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml"),
  ]);

  assert.throws(
    () => cargoSdkPackageClosure("oliphaunt-kotlin"),
    /unsupported Cargo SDK product/u,
  );
});
