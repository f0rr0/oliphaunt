import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { createDeterministicTar } from "./cargo-source-package.mjs";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";
import { hasCanonicalReleaseStagingMode } from "./release-notices.mjs";
import {
  auditExtensionUpstreamLicenseSources,
  assertExtensionUpstreamLicensesInEntries,
  assertExtensionUpstreamLicensesInArchive,
  assertExtensionUpstreamLicensesInDirectory,
  assertSupportedExtensionUpstreamSpdxId,
  externalReleaseExtensionSqlNames,
  extensionCarrierLegalContract,
  extensionMavenLicenses,
  extensionQualificationLegalContract,
  extensionRegistryLicense,
  stageExtensionUpstreamLicenses,
  extensionUpstreamLicenseFileInventory,
  extensionUpstreamLicenseRows,
  extensionUpstreamLicenseSources,
  validateExtensionUpstreamLicenseContract,
} from "./extension-upstream-licenses.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("every active external release has an exact upstream license contract", () => {
  const rows = validateExtensionUpstreamLicenseContract();
  assert.deepEqual(rows.map((row) => row.sqlName), externalReleaseExtensionSqlNames());
  assert.deepEqual(rows.map((row) => row.sqlName), [
    "pg_hashids",
    "pg_ivm",
    "pg_textsearch",
    "pg_uuidv7",
    "pgtap",
    "postgis",
    "vector",
  ]);
  for (const row of rows) {
    assert.ok(row.files.length > 0, `${row.sqlName} must ship at least one license file`);
    assert.equal(new Set(row.files.map((file) => file.destination)).size, row.files.length);
  }
  assert.deepEqual(extensionUpstreamLicenseSources().map((source) => source.id), [
    "geos",
    "json-c",
    "libiconv",
    "libxml2",
    "pg_hashids",
    "pg_ivm",
    "pg_textsearch",
    "pg_uuidv7",
    "pgtap",
    "pgvector",
    "postgis",
    "proj",
    "sqlite",
  ]);
});

test("npm extension legal inventory binds canonical paths, bytes, and modes", () => {
  const row = extensionUpstreamLicenseRows().find(({ sqlName }) => sqlName === "pg_uuidv7");
  assert.ok(row, "pg_uuidv7 must have canonical upstream legal metadata");
  assert.deepEqual(
    extensionUpstreamLicenseFileInventory(["pg_uuidv7"]),
    row.files.map((file) => ({
      path: file.destination,
      sha256: file.sha256,
      mode: "0644",
    })),
  );
  const postgis = extensionUpstreamLicenseFileInventory(["postgis"]);
  assert.deepEqual(postgis.map(({ path: member }) => member), [...postgis]
    .map(({ path: member }) => member)
    .sort());
  assert.equal(Object.isFrozen(postgis), true);
  assert.equal(postgis.every(Object.isFrozen), true);
  assert.throws(
    () => extensionUpstreamLicenseFileInventory([]),
    /requires a non-empty unique extension member list/u,
  );
});

test("each external product owns an exact self-contained legal-data closure", () => {
  const externalRoot = path.join(ROOT, "src/extensions/external");
  const files = readdirSync(externalRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(externalRoot, entry.name, "upstream-license-data.json"))
    .filter(existsSync)
    .sort();
  assert.equal(files.length, 7);
  for (const file of files) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const owner = path.basename(path.dirname(file));
    assert.equal(data.extension.sql_name, owner, file);
    const referencedSources = [...new Set(data.extension.files.map((row) => row.source))].sort();
    assert.deepEqual(data.sources.map((row) => row.id), referencedSources, file);
    const referencedBlobs = [...new Set(data.extension.files.map((row) => row.sha256))].sort();
    assert.deepEqual(Object.keys(data.blobs), referencedBlobs, file);
  }
  assert.equal(existsSync(path.join(externalRoot, "upstream-licenses.toml")), false);
  assert.equal(existsSync(path.join(externalRoot, "upstream-license-blobs.json")), false);
});

test("committed legal bytes stage every active external release without source checkouts", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "external-license-clean-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missingCheckouts = path.join(root, "intentionally-absent-checkouts");
  const script = `
    import { mkdirSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { gzipSync } from "node:zlib";
    import { createDeterministicTar } from ${JSON.stringify(path.join(ROOT, "tools/release/cargo-source-package.mjs"))};
    import {
      assertExtensionUpstreamLicensesInArchive,
      assertExtensionUpstreamLicensesInDirectory,
      externalReleaseExtensionSqlNames,
      stageExtensionUpstreamLicenses,
    } from ${JSON.stringify(path.join(ROOT, "tools/release/extension-upstream-licenses.mjs"))};
    const root = process.env.OLIPHAUNT_CLEAN_LEGAL_STAGE;
    for (const sqlName of externalReleaseExtensionSqlNames()) {
      const stage = path.join(root, sqlName);
      mkdirSync(stage, { recursive: true });
      const staged = stageExtensionUpstreamLicenses(sqlName, stage);
      const checked = assertExtensionUpstreamLicensesInDirectory([sqlName], stage);
      if (JSON.stringify(staged) !== JSON.stringify(checked)) throw new Error(sqlName + " staged legal bytes differ");
      const archive = path.join(root, sqlName + ".tar.gz");
      writeFileSync(archive, gzipSync(createDeterministicTar(stage, sqlName, {
        fail(message) { throw new Error(message); },
      }), { mtime: 0 }));
      const packed = assertExtensionUpstreamLicensesInArchive([sqlName], archive, { prefix: sqlName });
      if (JSON.stringify(packed) !== JSON.stringify(staged.map((member) => sqlName + "/" + member))) {
        throw new Error(sqlName + " archived legal bytes differ");
      }
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      OLIPHAUNT_CLEAN_LEGAL_STAGE: root,
      OLIPHAUNT_EXTENSION_SOURCE_CHECKOUT_ROOT: missingCheckouts,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(missingCheckouts), false);
});

test("available pinned source checkouts match committed legal bytes", () => {
  if (!existsSync(path.join(ROOT, "target/oliphaunt-sources/checkouts/pg_hashids/.git"))) return;
  assert.ok(auditExtensionUpstreamLicenseSources() > 0);
});

test("the contract retains dependency licenses and pgtap's complete upstream grant", () => {
  const rows = extensionUpstreamLicenseRows();
  const postgis = rows.find((row) => row.sqlName === "postgis");
  assert.deepEqual([...new Set(postgis.files.map((file) => file.checkout))], [
    "geos",
    "json-c",
    "libiconv",
    "libxml2",
    "postgis",
    "proj",
    "sqlite",
  ]);
  assert.deepEqual(
    postgis.files.filter((file) => file.checkout === "libiconv").map((file) => file.path),
    ["libcharset/COPYING.LIB", "COPYING.LIB"],
  );
  assert.deepEqual(
    postgis.files
      .filter((file) => file.checkout === "geos" && file.path.startsWith("src/deps/ryu/"))
      .map((file) => file.path),
    ["src/deps/ryu/LICENSE", "src/deps/ryu/LICENSE-Apache2", "src/deps/ryu/LICENSE-Boost"],
  );
  assert.deepEqual(
    postgis.files
      .filter((file) => file.checkout === "postgis")
      .map((file) => file.path),
    [
      "COPYING",
      "LICENSE.TXT",
      "deps/flatgeobuf/include/flatbuffers/LICENSE",
      "deps/ryu/LICENSE",
      "deps/ryu/LICENSE-Apache2",
      "deps/ryu/LICENSE-Boost",
    ],
  );
  const pgtap = rows.find((row) => row.sqlName === "pgtap");
  assert.equal(pgtap.files.length, 1);
  assert.equal(pgtap.files[0].path, "README.md");
  const source = path.join(ROOT, "target/oliphaunt-sources/checkouts/pgtap/README.md");
  try {
    const text = readFileSync(source, "utf8");
    assert.match(text, /Permission to use, copy, modify, and distribute/u);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
});

test("registry metadata derives external and contrib SPDX expressions from the same contract", () => {
  assert.deepEqual(
    extensionRegistryLicense("oliphaunt-extension-pg-uuidv7", ["pg_uuidv7"]),
    {
      product: "oliphaunt-extension-pg-uuidv7",
      upstreamSpdx: "MPL-2.0",
      packageSpdx: "MIT AND MPL-2.0",
    },
  );
  assert.deepEqual(
    extensionRegistryLicense("oliphaunt-extension-postgis", ["postgis"]),
    {
      product: "oliphaunt-extension-postgis",
      upstreamSpdx: "MIT AND Apache-2.0 AND GPL-2.0-or-later AND LGPL-2.1-or-later AND blessing",
      packageSpdx: "MIT AND Apache-2.0 AND GPL-2.0-or-later AND LGPL-2.1-or-later AND blessing",
    },
  );
  assert.throws(
    () => extensionQualificationLegalContract("postgis", {
      family: "native",
      target: "android-arm64-v8a",
    }),
    /postgis is not a canonical publication-deferred qualification candidate/u,
  );
  assert.deepEqual(
    extensionRegistryLicense("oliphaunt-extension-contrib-pg18", ["hstore", "pgcrypto"]),
    {
      product: "oliphaunt-extension-contrib-pg18",
      upstreamSpdx: "PostgreSQL",
      packageSpdx: "MIT AND PostgreSQL",
    },
  );
  assert.deepEqual(
    extensionRegistryLicense("oliphaunt-extension-pg-hashids", ["pg_hashids"]).packageSpdx,
    "MIT",
  );
  const maven = extensionMavenLicenses(
    "oliphaunt-extension-pg-uuidv7",
    ["pg_uuidv7"],
    { version: "0.1.0" },
  );
  assert.deepEqual(maven.map((entry) => entry.name), ["MIT License (Oliphaunt)", "MPL-2.0 (pg_uuidv7)"]);
  assert.match(maven[0].url, /\/blob\/oliphaunt-extension-pg-uuidv7-v0\.1\.0\/LICENSE$/u);
  assert.match(maven[1].url, /c707aae2411181be4802f5fa565b44d9c0bcbc29\/LICENSE$/u);
});

test("carrier legal roles derive exact contrib and external payload closure", () => {
  assert.deepEqual(
    extensionCarrierLegalContract(
      "oliphaunt-extension-contrib-pg18",
      ["hstore", "pgcrypto"],
      { family: "native", target: "linux-x64-gnu" },
    ),
    {
      profile: "contrib-native",
      packageSpdx: "MIT AND PostgreSQL",
      upstreamMembers: [],
      licenseFiles: [],
    },
  );
  assert.equal(
    extensionCarrierLegalContract(
      "oliphaunt-extension-contrib-pg18",
      ["hstore", "pgcrypto"],
      { family: "wasix", target: "wasix" },
    ).profile,
    "contrib-wasix-openssl",
  );
  const postgis = extensionCarrierLegalContract(
    "oliphaunt-extension-postgis",
    ["postgis"],
    { family: "native", target: "android-arm64-v8a" },
  );
  assert.equal(postgis.profile, "external-native");
  assert.throws(
    () => extensionQualificationLegalContract(
      "postgis",
      { family: "native", target: "unsupported-target" },
    ),
    /postgis is not a canonical publication-deferred qualification candidate/u,
  );
  assert.deepEqual(postgis.upstreamMembers, ["postgis"]);
  assert.deepEqual(postgis.licenseFiles, [
    "share/licenses/geos/COPYING",
    "share/licenses/geos/src/deps/ryu/LICENSE",
    "share/licenses/geos/src/deps/ryu/LICENSE-Apache2",
    "share/licenses/geos/src/deps/ryu/LICENSE-Boost",
    "share/licenses/json-c/COPYING",
    "share/licenses/libcharset/COPYING.LIB",
    "share/licenses/libiconv/COPYING.LIB",
    "share/licenses/libxml2/Copyright",
    "share/licenses/postgis/COPYING",
    "share/licenses/postgis/LICENSE.TXT",
    "share/licenses/postgis/deps/flatgeobuf/flatbuffers/LICENSE",
    "share/licenses/postgis/deps/ryu/LICENSE",
    "share/licenses/postgis/deps/ryu/LICENSE-Apache2",
    "share/licenses/postgis/deps/ryu/LICENSE-Boost",
    "share/licenses/proj/COPYING",
    "share/licenses/sqlite/LICENSE.md",
  ]);
  assert.deepEqual(
    extensionCarrierLegalContract(
      "oliphaunt-extension-vector",
      ["vector"],
      { carriesPayload: false },
    ),
    {
      profile: "code-facade",
      packageSpdx: "MIT",
      upstreamMembers: [],
      licenseFiles: [],
    },
  );
});

test("SPDX metadata fails closed to the identifiers supported by the carrier contract", () => {
  assert.equal(assertSupportedExtensionUpstreamSpdxId("MPL-2.0"), "MPL-2.0");
  assert.throws(
    () => assertSupportedExtensionUpstreamSpdxId("Unknown-License-1.0"),
    /must declare one supported SPDX identifier/u,
  );
});

test("staging verifies committed bytes, mode, and directory safety", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "extension-license-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, "stage");
  const staged = stageExtensionUpstreamLicenses("pg_hashids", stage);
  assert.deepEqual(staged, ["share/licenses/pg_hashids/LICENSE"]);
  const output = path.join(stage, staged[0]);
  assert.equal(hasCanonicalReleaseStagingMode(lstatSync(output).mode), true);
  assert.equal(
    createHash("sha256").update(readFileSync(output)).digest("hex"),
    extensionUpstreamLicenseRows().find(({ sqlName }) => sqlName === "pg_hashids").files[0].sha256,
  );
  assert.deepEqual(assertExtensionUpstreamLicensesInDirectory(["pg_hashids"], stage), staged);

  const archive = path.join(root, "pg-hashids.crate");
  writeFileSync(archive, gzipSync(createDeterministicTar(stage, "pg-hashids-0.1.0", {
    fail(message) {
      throw new Error(message);
    },
  }), { mtime: 0 }));
  assert.deepEqual(
    assertExtensionUpstreamLicensesInArchive(["pg_hashids"], archive, { prefix: "pg-hashids-0.1.0" }),
    ["pg-hashids-0.1.0/share/licenses/pg_hashids/LICENSE"],
  );

  const entries = readPortableArchiveEntries(archive);
  const assertion = (mutated) => assertExtensionUpstreamLicensesInEntries(
    ["pg_hashids"],
    mutated,
    { prefix: "pg-hashids-0.1.0" },
  );
  const inject = (member, entry) => new Map([...entries, [member, entry]]);
  const fakeEntry = (overrides = {}) => ({
    data: () => Buffer.from("unexpected"),
    isDirectory: false,
    isFile: true,
    isSymbolicLink: false,
    mode: 0o644,
    ...overrides,
  });
  assert.throws(
    () => assertion(inject("pg-hashids-0.1.0/share/licenses/unknown/LICENSE", fakeEntry())),
    /unexpected file member/u,
  );
  assert.throws(
    () => assertion(inject(
      "pg-hashids-0.1.0/share/licenses/unknown",
      fakeEntry({ isDirectory: true, isFile: false, mode: 0o755 }),
    )),
    /unexpected directory member/u,
  );
  assert.throws(
    () => assertion(inject(
      "pg-hashids-0.1.0/share/licenses/unknown-link",
      fakeEntry({ isFile: false, isSymbolicLink: true, mode: 0o777 }),
    )),
    /unexpected symlink member/u,
  );
  assert.throws(
    () => assertion(inject(
      "pg-hashids-0.1.0/share/licenses/unknown-special",
      fakeEntry({ isFile: false, mode: 0o600 }),
    )),
    /unexpected special member/u,
  );
  const wrongDirectoryMode = new Map(entries);
  const directoryMember = "pg-hashids-0.1.0/share/licenses/pg_hashids";
  wrongDirectoryMode.set(directoryMember, {
    ...wrongDirectoryMode.get(directoryMember),
    mode: 0o700,
  });
  assert.throws(() => assertion(wrongDirectoryMode), /directory must be a real mode-0755/u);

  const privilegedFileMode = new Map(entries);
  const licenseMember = "pg-hashids-0.1.0/share/licenses/pg_hashids/LICENSE";
  privilegedFileMode.set(licenseMember, {
    ...privilegedFileMode.get(licenseMember),
    mode: 0o4644,
  });
  assert.throws(
    () => assertion(privilegedFileMode),
    /must be a regular non-symlink mode-0644 file/u,
  );

  const missingAssertionRoot = path.join(root, "missing-parent", "missing-stage");
  assert.throws(
    () => assertExtensionUpstreamLicensesInDirectory(["pg_hashids"], missingAssertionRoot),
    /assertion directory cannot be inspected/u,
  );
  assert.equal(existsSync(path.join(root, "missing-parent")), false);

  const unsafe = path.join(root, "unsafe");
  const outside = path.join(root, "outside");
  mkdirSync(unsafe);
  mkdirSync(outside);
  symlinkSync(outside, path.join(unsafe, "share"));
  assert.throws(
    () => stageExtensionUpstreamLicenses("pg_hashids", unsafe),
    /staging parent must be a real directory/u,
  );

  const realAncestor = path.join(root, "real-ancestor");
  const existingStage = path.join(realAncestor, "existing-stage");
  mkdirSync(existingStage, { recursive: true });
  const linkedAncestor = path.join(root, "linked-ancestor");
  symlinkSync(realAncestor, linkedAncestor);
  assert.throws(
    () => stageExtensionUpstreamLicenses("pg_hashids", path.join(linkedAncestor, "existing-stage")),
    /staging directory must be a real directory/u,
  );
});

test("the public PostGIS carrier's compiled-component legal atoms are pinned, staged, and exact in archives", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "postgis-license-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, "stage");
  const expected = extensionCarrierLegalContract(
    "oliphaunt-extension-postgis",
    ["postgis"],
    { family: "wasix", target: "wasix-portable" },
  ).licenseFiles;
  assert.deepEqual(stageExtensionUpstreamLicenses("postgis", stage), expected);
  assert.deepEqual(assertExtensionUpstreamLicensesInDirectory(["postgis"], stage), expected);

  const archive = path.join(root, "postgis.tar.gz");
  writeFileSync(archive, gzipSync(createDeterministicTar(stage, "postgis", {
    fail(message) {
      throw new Error(message);
    },
  }), { mtime: 0 }));
  assert.deepEqual(
    assertExtensionUpstreamLicensesInArchive(["postgis"], archive, { prefix: "postgis" }),
    expected.map((member) => `postgis/${member}`),
  );
});
