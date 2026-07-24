import assert from "node:assert/strict";
import test from "node:test";

import {
  androidExtensionLegalCatalog,
  androidExtensionLegalCatalogText,
  checkAndroidExtensionLegalCatalog,
  readAndroidExtensionLegalCatalogMetadata,
} from "./android-extension-legal-catalog.mjs";

function clone(value) {
  return structuredClone(value);
}

function findContract(catalog, scope, identity, target = "android-arm64-v8a") {
  const contract = catalog.contracts.find((candidate) => (
    candidate.scope === scope
    && candidate.identity === identity
    && candidate.target === target
  ));
  assert.ok(contract, `missing ${scope} ${identity} ${target}`);
  return contract;
}

function withoutTarget(contract) {
  const { target: _target, ...rest } = contract;
  return rest;
}

test("Android legal catalog is deterministic, complete, and current", () => {
  const metadata = readAndroidExtensionLegalCatalogMetadata();
  const first = androidExtensionLegalCatalog(metadata);
  const second = androidExtensionLegalCatalog(clone(metadata));

  assert.deepEqual(second, first);
  assert.equal(androidExtensionLegalCatalogText(metadata), androidExtensionLegalCatalogText(metadata));
  assert.equal(first.schema, "oliphaunt-android-extension-legal-catalog-v1");
  assert.equal(first.sourceCatalogSha256, metadata["extension-catalog-sha256"]);

  const products = new Set(metadata.extensions.map((row) => row["release-product"]));
  assert.equal(metadata.extensions.length, 39);
  assert.equal(products.size, 8);
  assert.equal(first.contracts.length, (metadata.extensions.length + products.size) * 2);
  assert.equal(first.contracts.filter(({ scope }) => scope === "leaf").length, 78);
  assert.equal(first.contracts.filter(({ scope }) => scope === "aggregate").length, 16);

  const keys = first.contracts.map(({ scope, identity, target }) => `${scope}\0${identity}\0${target}`);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(keys).size, keys.length);
  checkAndroidExtensionLegalCatalog();
});

test("Android legal contracts retain contrib, OpenSSL, and external closures", () => {
  const catalog = androidExtensionLegalCatalog(readAndroidExtensionLegalCatalogMetadata());
  const cube = findContract(catalog, "leaf", "cube");
  assert.equal(cube.profile, "contrib-native");
  assert.deepEqual(cube.licenseFiles, []);
  assert.deepEqual(cube.members.map(({ path }) => path), [
    "LICENSE",
    "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT",
    "THIRD_PARTY_NOTICES.md",
  ]);

  const pgcrypto = findContract(catalog, "leaf", "pgcrypto");
  assert.equal(pgcrypto.profile, "contrib-native-openssl");
  assert.deepEqual(pgcrypto.licenseFiles, []);
  assert.deepEqual(pgcrypto.members.map(({ path }) => path), [
    "LICENSE",
    "THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt",
    "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT",
    "THIRD_PARTY_NOTICES.md",
  ]);

  const contrib = findContract(catalog, "aggregate", "oliphaunt-extension-contrib-pg18");
  assert.equal(contrib.profile, "contrib-native-openssl");
  assert.deepEqual(contrib.members.map(({ path }) => path), [
    "LICENSE",
    "THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt",
    "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT",
    "THIRD_PARTY_NOTICES.md",
  ]);

  const postgis = findContract(catalog, "leaf", "postgis");
  assert.equal(postgis.profile, "external-native");
  assert.equal(postgis.licenseFiles.length, 16);
  assert.equal(postgis.members.length, 18);
  assert.equal(
    postgis.members.filter(({ path }) => path.startsWith("files/share/licenses/")).length,
    16,
  );
  assert.deepEqual(
    findContract(catalog, "aggregate", "oliphaunt-extension-postgis").licenseFiles,
    postgis.licenseFiles,
  );
});

test("every Android legal member is canonical and both ABIs are identical", () => {
  const catalog = androidExtensionLegalCatalog(readAndroidExtensionLegalCatalogMetadata());
  for (const contract of catalog.contracts) {
    assert.ok(["contrib-native", "contrib-native-openssl", "external-native"].includes(contract.profile));
    assert.deepEqual(contract.licenseFiles, [...contract.licenseFiles].sort());
    assert.equal(new Set(contract.licenseFiles).size, contract.licenseFiles.length);
    assert.deepEqual(contract.members.map(({ path }) => path), contract.members.map(({ path }) => path).sort());
    assert.equal(new Set(contract.members.map(({ path }) => path)).size, contract.members.length);
    for (const member of contract.members) {
      assert.deepEqual(Object.keys(member), ["path", "bytes", "sha256", "mode"]);
      assert.equal(Number.isSafeInteger(member.bytes) && member.bytes > 0, true);
      assert.match(member.sha256, /^[0-9a-f]{64}$/u);
      assert.equal(member.mode, "0644");
      assert.equal(member.path.startsWith("/") || member.path.includes("..") || member.path.includes("\\"), false);
    }
  }

  const armContracts = catalog.contracts.filter(({ target }) => target === "android-arm64-v8a");
  for (const arm of armContracts) {
    const x86 = findContract(catalog, arm.scope, arm.identity, "android-x86_64");
    assert.deepEqual(withoutTarget(x86), withoutTarget(arm));
  }
});

test("malformed generated Kotlin metadata cannot produce an Android legal catalog", () => {
  const metadata = readAndroidExtensionLegalCatalogMetadata();

  const reversed = clone(metadata);
  reversed.extensions.reverse();
  assert.throws(() => androidExtensionLegalCatalog(reversed), /sorted and unique/u);

  const duplicate = clone(metadata);
  duplicate.extensions = [duplicate.extensions[0], clone(duplicate.extensions[0])];
  assert.throws(() => androidExtensionLegalCatalog(duplicate), /sorted and unique/u);

  const privateRow = clone(metadata);
  privateRow.extensions[0].public = false;
  assert.throws(() => androidExtensionLegalCatalog(privateRow), /not one public mobile contract/u);

  const invalidDigest = clone(metadata);
  invalidDigest["extension-catalog-sha256"] = "not-a-digest";
  assert.throws(() => androidExtensionLegalCatalog(invalidDigest), /metadata is malformed/u);
});
