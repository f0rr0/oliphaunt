#!/usr/bin/env bun

import {
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { validateMavenCentralPublication } from "./maven-central-contract.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const TOOL = "kotlin-maven-staging.mjs";
const PRODUCT = "oliphaunt-kotlin";
const DEFAULT_STAGING_ROOT = path.join(ROOT, "target/sdk-artifacts/oliphaunt-kotlin/maven");
const VERSION_TOKEN = /^[A-Za-z0-9_.-]+$/u;

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function repositoryRelative(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith("..") ? file : relative.split(path.sep).join("/");
}

function requireDirectory(directory, label) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (cause) {
    throw error(`${label} is missing: ${cause.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw error(`${label} must be a real non-symlink directory`);
  }
}

function walkRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw error(`staged Maven repository must not contain symlink ${repositoryRelative(file)}`);
      }
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile()) {
        files.push(file);
      } else {
        throw error(`staged Maven repository must contain only regular files and directories: ${repositoryRelative(file)}`);
      }
    }
  };
  visit(root);
  return files.sort((left, right) => ordinalCompare(
    normalizedRelative(root, left),
    normalizedRelative(root, right),
  ));
}

function coordinate(groupId, artifactId, version, packaging, companions) {
  const directory = `${groupId.replaceAll(".", "/")}/${artifactId}/${version}`;
  const prefix = `${artifactId}-${version}`;
  return Object.freeze({
    artifactId,
    directory,
    files: Object.freeze(companions.map((suffix) => `${directory}/${prefix}${suffix}`)),
    groupId,
    packaging,
    version,
  });
}

export function kotlinMavenCentralCoordinates(version) {
  if (typeof version !== "string" || !VERSION_TOKEN.test(version)) {
    throw error(`Kotlin product version must be a safe Maven token, got ${JSON.stringify(version)}`);
  }
  return Object.freeze([
    coordinate("dev.oliphaunt", "oliphaunt-android", version, "aar", [
      ".aar",
      ".pom",
      ".module",
      "-sources.jar",
      "-javadoc.jar",
    ]),
    coordinate("dev.oliphaunt", "oliphaunt-android-gradle-plugin", version, "jar", [
      ".jar",
      ".pom",
      ".module",
      "-sources.jar",
      "-javadoc.jar",
    ]),
    coordinate("dev.oliphaunt.android", "dev.oliphaunt.android.gradle.plugin", version, "pom", [
      ".pom",
    ]),
  ]);
}

export function kotlinMavenCentralRelativeFiles(version) {
  return kotlinMavenCentralCoordinates(version)
    .flatMap(({ files }) => files)
    .sort();
}

function localMetadataRelativeFiles(version) {
  return kotlinMavenCentralCoordinates(version)
    .map(({ directory }) => `${path.posix.dirname(directory)}/maven-metadata-local.xml`)
    .sort();
}

export function currentKotlinProductVersion() {
  const file = path.join(ROOT, "src/sdks/kotlin/gradle.properties");
  const versions = readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.match(/^VERSION_NAME=(.+)$/u)?.[1]?.trim())
    .filter(Boolean);
  if (versions.length !== 1 || !VERSION_TOKEN.test(versions[0])) {
    throw error(`${repositoryRelative(file)} must declare exactly one safe VERSION_NAME`);
  }
  return versions[0];
}

/**
 * Validate the complete unsigned Maven Central input staged by the Kotlin SDK.
 * Gradle's three maven-metadata-local.xml files are permitted because the
 * producer uses publishToMavenLocal, but they are explicitly excluded from the
 * immutable eleven-file Central closure returned by this function.
 */
export function validateKotlinMavenStagingClosure(
  root,
  version,
  { allowLocalMetadata = true, label = repositoryRelative(root) } = {},
) {
  const stagingRoot = path.resolve(root);
  requireDirectory(stagingRoot, `${label} staged Maven repository`);

  const coordinates = kotlinMavenCentralCoordinates(version);
  const expected = new Set(kotlinMavenCentralRelativeFiles(version));
  const permittedMetadata = new Set(allowLocalMetadata ? localMetadataRelativeFiles(version) : []);
  const files = walkRegularFiles(stagingRoot);
  const actual = new Map(files.map((file) => [normalizedRelative(stagingRoot, file), file]));
  const missing = [...expected].filter((file) => !actual.has(file)).sort();
  const unexpected = [...actual.keys()]
    .filter((file) => !expected.has(file) && !permittedMetadata.has(file))
    .sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw error(
      `${label} must contain the exact ${expected.size}-file Maven Central companion closure; `
        + `missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`,
    );
  }

  for (const [relative, file] of actual) {
    if (statSync(file).size <= 0) {
      throw error(`${label} contains empty file ${relative}`);
    }
  }

  for (const expectedCoordinate of coordinates) {
    const pomRelative = expectedCoordinate.files.find((file) => file.endsWith(".pom"));
    const pom = actual.get(pomRelative);
    const publicationFiles = expectedCoordinate.files.map((relative) => {
      const file = actual.get(relative);
      return { name: path.basename(file), size: statSync(file).size };
    });
    const validated = validateMavenCentralPublication({
      context: `${label}/${pomRelative}`,
      files: publicationFiles,
      pomText: readFileSync(pom, "utf8"),
    });
    for (const field of ["artifactId", "groupId", "packaging", "version"]) {
      if (validated[field] !== expectedCoordinate[field]) {
        throw error(
          `${label}/${pomRelative} ${field} must be ${expectedCoordinate[field]}, got ${validated[field]}`,
        );
      }
    }
  }

  return Object.freeze({
    coordinates: coordinates.map(({ artifactId, groupId, packaging }) => ({ artifactId, groupId, packaging })),
    localMetadataFiles: [...actual.keys()].filter((file) => permittedMetadata.has(file)).sort(),
    publicationFiles: [...expected].sort(),
    root: stagingRoot,
    version,
  });
}

export function stagedKotlinMavenRepo({
  root = DEFAULT_STAGING_ROOT,
  version = currentKotlinProductVersion(),
} = {}) {
  const result = validateKotlinMavenStagingClosure(root, version);
  console.log(
    `validated exact ${result.publicationFiles.length}-file Kotlin Maven Central staging closure: ${repositoryRelative(result.root)}`,
  );
  return result.root;
}

if (import.meta.main) {
  if (Bun.argv.length !== 2) {
    console.error(`usage: ${TOOL}`);
    process.exit(2);
  }
  try {
    stagedKotlinMavenRepo();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
