import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { BROKER_PAYLOAD_LICENSE } from "./broker-dependency-license-contract.mjs";
import { releaseNoticeRows } from "./release-notices.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NOTICE_MEMBERS = releaseNoticeRows({ profile: "broker" }).map((row) => row.member);

function children(relative, manifest) {
  return readdirSync(path.join(ROOT, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(ROOT, relative, entry.name, manifest))
    .sort();
}

test("source broker is MIT while every compiled target carrier declares its complete payload license", () => {
  const sourceCargo = Bun.TOML.parse(readFileSync(path.join(ROOT, "src/runtimes/broker/Cargo.toml"), "utf8"));
  assert.equal(sourceCargo.package.license, "MIT");

  for (const file of children("src/runtimes/broker/packages", "package.json")) {
    const packageJson = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(packageJson.license, BROKER_PAYLOAD_LICENSE, file);
    for (const member of NOTICE_MEMBERS) {
      assert.ok(packageJson.files.includes(member), `${file} must include ${member}`);
    }
    assert.ok(packageJson.files.includes("THIRD_PARTY_LICENSES"), `${file} must include the exact dependency license tree`);
  }
  for (const file of children("src/runtimes/broker/crates", "Cargo.toml")) {
    const cargo = Bun.TOML.parse(readFileSync(file, "utf8"));
    assert.equal(cargo.package.license, BROKER_PAYLOAD_LICENSE, file);
    for (const member of NOTICE_MEMBERS) {
      assert.ok(cargo.package.include.includes(member), `${file} must include ${member}`);
    }
    assert.ok(cargo.package.include.includes("THIRD_PARTY_LICENSES/**"), `${file} must include the exact dependency license tree`);
  }
});

test("every broker registry path stages and reopens the exact dependency closure", () => {
  const cargoBuilder = readFileSync(path.join(ROOT, "tools/release/package_broker_cargo_artifacts.mjs"), "utf8");
  assert.match(cargoBuilder, /stageReleaseNotices\(crateDir, BROKER_NOTICE_OPTIONS\)/u);
  assert.match(cargoBuilder, /assertBrokerDependencyLicensesInArchive\(cratePath/u);
  assert.match(cargoBuilder, /brokerDependencyLicenseMembers\(target\.target\)/u);

  for (const relative of [
    "tools/release/release-product-dry-run.mjs",
    "tools/release/local-registry-publish.mjs",
  ]) {
    const source = readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(source, /stageReleaseNotices\([^\n]+\{ profile: "broker" \}\)/u, relative);
    assert.match(source, /assertBrokerDependencyLicensesInArchive\(tarball, \{ target: target\.target, prefix: "package" \}\)/u, relative);
    assert.match(source, /brokerDependencyLicenseMembers\(target\.target, \{ prefix: "package" \}\)/u, relative);
  }
});
