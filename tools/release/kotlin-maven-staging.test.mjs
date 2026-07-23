import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  kotlinMavenCentralCoordinates,
  kotlinMavenCentralRelativeFiles,
  validateKotlinMavenStagingClosure,
} from "./kotlin-maven-staging.mjs";

const VERSION = "1.2.3";
const temporaryDirectories = [];

function pom({ artifactId, groupId, packaging, version = VERSION }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${groupId}</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>${version}</version>
  <packaging>${packaging}</packaging>
  <name>Oliphaunt ${artifactId}</name>
  <description>Exact Kotlin Maven staging fixture.</description>
  <url>https://github.com/f0rr0/oliphaunt</url>
  <licenses><license><name>MIT</name><url>https://opensource.org/license/mit</url></license></licenses>
  <developers><developer><name>Oliphaunt Maintainers</name><url>https://github.com/f0rr0</url></developer></developers>
  <scm>
    <connection>scm:git:https://github.com/f0rr0/oliphaunt.git</connection>
    <developerConnection>scm:git:ssh://git@github.com/f0rr0/oliphaunt.git</developerConnection>
    <url>https://github.com/f0rr0/oliphaunt</url>
  </scm>
</project>
`;
}

function write(relative, bytes, root) {
  const file = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

function fixture({ localMetadata = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-kotlin-maven-staging-"));
  temporaryDirectories.push(root);
  for (const coordinate of kotlinMavenCentralCoordinates(VERSION)) {
    for (const relative of coordinate.files) {
      write(
        relative,
        relative.endsWith(".pom") ? pom(coordinate) : `fixture ${path.basename(relative)}\n`,
        root,
      );
    }
    if (localMetadata) {
      write(`${path.posix.dirname(coordinate.directory)}/maven-metadata-local.xml`, "<metadata/>\n", root);
    }
  }
  return root;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

test("validates the exact eleven-file Kotlin Maven Central companion closure", () => {
  const result = validateKotlinMavenStagingClosure(fixture(), VERSION);
  expect(result.publicationFiles).toEqual(kotlinMavenCentralRelativeFiles(VERSION));
  expect(result.publicationFiles).toHaveLength(11);
  expect(result.coordinates).toEqual([
    { artifactId: "oliphaunt-android", groupId: "dev.oliphaunt", packaging: "aar" },
    { artifactId: "oliphaunt-android-gradle-plugin", groupId: "dev.oliphaunt", packaging: "jar" },
    { artifactId: "dev.oliphaunt.android.gradle.plugin", groupId: "dev.oliphaunt.android", packaging: "pom" },
  ]);
  expect(result.localMetadataFiles).toHaveLength(3);
});

test("rejects missing companions and undeclared staging files", () => {
  const missing = fixture();
  unlinkSync(path.join(missing, kotlinMavenCentralRelativeFiles(VERSION)[0]));
  expect(() => validateKotlinMavenStagingClosure(missing, VERSION)).toThrow(/exact 11-file.*missing=/u);

  const unexpected = fixture();
  write("dev/oliphaunt/oliphaunt-android/1.2.3/resolver.lock", "forbidden\n", unexpected);
  expect(() => validateKotlinMavenStagingClosure(unexpected, VERSION)).toThrow(/unexpected=.*resolver[.]lock/u);
});

test("permits only the known local metadata outside the Central closure", () => {
  const root = fixture();
  expect(() => validateKotlinMavenStagingClosure(root, VERSION, { allowLocalMetadata: false })).toThrow(
    /unexpected=.*maven-metadata-local[.]xml/u,
  );

  const withoutMetadata = fixture({ localMetadata: false });
  expect(validateKotlinMavenStagingClosure(withoutMetadata, VERSION).localMetadataFiles).toEqual([]);
});

test("validates each staged POM against the canonical Maven Central contract", () => {
  const root = fixture();
  const coordinate = kotlinMavenCentralCoordinates(VERSION)[0];
  const pomFile = path.join(root, coordinate.files.find((file) => file.endsWith(".pom")));
  writeFileSync(pomFile, pom(coordinate).replace(/\s*<developers>[\s\S]*?<\/developers>/u, ""));
  expect(() => validateKotlinMavenStagingClosure(root, VERSION)).toThrow(
    /maven-central-contract:.*must define <developers>/u,
  );
});
