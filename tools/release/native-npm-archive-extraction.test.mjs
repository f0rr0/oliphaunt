import { expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractArchiveTree } from "./local-registry-publish.mjs";
import { extractReleaseArchiveTree } from "./release-product-dry-run.mjs";
import { ROOT } from "./release-cli-utils.mjs";

const ARCHIVER = path.join(ROOT, "tools/release/archive_dir.mjs");
const NATIVE_PACKAGE_ROOT = path.join(ROOT, "src/runtimes/liboliphaunt/native/packages");
const REQUIRED_LEGAL_FILES = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_NOTICES.liboliphaunt-native.md",
  "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT",
  "THIRD_PARTY_LICENSES/ICU-LICENSE",
];

function writeFixtureFile(root, relativePath, contents) {
  const file = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

test("native npm ZIP assembly preserves complete nested runtime trees", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-npm-zip-tree-"));
  try {
    const source = path.join(root, "source");
    const archive = path.join(root, "native.zip");
    const runtimeFiles = new Map([
      ["bin/initdb.exe", "initdb\n"],
      ["bin/pg_ctl.exe", "pg_ctl\n"],
      ["bin/postgres.exe", "postgres\n"],
      ["lib/postgresql/plpgsql.dll", "plpgsql\n"],
      ["share/postgresql/postgres.bki", "catalog\n"],
      ["share/postgresql/timezone/Africa/Abidjan", "timezone\n"],
    ]);
    for (const [relativePath, contents] of runtimeFiles) {
      writeFixtureFile(path.join(source, "runtime"), relativePath, contents);
    }
    writeFixtureFile(source, "lib/modules/plpgsql.dll", "embedded plpgsql\n");
    writeFixtureFile(source, "outside/not-packaged.txt", "outside\n");

    const packed = spawnSync(process.execPath, [ARCHIVER, source, archive], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(packed.status, packed.stderr || packed.stdout).toBe(0);

    const stages = [
      ["exact-candidate", extractArchiveTree],
      ["release-dry-run", extractReleaseArchiveTree],
    ];
    for (const [name, extract] of stages) {
      const stage = path.join(root, name, "runtime");
      extract(archive, "runtime", stage);
      for (const [relativePath, contents] of runtimeFiles) {
        expect(readFileSync(path.join(stage, ...relativePath.split("/")), "utf8")).toBe(contents);
      }
      const modules = path.join(root, name, "lib/modules");
      extract(archive, "lib/modules", modules);
      expect(readFileSync(path.join(modules, "plpgsql.dll"), "utf8")).toBe("embedded plpgsql\n");
      expect(existsSync(path.join(root, name, "outside", "not-packaged.txt"))).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native npm descriptors publish every staged payload root", () => {
  const descriptors = readdirSync(NATIVE_PACKAGE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(NATIVE_PACKAGE_ROOT, entry.name, "package.json"))
    .filter(existsSync)
    .sort();

  expect(descriptors.length).toBe(4);
  for (const descriptor of descriptors) {
    const packageJson = JSON.parse(readFileSync(descriptor, "utf8"));
    const libraryRoot = packageJson.oliphaunt?.libraryRelativePath?.split("/")[0];
    const runtimeRoot = packageJson.oliphaunt?.runtimeRelativePath?.split("/")[0];
    const expected = [
      ...new Set([libraryRoot, "lib", runtimeRoot, "README.md", ...REQUIRED_LEGAL_FILES]),
    ].sort();
    expect(packageJson.files?.slice().sort(), descriptor).toEqual(expected);
  }
});
