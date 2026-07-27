import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  releaseNoticeRows,
  releaseProfilePackageLicense,
} from "./release-notices.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

const CORE_TEMPLATES = [
  ["src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml", "wasix-runtime"],
  ["src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml", "wasix-tools"],
  ["src/runtimes/liboliphaunt/icu/Cargo.toml", "wasix-icu-data"],
  ...[
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
  ].flatMap((target) => [
    [`src/runtimes/liboliphaunt/wasix/crates/aot/${target}/Cargo.toml`, "wasix-aot"],
    [`src/runtimes/liboliphaunt/wasix/crates/tools-aot/${target}/Cargo.toml`, "wasix-aot"],
  ]),
];

const ALL_NOTICE_MEMBERS = new Set(
  releaseNoticeRows({
    products: ["native", "wasix"],
    components: ["postgresql", "icu", "openssl"],
  }).map((row) => row.member),
);

function manifest(relative) {
  return Bun.TOML.parse(readFileSync(path.join(ROOT, relative), "utf8"));
}

test("oliphaunt-wasix source SDK remains an MIT-only facade", () => {
  assert.equal(manifest("Cargo.toml").workspace.package.license, "MIT");
  const source = manifest("src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml");
  assert.equal(source.package.license, "MIT");
});

test("every WASIX payload Cargo template includes its exact legal profile", () => {
  for (const [relative, profile] of CORE_TEMPLATES) {
    const cargo = manifest(relative);
    assert.equal(
      cargo.package.license,
      releaseProfilePackageLicense(profile).spdx,
      `${relative} license`,
    );
    assert.ok(Array.isArray(cargo.package.include), `${relative} must declare package.include`);
    const includedNotices = cargo.package.include.filter((member) => ALL_NOTICE_MEMBERS.has(member));
    assert.deepEqual(
      includedNotices.sort(),
      releaseNoticeRows({ profile }).map((row) => row.member).sort(),
      `${relative} notice include closure`,
    );
  }
});
