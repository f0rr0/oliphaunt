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
  run,
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

export function stageArtifacts(artifactRoot, workRoot) {
  const mavenRepo = path.join(workRoot, "maven-local");
  const buildRoot = path.join(workRoot, "gradle-build");
  const cxxRoot = path.join(workRoot, "cxx-build");
  const cacheRoot = path.join(workRoot, "gradle-cache");
  const version = kotlinVersion();
  run(path.join(ROOT, "src/sdks/kotlin/gradlew"), [
    "-p",
    path.join(ROOT, "src/sdks/kotlin"),
    ":oliphaunt:publishAndroidReleasePublicationToMavenLocal",
    ":oliphaunt-android-gradle-plugin:publishToMavenLocal",
    `-Dmaven.repo.local=${mavenRepo}`,
    "-PoliphauntAndroidAbiFilters=arm64-v8a,x86_64",
    `-PoliphauntBuildRoot=${buildRoot}`,
    `-PoliphauntCxxBuildRoot=${cxxRoot}`,
    "--project-cache-dir",
    cacheRoot,
    "--no-configuration-cache",
  ], { label: "Kotlin SDK Gradle package artifacts" });
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
