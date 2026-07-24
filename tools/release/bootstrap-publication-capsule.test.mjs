#!/usr/bin/env bun

import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOOTSTRAP_CAPSULE_LOCK_PATH,
  BOOTSTRAP_CAPSULE_MANIFEST_PATH,
  packBootstrapCapsule,
  verifyExtractBootstrapCapsule,
} from "./bootstrap-publication-capsule.mjs";
import {
  buildPublicationCandidate,
  freezePublicationCandidate,
} from "./publication-lock.mjs";
import { loadPublicationCatalog } from "./publication-catalog.mjs";
import { ROOT } from "./release-graph.mjs";

const PRODUCTS = ["oliphaunt-rust", "oliphaunt-js"];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function tarGzip(output, cwd, member) {
  const result = spawnSync("tar", ["-czf", output, "-C", cwd, member], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function cargoFixture(stageRoot, artifacts, name, version) {
  const directoryName = `${name}-${version}`;
  const stage = path.join(stageRoot, directoryName);
  mkdirSync(path.join(stage, "src"), { recursive: true });
  writeFileSync(
    path.join(stage, "Cargo.toml"),
    `[package]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\nedition = "2024"\n`,
  );
  writeFileSync(path.join(stage, "src/lib.rs"), `pub const NAME: &str = ${JSON.stringify(name)};\n`);
  const output = path.join(artifacts, `${directoryName}.crate`);
  tarGzip(output, stageRoot, directoryName);
  return output;
}

function npmFixture(stageRoot, artifacts, name, version) {
  const stage = path.join(stageRoot, "npm", "package");
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, "index.js"), "export const fixture = true;\n");
  writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({
    name,
    version,
    type: "module",
    repository: {
      type: "git",
      url: "git+https://github.com/f0rr0/oliphaunt.git",
    },
    publishConfig: {
      access: "public",
      provenance: true,
    },
  }, null, 2)}\n`);
  const output = path.join(artifacts, "oliphaunt-ts.tgz");
  tarGzip(output, path.dirname(stage), "package");
  return output;
}

function jsrFixture(artifacts, name, version) {
  const directory = path.join(artifacts, "jsr-package");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "jsr.json"), `${JSON.stringify({
    name,
    version,
    exports: "./mod.ts",
    publish: { include: ["jsr.json", "mod.ts"] },
  }, null, 2)}\n`);
  writeFileSync(path.join(directory, "mod.ts"), "export const fixture = true;\n");
}

function mavenFixture(artifacts, group, name, version) {
  const directory = path.join(artifacts, "maven", ...group.split("."), name, version);
  mkdirSync(directory, { recursive: true });
  const basename = `${name}-${version}`;
  const packaging = name.endsWith(".gradle.plugin") ? "pom" : "jar";
  writeFileSync(
    path.join(directory, `${basename}.pom`),
    `<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${name}</artifactId><version>${version}</version><packaging>${packaging}</packaging><name>Fixture</name><description>Fixture publication</description><url>https://github.com/f0rr0/oliphaunt</url><licenses><license><name>MIT</name><url>https://opensource.org/license/mit</url></license></licenses><developers><developer><name>Fixture Maintainer</name><url>https://github.com/f0rr0</url></developer></developers><scm><connection>scm:git:https://github.com/f0rr0/oliphaunt.git</connection><developerConnection>scm:git:ssh://git@github.com/f0rr0/oliphaunt.git</developerConnection><url>https://github.com/f0rr0/oliphaunt</url></scm></project>\n`,
  );
  if (packaging !== "pom") {
    writeFileSync(path.join(directory, `${basename}.jar`), `fixture:${group}:${name}:${version}\n`);
    writeFileSync(path.join(directory, `${basename}-sources.jar`), "fixture sources\n");
    writeFileSync(path.join(directory, `${basename}-javadoc.jar`), "fixture javadocs\n");
  }
}

function fixture() {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "bootstrap-capsule-test-"));
  const stage = path.join(root, "stage");
  const artifacts = path.join(root, "artifacts");
  mkdirSync(stage, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const catalog = loadPublicationCatalog("bootstrap-publication-capsule.test", { products: PRODUCTS });
  const versions = new Map(catalog.products.map(({ id, version }) => [id, version]));
  const cargo = [
    cargoFixture(stage, artifacts, "oliphaunt", versions.get("oliphaunt-rust")),
    cargoFixture(stage, artifacts, "oliphaunt-build", versions.get("oliphaunt-rust")),
  ];
  const npm = npmFixture(stage, artifacts, "@oliphaunt/ts", versions.get("oliphaunt-js"));
  jsrFixture(artifacts, "@oliphaunt/ts", versions.get("oliphaunt-js"));
  const lock = freezePublicationCandidate(buildPublicationCandidate({
    products: PRODUCTS,
    artifactRoots: [artifacts],
    headRef: "HEAD",
  }));
  const lockFile = path.join(root, "publication-lock.json");
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  return { root, lock, lockFile, cargo, npm };
}

function mavenOnlyFixture() {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "bootstrap-capsule-empty-test-"));
  const artifacts = path.join(root, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const products = ["oliphaunt-kotlin"];
  const catalog = loadPublicationCatalog("bootstrap-publication-capsule.empty.test", { products });
  const version = catalog.products[0].version;
  for (const carrier of catalog.carriers) {
    const separator = carrier.name.indexOf(":");
    mavenFixture(
      artifacts,
      carrier.name.slice(0, separator),
      carrier.name.slice(separator + 1),
      version,
    );
  }
  const lock = freezePublicationCandidate(buildPublicationCandidate({
    products,
    artifactRoots: [artifacts],
    headRef: "HEAD",
  }));
  const lockFile = path.join(root, "publication-lock.json");
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  return { root, lock, lockFile, products };
}

function workspace() {
  return mkdtempSync(path.join(os.tmpdir(), "oliphaunt-bootstrap-capsule-workspace-"));
}

function mutateTarPayload(source, destination, member, replacement) {
  const bytes = Buffer.from(readFileSync(source));
  let position = 0;
  for (;;) {
    const header = bytes.subarray(position, position + 512);
    assert.equal(header.length, 512);
    if (header.every((byte) => byte === 0)) break;
    const nul = header.indexOf(0, 0);
    const name = header.subarray(0, nul === -1 || nul > 100 ? 100 : nul).toString("utf8");
    const prefixNul = header.indexOf(0, 345);
    const prefix = header.subarray(345, prefixNul === -1 || prefixNul > 500 ? 500 : prefixNul).toString("utf8");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim();
    const size = Number.parseInt(sizeText, 8);
    if (fullName === member) {
      const payload = bytes.subarray(position + 512, position + 512 + size);
      const changed = replacement(Buffer.from(payload));
      assert.equal(changed.length, payload.length, "payload mutation must preserve tar member size");
      changed.copy(bytes, position + 512);
      writeFileSync(destination, bytes);
      return;
    }
    position += 512 + Math.ceil(size / 512) * 512;
  }
  assert.fail(`archive member not found: ${member}`);
}

test("packs a deterministic exact Cargo/npm capsule and atomically installs it", () => {
  const value = fixture();
  const first = path.join(value.root, "first.tar");
  const second = path.join(value.root, "second.tar");
  const output = workspace();
  try {
    const manifest = packBootstrapCapsule({
      lockFile: value.lockFile,
      products: PRODUCTS,
      output: first,
    });
    packBootstrapCapsule({ lockFile: value.lockFile, products: PRODUCTS, output: second });
    assert.equal(sha256(first), sha256(second), "capsule must be byte-for-byte deterministic");
    assert.equal(manifest.carriers.length, 3);
    assert.deepEqual(manifest.carriers.map(({ ecosystem }) => ecosystem).sort(), ["cargo", "cargo", "npm"]);

    const installed = verifyExtractBootstrapCapsule({
      transport: first,
      approvedLock: value.lockFile,
      products: PRODUCTS,
      workspaceRoot: output,
    });
    assert.equal(installed.lockDigest, value.lock.lockDigest);
    assert.deepEqual(
      readFileSync(path.join(output, ...BOOTSTRAP_CAPSULE_LOCK_PATH.split("/"))),
      readFileSync(value.lockFile),
    );
    assert.equal(lstatSync(path.join(output, ...BOOTSTRAP_CAPSULE_MANIFEST_PATH.split("/"))).isFile(), true);
    for (const source of [...value.cargo, value.npm]) {
      const carrier = manifest.carriers.find(({ artifact }) => artifact.sha256 === sha256(source));
      assert.ok(carrier);
      assert.equal(
        sha256(path.join(output, ...carrier.artifact.path.split("/"))),
        carrier.artifact.sha256,
      );
    }
    assert.equal(readFileSync(first).includes(Buffer.from("jsr-package/mod.ts")), false, "JSR bytes must not enter the capsule");
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("packs and verifies a deterministic empty capsule for a Maven-only release", () => {
  const value = mavenOnlyFixture();
  const first = path.join(value.root, "first.tar");
  const second = path.join(value.root, "second.tar");
  const output = workspace();
  try {
    const manifest = packBootstrapCapsule({
      lockFile: value.lockFile,
      products: value.products,
      output: first,
    });
    packBootstrapCapsule({ lockFile: value.lockFile, products: value.products, output: second });
    assert.deepEqual(manifest.carriers, []);
    assert.equal(sha256(first), sha256(second));
    const installed = verifyExtractBootstrapCapsule({
      transport: first,
      approvedLock: value.lockFile,
      products: value.products,
      workspaceRoot: output,
    });
    assert.deepEqual(installed.carriers, []);
    assert.deepEqual(
      readFileSync(path.join(output, ...BOOTSTRAP_CAPSULE_LOCK_PATH.split("/"))),
      readFileSync(value.lockFile),
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("fails closed on selection drift, external-lock drift, and a preexisting destination", () => {
  const value = fixture();
  const capsule = path.join(value.root, "capsule.tar");
  const output = workspace();
  try {
    assert.throws(
      () => packBootstrapCapsule({ lockFile: value.lockFile, products: [PRODUCTS[0]], output: capsule }),
      /selected products do not exactly match/u,
    );
    packBootstrapCapsule({ lockFile: value.lockFile, products: PRODUCTS, output: capsule });
    const changedLock = path.join(value.root, "changed-lock.json");
    copyFileSync(value.lockFile, changedLock);
    writeFileSync(changedLock, `${readFileSync(changedLock, "utf8").trimEnd()}  \n`);
    assert.throws(
      () => verifyExtractBootstrapCapsule({
        transport: capsule,
        approvedLock: changedLock,
        products: PRODUCTS,
        workspaceRoot: output,
      }),
      /not byte-identical/u,
    );
    assert.equal(lstatSync(output).isDirectory(), true);
    assert.throws(() => lstatSync(path.join(output, "target")), /ENOENT/u);

    mkdirSync(path.join(output, "target"));
    assert.throws(
      () => verifyExtractBootstrapCapsule({
        transport: capsule,
        approvedLock: value.lockFile,
        products: PRODUCTS,
        workspaceRoot: output,
      }),
      /requires an absent destination/u,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("rejects tampered manifests and carrier bytes without installing partial output", () => {
  const value = fixture();
  const capsule = path.join(value.root, "capsule.tar");
  const manifestTamper = path.join(value.root, "manifest-tamper.tar");
  const carrierTamper = path.join(value.root, "carrier-tamper.tar");
  const firstOutput = workspace();
  const secondOutput = workspace();
  try {
    const manifest = packBootstrapCapsule({ lockFile: value.lockFile, products: PRODUCTS, output: capsule });
    mutateTarPayload(capsule, manifestTamper, BOOTSTRAP_CAPSULE_MANIFEST_PATH, (bytes) => {
      const marker = Buffer.from("oliphaunt-bootstrap-publication-capsule-v1");
      const index = bytes.indexOf(marker);
      assert.ok(index >= 0);
      bytes[index] = "x".charCodeAt(0);
      return bytes;
    });
    mutateTarPayload(capsule, carrierTamper, manifest.carriers[0].artifact.path, (bytes) => {
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      return bytes;
    });

    assert.throws(
      () => verifyExtractBootstrapCapsule({
        transport: manifestTamper,
        approvedLock: value.lockFile,
        products: PRODUCTS,
        workspaceRoot: firstOutput,
      }),
      /manifest does not exactly describe|file set or bytes differ/u,
    );
    assert.throws(() => lstatSync(path.join(firstOutput, "target")), /ENOENT/u);
    assert.throws(
      () => verifyExtractBootstrapCapsule({
        transport: carrierTamper,
        approvedLock: value.lockFile,
        products: PRODUCTS,
        workspaceRoot: secondOutput,
      }),
      /bytes do not match|file set or bytes differ/u,
    );
    assert.throws(() => lstatSync(path.join(secondOutput, "target")), /ENOENT/u);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(firstOutput, { recursive: true, force: true });
    rmSync(secondOutput, { recursive: true, force: true });
  }
});

test("rejects symlinked frozen inputs before producing a capsule", () => {
  const value = fixture();
  const output = path.join(value.root, "capsule.tar");
  const carrier = value.lock.carriers.find(({ ecosystem }) => ecosystem === "cargo");
  const artifact = path.resolve(ROOT, carrier.artifacts[0].path);
  const replacement = path.join(value.root, "replacement.crate");
  try {
    copyFileSync(artifact, replacement);
    unlinkSync(artifact);
    symlinkSync(replacement, artifact);
    assert.throws(
      () => packBootstrapCapsule({ lockFile: value.lockFile, products: PRODUCTS, output }),
      /regular non-symlink|open .* safely/u,
    );
    assert.throws(() => lstatSync(output), /ENOENT/u);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
