import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSafeExampleScratchDestination,
  copyExampleCrateToScratch,
} from "./prepare-example-cargo-candidate.mjs";
import { ROOT } from "./release-cli-utils.mjs";

function write(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

test("scratch preparation injects exact patches without mutating source or copying generated state", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-prepare-example-"));
  try {
    const source = path.join(root, "source");
    const destination = path.join(root, "scratch");
    const manifest = '[package]\nname = "fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\ncarrier = "=1.2.3"\n';
    write(path.join(source, "Cargo.toml"), manifest);
    write(path.join(source, "Cargo.lock"), "source lock must remain\n");
    write(path.join(source, "target/sentinel"), "generated\n");
    write(path.join(source, "src/lib.rs"), "pub fn fixture() {}\n");

    const result = copyExampleCrateToScratch({
      sourceDirectory: source,
      destination,
      candidatePackages: [
        { name: "z-carrier", vers: "2.0.0" },
        { name: "carrier", vers: "1.2.3" },
      ],
    });

    assert.equal(readFileSync(path.join(source, "Cargo.toml"), "utf8"), manifest);
    assert.equal(readFileSync(path.join(source, "Cargo.lock"), "utf8"), "source lock must remain\n");
    assert.equal(existsSync(path.join(destination, "Cargo.lock")), false);
    assert.equal(existsSync(path.join(destination, "target")), false);
    assert.match(readFileSync(result.manifest, "utf8"), /\[patch[.]crates-io\]/u);
    assert.match(readFileSync(result.manifest, "utf8"), /"carrier" = \{ version = "=1[.]2[.]3", registry = "oliphaunt-local" \}/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scratch preparation rejects a source manifest already bound to the candidate registry", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-nonneutral-example-"));
  try {
    const source = path.join(root, "source");
    write(
      path.join(source, "Cargo.toml"),
      '[package]\nname = "fixture"\nversion = "0.0.0"\n\n[dependencies]\ncarrier = { version = "=1.2.3", registry = "oliphaunt-local" }\n',
    );
    assert.throws(
      () => copyExampleCrateToScratch({
        sourceDirectory: source,
        destination: path.join(root, "scratch"),
        candidatePackages: [{ name: "carrier", vers: "1.2.3" }],
      }),
      /must use normal crates[.]io dependencies/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scratch preparation refuses to write into repository source directories", () => {
  assert.throws(
    () => assertSafeExampleScratchDestination(path.join(ROOT, "examples/unsafe-scratch")),
    /must be below .*target/u,
  );
});
