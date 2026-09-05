import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertSourceOnlyNpmArchive,
  prepareSourceOnlyNpmPackage,
  SOURCE_ONLY_NPM_PROFILES,
} from "./source-only-sdk-package.mjs";
import {
  JS_CORE_BUNDLE_FILES,
  JS_CORE_PACKAGE,
} from "../../src/shared/js-core/tools/stage-package.mjs";
import { assertReleaseNoticesInDirectory } from "./release-notices.mjs";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function packageManifest(profile) {
  const manifest = {
    name: profile.name,
    version: "1.2.3",
    license: "MIT",
    files: ["index.js", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    scripts: {
      build: "false",
      prepack: "false",
      test: "false",
      ...profile.scripts,
    },
    dependencies: { [JS_CORE_PACKAGE]: "0.0.0" },
    bundledDependencies: [JS_CORE_PACKAGE],
    devDependencies: { imaginary: "1.0.0" },
  };
  if (profile.optionalDependencyVersions !== undefined) {
    manifest.oliphaunt = Object.fromEntries(
      [...new Set(Object.values(profile.optionalDependencyVersions))].map((field) => [field, "1.2.0"]),
    );
    manifest.optionalDependencies = Object.fromEntries(
      Object.keys(profile.optionalDependencyVersions).map((name) => [name, "workspace:*"]),
    );
  }
  return manifest;
}

function stageCoreFixture(packageDir) {
  const coreDir = path.join(packageDir, "node_modules", "@oliphaunt", "js-core");
  for (const relative of JS_CORE_BUNDLE_FILES) {
    const file = path.join(coreDir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    if (relative === "package.json") {
      writeJson(file, {
        name: JS_CORE_PACKAGE,
        version: "0.0.0",
        private: true,
        files: ["dist/module", "dist/commonjs"],
      });
    } else if (relative.endsWith("/package.json")) {
      writeJson(file, { type: relative.includes("/module/") ? "module" : "commonjs" });
    } else {
      writeFileSync(file, relative === "README.md" ? "# Fixture\n" : "export {};\n", "utf8");
    }
  }
}

function pack(directory, destination) {
  mkdirSync(destination, { recursive: true });
  const result = spawnSync(
    "pnpm",
    ["--dir", directory, "pack", "--pack-destination", destination],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PNPM_CONFIG_IGNORE_SCRIPTS: "true",
        PNPM_CONFIG_NODE_LINKER: "hoisted",
      },
    },
  );
  assert.equal(result.status, 0, `pnpm pack failed:\n${result.stdout}\n${result.stderr}`);
  const archives = readdirSync(destination).filter((entry) => entry.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  return path.join(destination, archives[0]);
}

for (const [profileName, profile] of Object.entries(SOURCE_ONLY_NPM_PROFILES)) {
  test(`${profileName} final npm tarball has exact notices and publish-safe metadata`, () => {
    mkdirSync(path.join(ROOT, "target"), { recursive: true });
    const scratch = mkdtempSync(path.join(ROOT, "target", `source-only-${profileName}-`));
    const packageDir = path.join(scratch, "package");
    try {
      mkdirSync(packageDir, { recursive: true });
      writeJson(path.join(packageDir, "package.json"), packageManifest(profile));
      writeFileSync(path.join(packageDir, "index.js"), "export {};\n", "utf8");
      stageCoreFixture(packageDir);
      prepareSourceOnlyNpmPackage(packageDir, profile);
      prepareSourceOnlyNpmPackage(packageDir, profile);

      const staged = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
      assert.equal(staged.license, "MIT");
      assert.deepEqual(staged.scripts ?? {}, profile.scripts);
      assert.equal(staged.devDependencies, undefined);
      if (profile.optionalDependencyVersions !== undefined) {
        assert.deepEqual(
          staged.optionalDependencies,
          Object.fromEntries(Object.keys(profile.optionalDependencyVersions).map((name) => [name, "1.2.0"])),
        );
      }
      const archive = pack(packageDir, path.join(scratch, "packed"));
      const packed = assertSourceOnlyNpmArchive(archive, profile);
      assert.deepEqual(packed.scripts ?? {}, profile.scripts);
      assert.equal(packed.devDependencies, undefined);

      writeFileSync(path.join(packageDir, "LICENSE"), "not canonical\n", "utf8");
      chmodSync(path.join(packageDir, "LICENSE"), 0o644);
      assert.throws(
        () => assertReleaseNoticesInDirectory(packageDir, { profile: "source-sdk" }),
        /differs byte-for-byte/u,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

test("rejects a symlinked package directory before rewriting its manifest", {
  skip: process.platform === "win32",
}, () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const scratch = mkdtempSync(path.join(ROOT, "target", "source-only-symlink-"));
  try {
    const packageDir = path.join(scratch, "real-package");
    const alias = path.join(scratch, "package-alias");
    mkdirSync(packageDir);
    const manifestFile = path.join(packageDir, "package.json");
    writeJson(manifestFile, packageManifest(SOURCE_ONLY_NPM_PROFILES.js));
    writeFileSync(path.join(packageDir, "index.js"), "export {};\n", "utf8");
    const before = readFileSync(manifestFile);
    symlinkSync(packageDir, alias, "dir");

    assert.throws(
      () => prepareSourceOnlyNpmPackage(alias, SOURCE_ONLY_NPM_PROFILES.js),
      /symlink or non-directory ancestor/u,
    );
    assert.deepEqual(readFileSync(manifestFile), before);
    assert.equal(existsSync(path.join(packageDir, "LICENSE")), false);
    assert.equal(existsSync(path.join(packageDir, "THIRD_PARTY_NOTICES.md")), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
