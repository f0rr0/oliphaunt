#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, expect, test } from "bun:test";

import { createDeterministicTar } from "./cargo-source-package.mjs";
import {
  assertWasixExtensionInstall,
  assertWasixExtensionMemberInstall,
  projectWasixExtensionInstallSidecar,
} from "./wasix-extension-install-contract.mjs";

const directories = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-wasix-install-contract-"));
  directories.push(root);
  const moduleBytes = Buffer.from("wasix-side-module");
  const modulePath = "lib/postgresql/example.so";
  const controlPath = "share/postgresql/extension/example.control";
  for (const [member, bytes] of [
    [modulePath, moduleBytes],
    [controlPath, Buffer.from("default_version = '1.0'\n")],
  ]) {
    const output = path.join(root, ...member.split("/"));
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, bytes);
  }
  const archiveBytes = zstdCompressSync(createDeterministicTar(root, ".", {
    fail(message) {
      throw new Error(message);
    },
    fixedFileMode: 0o644,
  }));
  const lifecycle = {
    "create-extension": true,
    "create-schema": "pg_catalog",
    "load-sql": [],
    "post-create-sql": [],
    "startup-config": [],
    "preload-required": false,
    "restart-required": false,
    "shared-memory-required": false,
  };
  const modelRow = {
    id: "example",
    "sql-name": "example",
    archive: "extensions/example.tar.zst",
    dependencies: ["plpgsql"],
    "load-order": [modulePath],
    lifecycle,
    "native-module-file": "example.so",
    "native-support-modules": [],
  };
  const manifestRow = {
    name: "Example",
    "sql-name": "example",
    archive: "extensions/example.tar.zst",
    sha256: sha256(archiveBytes),
    size: archiveBytes.length,
    "native-module": "example.so",
    "native-modules": [{
      name: "example",
      path: modulePath,
      sha256: sha256(moduleBytes),
      "module-sha256": sha256(moduleBytes),
      size: moduleBytes.length,
      link: { deliberately: "not public" },
    }],
    "core-exports-required": ["palloc"],
    dependencies: ["plpgsql"],
    "load-order": [modulePath],
    lifecycle,
    "installed-files": [modulePath, controlPath],
    "unresolved-imports": [],
  };
  return { archiveBytes, manifestRow, modelRow };
}

test("projects and deeply freezes only the compact extension-owned install authority", () => {
  const value = fixture();
  const sidecar = projectWasixExtensionInstallSidecar(value, {
    archiveBytes: value.archiveBytes,
    label: "example fixture",
  });
  expect(sidecar).toMatchObject({
    schema: "oliphaunt-wasix-extension-install-sidecar-v1",
    sqlName: "example",
    archive: "extensions/example.tar.zst",
    install: {
      schema: "oliphaunt-wasix-extension-install-v1",
      dependencies: ["plpgsql"],
      coreExportsRequired: ["palloc"],
    },
  });
  expect(sidecar.install.nativeModules[0]).toEqual({
    name: "example",
    path: "lib/postgresql/example.so",
    sha256: value.manifestRow["native-modules"][0].sha256,
    moduleSha256: value.manifestRow["native-modules"][0]["module-sha256"],
    size: value.manifestRow["native-modules"][0].size,
  });
  expect(Object.isFrozen(sidecar.install.nativeModules[0])).toBe(true);
  expect(Object.isFrozen(sidecar.install.lifecycle.loadSql)).toBe(true);
});

test("rejects installed-file and compact module hash drift against the archive", () => {
  const missingFile = fixture();
  missingFile.manifestRow["installed-files"] = ["lib/postgresql/example.so"];
  expect(() => projectWasixExtensionInstallSidecar(missingFile, {
    archiveBytes: missingFile.archiveBytes,
    label: "missing file fixture",
  })).toThrow(/regular file inventory differs from install[.]installedFiles/u);

  const badModule = fixture();
  badModule.manifestRow["native-modules"][0]["module-sha256"] = "a".repeat(64);
  expect(() => projectWasixExtensionInstallSidecar(badModule, {
    archiveBytes: badModule.archiveBytes,
    label: "bad module fixture",
  })).toThrow(/differs from its compact identity/u);
});

test("rejects install contracts that the consumer descriptor cannot accept", () => {
  const value = fixture();
  const install = structuredClone(projectWasixExtensionInstallSidecar(value, {
    archiveBytes: value.archiveBytes,
    label: "consumer parity fixture",
  }).install);

  const duplicateModule = structuredClone(install);
  duplicateModule.nativeModules.push({ ...duplicateModule.nativeModules[0] });
  expect(() => assertWasixExtensionInstall(duplicateModule, {
    expectedSqlName: "example",
  })).toThrow(/nativeModules names must not contain duplicates/u);

  const missingModuleIdentity = structuredClone(install);
  missingModuleIdentity.nativeModule = null;
  expect(() => assertWasixExtensionInstall(missingModuleIdentity, {
    expectedSqlName: "example",
  })).toThrow(/must be null exactly when nativeModules is empty/u);

  const selfDependency = structuredClone(install);
  selfDependency.dependencies = ["example"];
  expect(() => assertWasixExtensionInstall(selfDependency, {
    expectedSqlName: "example",
  })).toThrow(/must not include its own SQL name example/u);

  const missingInstalledModule = structuredClone(install);
  missingInstalledModule.installedFiles = missingInstalledModule.installedFiles.filter(
    (file) => file !== missingInstalledModule.nativeModules[0].path,
  );
  expect(() => assertWasixExtensionInstall(missingInstalledModule, {
    expectedSqlName: "example",
  })).toThrow(/must appear in installedFiles/u);
});

test("binds one install contract to exactly one portable member asset", () => {
  const value = fixture();
  const install = projectWasixExtensionInstallSidecar(value, {
    archiveBytes: value.archiveBytes,
    label: "member fixture",
  }).install;
  const portableAsset = {
    family: "wasix",
    kind: "wasix-runtime",
    target: "wasix-portable",
  };
  expect(assertWasixExtensionMemberInstall({
    sqlName: "example",
    assets: [portableAsset],
    wasixInstall: install,
  })).toEqual(install);
  expect(assertWasixExtensionMemberInstall({
    sqlName: "example",
    assets: [{ family: "native", kind: "runtime", target: "linux-x64-gnu" }],
    wasixInstall: null,
  })).toBeNull();
  expect(() => assertWasixExtensionMemberInstall({
    sqlName: "example",
    assets: [],
    wasixInstall: install,
  })).toThrow(/must be null without a portable WASIX asset/u);
  expect(() => assertWasixExtensionMemberInstall({
    sqlName: "example",
    assets: [portableAsset, portableAsset],
    wasixInstall: install,
  })).toThrow(/must declare exactly one portable WASIX asset/u);
});
