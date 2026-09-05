import path from "node:path";
import { readFileSync } from "node:fs";

import { assertReleaseNoticesInArchive } from "../release-notices.mjs";
import {
  ROOT,
  copyDirContents,
  fail,
  filesUnder,
  rel,
  requireFile,
} from "./shared.mjs";

function kotlinVersion() {
  const gradleProperties = readFileSync(path.join(ROOT, "src/sdks/kotlin/gradle.properties"), "utf8");
  const versions = gradleProperties
    .split(/\r?\n/u)
    .map((line) => line.match(/^VERSION_NAME=(.+)$/u)?.[1]?.trim())
    .filter(Boolean);
  const version = versions.at(-1);
  if (!version) {
    fail("missing VERSION_NAME in src/sdks/kotlin/gradle.properties");
  }
  return version;
}

export function stageArtifacts(artifactRoot) {
  const mavenRepo = path.join(ROOT, "target/moon/oliphaunt-kotlin/package/maven");
  const version = kotlinVersion();
  requireFile(path.join(mavenRepo, `dev/oliphaunt/oliphaunt-android/${version}/oliphaunt-android-${version}.aar`));
  requireFile(path.join(mavenRepo, `dev/oliphaunt/oliphaunt-android-gradle-plugin/${version}/oliphaunt-android-gradle-plugin-${version}.jar`));
  const publishedArchives = filesUnder(mavenRepo)
    .filter((file) => file.endsWith(".aar") || file.endsWith(".jar"));
  if (publishedArchives.length === 0) {
    fail(`Kotlin SDK Maven repository contains no AAR or JAR artifacts: ${rel(mavenRepo)}`);
  }
  for (const archive of publishedArchives) {
    assertReleaseNoticesInArchive(archive, { prefix: "META-INF" });
  }
  const destination = path.join(artifactRoot, "maven");
  copyDirContents(mavenRepo, destination);
}
