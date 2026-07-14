import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  findSdkRuntimePayloadViolation,
  validateSwiftSourceFixtureEntries,
} from "./check-staged-artifacts.mjs";

const REPOSITORY_ROOT = path.join(
  import.meta.dir,
  "../../src/sdks/swift/Tests/Fixtures/swiftpm-extension-resources",
);
const ARCHIVE_ROOT = "package/Tests/Fixtures/swiftpm-extension-resources";

function fixtureFiles(root = REPOSITORY_ROOT) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (statSync(file).isDirectory()) {
        visit(file);
      } else if (statSync(file).isFile()) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files;
}

function repositoryFixtureEntries() {
  return new Map(fixtureFiles().map((file) => {
    const relative = path.relative(REPOSITORY_ROOT, file).split(path.sep).join("/");
    const bytes = readFileSync(file);
    return [
      `${ARCHIVE_ROOT}/${relative}`,
      { isFile: true, data: () => bytes },
    ];
  }));
}

test("permits only an exact byte-for-byte Swift extension-resource fixture mirror", () => {
  const entries = repositoryFixtureEntries();
  const allowed = validateSwiftSourceFixtureEntries("Oliphaunt-source.zip", entries);

  assert.deepEqual([...allowed].sort(), [...entries.keys()].sort());
  assert.equal(
    findSdkRuntimePayloadViolation("oliphaunt-swift", [...entries.keys()], allowed),
    null,
  );
});

test("rejects missing and extra Swift extension-resource fixture files", () => {
  const missing = repositoryFixtureEntries();
  missing.delete(missing.keys().next().value);
  assert.throws(
    () => validateSwiftSourceFixtureEntries("missing.zip", missing),
    /file set must exactly match.*missing=\["/u,
  );

  const extra = repositoryFixtureEntries();
  extra.set(`${ARCHIVE_ROOT}/unexpected/extra.control`, {
    isFile: true,
    data: () => Buffer.from("unexpected\n"),
  });
  assert.throws(
    () => validateSwiftSourceFixtureEntries("extra.zip", extra),
    /file set must exactly match.*extra=\["/u,
  );
});

test("rejects tampered Swift extension-resource fixture bytes", () => {
  const entries = repositoryFixtureEntries();
  const [name, entry] = entries.entries().next().value;
  entries.set(name, {
    ...entry,
    data: () => Buffer.concat([Buffer.from(entry.data()), Buffer.from("tampered")]),
  });

  assert.throws(
    () => validateSwiftSourceFixtureEntries("tampered.zip", entries),
    /must byte-for-byte match/u,
  );
});

test("continues to reject runtime payloads outside the exact fixture subtree", () => {
  const entries = repositoryFixtureEntries();
  const allowed = validateSwiftSourceFixtureEntries("Oliphaunt-source.zip", entries);
  const outsideFixture =
    "package/Sources/Oliphaunt/Resources/runtime/files/share/postgresql/extension/pgtap.control";

  assert.equal(
    findSdkRuntimePayloadViolation(
      "oliphaunt-swift",
      [...entries.keys(), outsideFixture],
      allowed,
    ),
    outsideFixture,
  );
});
