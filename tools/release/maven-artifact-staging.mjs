#!/usr/bin/env bun

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { currentProductVersionSync } from "./release-artifact-targets.mjs";

import { createDeterministicZip } from "../../src/shared/artifact-packaging/archive-directory.mjs";
import {
  createSiblingStage,
  promoteDirectory,
  removeTemporaryPath,
} from "./atomic-directory.mjs";
import { validateMavenCentralPublication } from "./maven-central-contract.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const TOOL = "maven-artifact-staging.mjs";
const TOKEN = /^[A-Za-z0-9_.-]+$/u;
const GROUP_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MANIFEST = "Manifest-Version: 1.0\r\n\r\n";

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function relative(file) {
  const value = path.relative(ROOT, file);
  return value.startsWith("..") || path.isAbsolute(value)
    ? file.split(path.sep).join("/")
    : value.split(path.sep).join("/");
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0 || CONTROL.test(value)) {
    throw error(`${label} must be non-empty text without control characters`);
  }
  return value;
}

function token(value, label) {
  requiredText(value, label);
  if (!TOKEN.test(value) || value === "." || value === "..") {
    throw error(`${label} must be a portable non-dot Maven coordinate token`);
  }
  return value;
}

function mavenGroupId(value, label) {
  requiredText(value, label);
  const segments = value.split(".");
  if (segments.some((segment) => !GROUP_SEGMENT.test(segment))) {
    throw error(`${label} must contain non-empty dot-separated portable Maven coordinate segments`);
  }
  return value;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseLicenses(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw error(`${label} must be valid JSON: ${cause.message}`);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw error(`${label} must be a non-empty JSON array`);
  }
  for (const [index, license] of value.entries()) {
    const entry = `${label} entry ${index + 1}`;
    if (
      license === null
      || Array.isArray(license)
      || typeof license !== "object"
      || JSON.stringify(Object.keys(license)) !== JSON.stringify(["name", "url", "distribution"])
    ) {
      throw error(`${entry} must contain exactly name, url, distribution in canonical order`);
    }
    requiredText(license.name, `${entry}.name`);
    const url = requiredText(license.url, `${entry}.url`);
    if (!url.startsWith("https://")) throw error(`${entry}.url must use HTTPS`);
    if (license.distribution !== "repo") throw error(`${entry}.distribution must be repo`);
  }
  if (raw !== JSON.stringify(value)) {
    throw error(`${label} must use canonical compact JSON`);
  }
  return value;
}

function requireArtifact(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (cause) {
    throw error(`${label} is missing: ${cause.message}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw error(`${label} must be a non-empty regular non-symlink file`);
  }
}

export function parseMavenArtifactManifest(file) {
  requireArtifact(file, `${relative(file)} Maven artifact manifest`);
  const rows = readFileSync(file, "utf8").split(/\r?\n/u).filter((line) => line.length > 0);
  if (rows.length === 0) throw error(`${relative(file)} Maven artifact manifest is empty`);
  const coordinates = new Set();
  return rows.map((line, index) => {
    const label = `${relative(file)} line ${index + 1}`;
    const fields = line.split("\t");
    if (fields.length !== 10) throw error(`${label} must contain exactly ten tab-separated fields`);
    const [
      groupId,
      artifactId,
      version,
      rawArtifact,
      name,
      description,
      runtimeProduct,
      runtimeVersion,
      licenseSpdx,
      licensesJson,
    ] = fields;
    mavenGroupId(groupId, `${label} groupId`);
    token(artifactId, `${label} artifactId`);
    token(version, `${label} version`);
    const coordinate = `${groupId}:${artifactId}:${version}`;
    if (coordinates.has(coordinate)) throw error(`${label} repeats Maven coordinate ${coordinate}`);
    coordinates.add(coordinate);
    requiredText(rawArtifact, `${label} artifact path`);
    if (!rawArtifact.endsWith(".tar.gz") && !rawArtifact.endsWith(".java")) throw error(`${label} artifact must be a .tar.gz payload or descriptor .java source`);
    const artifact = path.isAbsolute(rawArtifact) ? rawArtifact : path.resolve(ROOT, rawArtifact);
    requireArtifact(artifact, `${label} artifact ${relative(artifact)}`);
    requiredText(name, `${label} name`);
    requiredText(description, `${label} description`);
    if ((runtimeProduct.length === 0) !== (runtimeVersion.length === 0)) {
      throw error(`${label} must declare both runtime product and version or neither`);
    }
    if (runtimeProduct.length > 0) {
      token(runtimeProduct, `${label} runtime product`);
      token(runtimeVersion, `${label} runtime version`);
    }
    requiredText(licenseSpdx, `${label} SPDX expression`);
    const licenses = parseLicenses(licensesJson, `${label} licenses`);
    return Object.freeze({
      artifact,
      artifactId,
      description,
      groupId,
      licenses,
      licenseSpdx,
      name,
      runtimeProduct: runtimeProduct || null,
      runtimeVersion: runtimeVersion || null,
      version,
    });
  });
}

function isIcuDescriptor(row) {
  return row.groupId === "dev.oliphaunt.runtime" && row.artifactId === "oliphaunt-icu";
}

function hasDescriptor(row) {
  return row.artifact.endsWith(".java") || isIcuDescriptor(row);
}

export function renderMavenArtifactPom(row) {
  const licenses = row.licenses.map((license) => `    <license>
      <name>${xml(license.name)}</name>
      <url>${xml(license.url)}</url>
      <distribution>${xml(license.distribution)}</distribution>
    </license>`).join("\n");
  const runtimeProperties = row.runtimeProduct === null ? "" : `
    <oliphaunt.runtime.product>${xml(row.runtimeProduct)}</oliphaunt.runtime.product>
    <oliphaunt.runtime.version>${xml(row.runtimeVersion)}</oliphaunt.runtime.version>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd" xmlns="http://maven.apache.org/POM/4.0.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${xml(row.groupId)}</groupId>
  <artifactId>${xml(row.artifactId)}</artifactId>
  <version>${xml(row.version)}</version>
  <packaging>${hasDescriptor(row) ? "jar" : "tar.gz"}</packaging>
  <name>${xml(row.name)}</name>
  <description>${xml(row.description)}</description>
  <url>https://github.com/f0rr0/oliphaunt</url>
  <inceptionYear>2026</inceptionYear>
  <licenses>
${licenses}
  </licenses>
  <developers>
    <developer>
      <id>f0rr0</id>
      <name>Oliphaunt Maintainers</name>
      <url>https://github.com/f0rr0</url>
    </developer>
  </developers>
  <scm>
    <connection>scm:git:https://github.com/f0rr0/oliphaunt.git</connection>
    <developerConnection>scm:git:ssh://git@github.com:f0rr0/oliphaunt.git</developerConnection>
    <url>https://github.com/f0rr0/oliphaunt</url>
  </scm>
${hasDescriptor(row) ? `  <dependencies>
    <dependency>
      <groupId>dev.oliphaunt</groupId>
      <artifactId>oliphaunt-android</artifactId>
      <version>${xml(currentProductVersionSync("oliphaunt-kotlin", TOOL))}</version>
      <type>aar</type>
      <scope>compile</scope>
    </dependency>
  </dependencies>
` : ""}  <properties>${runtimeProperties}
    <oliphaunt.license.spdx>${xml(row.licenseSpdx)}</oliphaunt.license.spdx>
  </properties>
</project>
`;
}

function exactFiles(directory, expected, label) {
  const actual = readdirSync(directory, { withFileTypes: true });
  if (actual.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw error(`${label} must contain only regular files`);
  }
  const names = actual.map((entry) => entry.name).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(names) !== JSON.stringify(wanted)) {
    throw error(`${label} file closure differs: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(names)}`);
  }
  return names;
}

async function writeCompanionJar(stageRoot, row, classifier, descriptorSource) {
  const coordinate = `${row.groupId}:${row.artifactId}:${row.version}`;
  const root = path.join(stageRoot, `${classifier}-stage`);
  mkdirSync(path.join(root, "META-INF"), { recursive: true });
  stageReleaseNotices(path.join(root, "META-INF"), { profile: "source-sdk" });
  writeFileSync(path.join(root, "META-INF/MANIFEST.MF"), MANIFEST, { mode: 0o644 });
  if (classifier === "sources" && descriptorSource !== undefined) {
    copyFileSync(descriptorSource, path.join(root, path.basename(descriptorSource)));
  } else if (classifier === "sources") {
    writeFileSync(
      path.join(root, "README.md"),
      `# ${coordinate}\n\nThis binary carrier has no source API. See https://github.com/f0rr0/oliphaunt.\n`,
      { mode: 0o644 },
    );
  } else {
    writeFileSync(
      path.join(root, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>${xml(coordinate)}</title><p>${descriptorSource === undefined ? "This binary carrier has no Java API." : "Versioned resource descriptor. See the sources archive."}</p>\n`,
      { mode: 0o644 },
    );
  }
  return createDeterministicZip(root);
}

let descriptorSdkJar;
function localDescriptorSdkJar() {
  if (descriptorSdkJar !== undefined) return descriptorSdkJar;
  const buildRoot = path.join(ROOT, "target/release/maven-descriptor-sdk");
  const result = spawnSync("./gradlew", [":oliphaunt:jvmJar", "--configuration-cache"], {
    cwd: path.join(ROOT, "src/sdks/kotlin"),
    env: { ...process.env, OLIPHAUNT_GRADLE_BUILD_ROOT: buildRoot },
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw error(`building descriptor SDK types failed: ${result.error ?? result.stderr ?? result.stdout}`);
  const directory = path.join(buildRoot, "oliphaunt/libs");
  const jars = readdirSync(directory).filter(name => /^oliphaunt-jvm-[0-9].*\.jar$/u.test(name) && !/-sources|-javadoc/u.test(name));
  if (jars.length !== 1) throw error("descriptor SDK build must produce exactly one JVM jar");
  descriptorSdkJar = path.join(directory, jars[0]);
  return descriptorSdkJar;
}

async function writeDescriptorJar(root, source, sdkJar) {
  const classes = path.join(root, "classes");
  mkdirSync(classes, { recursive: true });
  const result = spawnSync("javac", ["--release", "17", "-proc:none", "-classpath", sdkJar, "-d", classes, source], {
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw error(`compiling ${source} failed: ${result.error ?? result.stderr}`);
  stageReleaseNotices(path.join(classes, "META-INF"), { profile: "source-sdk" });
  writeFileSync(path.join(classes, "META-INF/MANIFEST.MF"), MANIFEST);
  return createDeterministicZip(classes);
}

/** Stage unsigned Maven files. Descriptor jars compile against the local SDK;
 * binary-only carriers need no Gradle or Java invocation. */
export async function stageMavenArtifactManifest(manifest, outputRoot, { sdkJar } = {}) {
  const rows = parseMavenArtifactManifest(path.resolve(manifest));
  const destination = path.resolve(outputRoot);
  const stage = createSiblingStage(destination, "maven-artifacts");
  try {
    const staged = [];
    for (const row of rows) {
      const directory = path.join(stage, ...row.groupId.split("."), row.artifactId, row.version);
      const prefix = `${row.artifactId}-${row.version}`;
      mkdirSync(directory, { recursive: true });
      const descriptor = hasDescriptor(row);
      const primary = path.join(directory, `${prefix}.${descriptor ? "jar" : "tar.gz"}`);
      const pom = path.join(directory, `${prefix}.pom`);
      const sources = path.join(directory, `${prefix}-sources.jar`);
      const javadoc = path.join(directory, `${prefix}-javadoc.jar`);
      const companionRoot = path.join(stage, ".companion-stage", row.artifactId, row.version);
      mkdirSync(companionRoot, { recursive: true });
      let descriptorSource;
      const extraFiles = [];
      if (descriptor) {
        descriptorSource = row.artifact;
        if (isIcuDescriptor(row)) {
          descriptorSource = path.join(companionRoot, "ICU.java");
          writeFileSync(descriptorSource, `package dev.oliphaunt.icu;
/** Optional ICU data supplied by this package. */
public final class ICU {
    private ICU() {}
    public static final dev.oliphaunt.IcuData data = new dev.oliphaunt.IcuData(${JSON.stringify(row.version)});
}
`);
          const payloadName = `${prefix}.tar.gz`;
          copyFileSync(row.artifact, path.join(directory, payloadName));
          chmodSync(path.join(directory, payloadName), 0o644);
          extraFiles.push(payloadName);
        }
        writeFileSync(primary, await writeDescriptorJar(companionRoot, descriptorSource, sdkJar ?? localDescriptorSdkJar()));
      } else {
        copyFileSync(row.artifact, primary);
      }
      chmodSync(primary, 0o644);
      writeFileSync(pom, renderMavenArtifactPom(row), { mode: 0o644 });
      writeFileSync(sources, await writeCompanionJar(companionRoot, row, "sources", descriptorSource), { mode: 0o644 });
      writeFileSync(javadoc, await writeCompanionJar(companionRoot, row, "javadoc", descriptorSource), { mode: 0o644 });
      rmSync(companionRoot, { recursive: true, force: true });
      const files = exactFiles(directory, [
        ...extraFiles,
        path.basename(javadoc),
        path.basename(pom),
        path.basename(sources),
        path.basename(primary),
      ], `${row.groupId}:${row.artifactId}:${row.version}`);
      const publication = validateMavenCentralPublication({
        context: `${row.groupId}:${row.artifactId}:${row.version}`,
        files: files.map((name) => ({ name, size: statSync(path.join(directory, name)).size })),
        pomText: readFileSync(pom, "utf8"),
      });
      staged.push(Object.freeze({
        ...publication,
        directory: path.join(destination, ...row.groupId.split("."), row.artifactId, row.version),
        files: Object.freeze(files),
      }));
    }
    rmSync(path.join(stage, ".companion-stage"), { recursive: true, force: true });
    promoteDirectory(stage, destination);
    return Object.freeze(staged);
  } catch (cause) {
    if (existsSync(stage)) removeTemporaryPath(stage);
    throw cause;
  }
}

function parseArgs(argv) {
  let manifest = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      manifest = argv[++index] ?? null;
    } else if (arg === "--output") {
      output = argv[++index] ?? null;
    } else {
      throw error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (manifest === null || output === null) {
    throw error("usage: maven-artifact-staging.mjs --manifest FILE --output DIRECTORY");
  }
  return { manifest, output };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    const staged = await stageMavenArtifactManifest(args.manifest, args.output);
    console.log(`Staged and validated ${staged.length} local Maven Central carrier(s) under ${relative(args.output)}.`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
