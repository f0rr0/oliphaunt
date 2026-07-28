import { describe, expect, test } from "bun:test";

import { validateMavenCentralPublication } from "./maven-central-contract.mjs";

function pom({ packaging = "tar.gz", metadata = true } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>dev.oliphaunt.extensions</groupId>
  <artifactId>vector-android-arm64</artifactId>
  <version>1.2.3</version>
  <packaging>${packaging}</packaging>
  ${metadata ? `<name>Oliphaunt vector Android arm64</name>
  <description>Exact native extension carrier.</description>
  <url>https://github.com/f0rr0/oliphaunt</url>
  <licenses><license><name>PostgreSQL</name><url>https://opensource.org/license/postgresql</url></license></licenses>
  <developers><developer><name>Oliphaunt Maintainers</name><url>https://github.com/f0rr0</url></developer></developers>
  <scm><connection>scm:git:https://github.com/f0rr0/oliphaunt.git</connection><developerConnection>scm:git:ssh://git@github.com/f0rr0/oliphaunt.git</developerConnection><url>https://github.com/f0rr0/oliphaunt</url></scm>` : ""}
</project>`;
}

const complete = [
  { name: "vector-android-arm64-1.2.3.pom", size: 10 },
  { name: "vector-android-arm64-1.2.3.tar.gz", size: 20 },
  { name: "vector-android-arm64-1.2.3-sources.jar", size: 30 },
  { name: "vector-android-arm64-1.2.3-javadoc.jar", size: 40 },
];

describe("Maven Central immutable publication contract", () => {
  test("accepts complete non-jar coordinates with Central metadata and placeholders", () => {
    expect(validateMavenCentralPublication({ pomText: pom(), files: complete })).toEqual({
      artifactId: "vector-android-arm64",
      groupId: "dev.oliphaunt.extensions",
      packaging: "tar.gz",
      version: "1.2.3",
    });
  });

  test("permits a metadata-complete POM-only Gradle marker", () => {
    expect(validateMavenCentralPublication({
      pomText: pom({ packaging: "pom" }),
      files: [{ name: "vector-android-arm64-1.2.3.pom", size: 10 }],
    }).packaging).toBe("pom");
  });

  for (const missing of ["vector-android-arm64-1.2.3.tar.gz", "vector-android-arm64-1.2.3-sources.jar", "vector-android-arm64-1.2.3-javadoc.jar"]) {
    test(`rejects a non-POM coordinate missing ${missing}`, () => {
      expect(() => validateMavenCentralPublication({
        pomText: pom(),
        files: complete.filter(({ name }) => name !== missing),
      })).toThrow(`missing required file ${missing}`);
    });
  }

  test("rejects incomplete required Central POM metadata", () => {
    expect(() => validateMavenCentralPublication({ pomText: pom({ metadata: false }), files: complete })).toThrow("exactly one <name>, found 0");
  });

  test("rejects duplicate root packaging emitted by an unsafe Gradle XML append", () => {
    const duplicate = pom().replace("<packaging>tar.gz</packaging>", "<packaging>tar.gz</packaging><packaging>tar.gz</packaging>");
    expect(() => validateMavenCentralPublication({ pomText: duplicate, files: complete })).toThrow(
      "exactly one <packaging>, found 2",
    );
  });

  test("rejects empty publication files", () => {
    expect(() => validateMavenCentralPublication({
      pomText: pom(),
      files: complete.map((entry) => entry.name.endsWith("-sources.jar") ? { ...entry, size: 0 } : entry),
    })).toThrow("must be nonempty");
  });
});
