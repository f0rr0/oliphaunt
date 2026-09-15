#!/usr/bin/env bun
import { parseMavenArtifactManifest } from './maven-artifact-manifest.mts';

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
} from 'node:fs';
import path from 'node:path';

import { createDeterministicZip } from './archive-directory.mts';
import { createSiblingStage, promoteDirectory, removeTemporaryPath } from './atomic-directory.mts';
import { validateMavenCentralPublication } from './maven-central-contract.mts';
import { stageReleaseNotices } from './release-notices.mts';

const ROOT = path.resolve(import.meta.dir, '../..');
const TOOL = 'maven-artifact-staging.mts';
const MANIFEST = 'Manifest-Version: 1.0\r\n\r\n';

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function relative(file) {
  const value = path.relative(ROOT, file);
  return value.startsWith('..') || path.isAbsolute(value)
    ? file.split(path.sep).join('/')
    : value.split(path.sep).join('/');
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderMavenArtifactPom(row) {
  const licenses = row.licenses
    .map(
      (license) => `    <license>
      <name>${xml(license.name)}</name>
      <url>${xml(license.url)}</url>
      <distribution>${xml(license.distribution)}</distribution>
    </license>`,
    )
    .join('\n');
  const runtimeProperties =
    row.runtimeProduct === null
      ? ''
      : `
    <oliphaunt.runtime.product>${xml(row.runtimeProduct)}</oliphaunt.runtime.product>
    <oliphaunt.runtime.version>${xml(row.runtimeVersion)}</oliphaunt.runtime.version>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd" xmlns="http://maven.apache.org/POM/4.0.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${xml(row.groupId)}</groupId>
  <artifactId>${xml(row.artifactId)}</artifactId>
  <version>${xml(row.version)}</version>
  <packaging>tar.gz</packaging>
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
  <properties>${runtimeProperties}
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
    throw error(
      `${label} file closure differs: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(names)}`,
    );
  }
  return names;
}

async function writeCompanionJar(stageRoot, row, classifier) {
  const coordinate = `${row.groupId}:${row.artifactId}:${row.version}`;
  const root = path.join(stageRoot, `${classifier}-stage`);
  mkdirSync(path.join(root, 'META-INF'), { recursive: true });
  stageReleaseNotices(path.join(root, 'META-INF'), { profile: 'source-sdk' });
  writeFileSync(path.join(root, 'META-INF/MANIFEST.MF'), MANIFEST, { mode: 0o644 });
  if (classifier === 'sources') {
    writeFileSync(
      path.join(root, 'README.md'),
      `# ${coordinate}\n\nThis binary carrier has no source API. See https://github.com/f0rr0/oliphaunt.\n`,
      { mode: 0o644 },
    );
  } else {
    writeFileSync(
      path.join(root, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>${xml(coordinate)}</title><p>This binary carrier has no Java API.</p>\n`,
      { mode: 0o644 },
    );
  }
  return createDeterministicZip(root);
}

/**
 * Materialize the immutable, unsigned Maven Central input closure without
 * Gradle, Java, registry access, credentials, or dependency resolution.
 */
export async function stageMavenArtifactManifest(manifest, outputRoot) {
  const rows = parseMavenArtifactManifest(path.resolve(manifest));
  const destination = path.resolve(outputRoot);
  const stage = createSiblingStage(destination, 'maven-artifacts');
  try {
    const staged = [];
    for (const row of rows) {
      const directory = path.join(stage, ...row.groupId.split('.'), row.artifactId, row.version);
      const prefix = `${row.artifactId}-${row.version}`;
      mkdirSync(directory, { recursive: true });
      const primary = path.join(directory, `${prefix}.tar.gz`);
      const pom = path.join(directory, `${prefix}.pom`);
      const sources = path.join(directory, `${prefix}-sources.jar`);
      const javadoc = path.join(directory, `${prefix}-javadoc.jar`);
      copyFileSync(row.artifact, primary);
      chmodSync(primary, 0o644);
      writeFileSync(pom, renderMavenArtifactPom(row), { mode: 0o644 });
      const companionRoot = path.join(stage, '.companion-stage', row.artifactId, row.version);
      writeFileSync(sources, await writeCompanionJar(companionRoot, row, 'sources'), {
        mode: 0o644,
      });
      writeFileSync(javadoc, await writeCompanionJar(companionRoot, row, 'javadoc'), {
        mode: 0o644,
      });
      rmSync(companionRoot, { recursive: true, force: true });
      const files = exactFiles(
        directory,
        [
          path.basename(javadoc),
          path.basename(pom),
          path.basename(sources),
          path.basename(primary),
        ],
        `${row.groupId}:${row.artifactId}:${row.version}`,
      );
      const publication = validateMavenCentralPublication({
        context: `${row.groupId}:${row.artifactId}:${row.version}`,
        files: files.map((name) => ({ name, size: statSync(path.join(directory, name)).size })),
        pomText: readFileSync(pom, 'utf8'),
      });
      staged.push(
        Object.freeze({
          ...publication,
          directory: path.join(destination, ...row.groupId.split('.'), row.artifactId, row.version),
          files: Object.freeze(files),
        }),
      );
    }
    rmSync(path.join(stage, '.companion-stage'), { recursive: true, force: true });
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
    if (arg === '--manifest') {
      manifest = argv[++index] ?? null;
    } else if (arg === '--output') {
      output = argv[++index] ?? null;
    } else {
      throw error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (manifest === null || output === null) {
    throw error('usage: maven-artifact-staging.mts --manifest FILE --output DIRECTORY');
  }
  return { manifest, output };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    const staged = await stageMavenArtifactManifest(args.manifest, args.output);
    console.log(
      `Staged and validated ${staged.length} local Maven Central carrier(s) under ${relative(args.output)}.`,
    );
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
