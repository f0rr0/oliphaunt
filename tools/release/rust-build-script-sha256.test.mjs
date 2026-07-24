#!/usr/bin/env bun
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";

import { RUST_BUILD_SCRIPT_SHA256 } from "./rust-build-script-sha256.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");

test("generated dependency-free Rust SHA-256 matches canonical known and boundary vectors", () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target/rust-build-script-sha256-"));
  try {
    const source = path.join(root, "main.rs");
    const executable = path.join(root, process.platform === "win32" ? "sha256-fixture.exe" : "sha256-fixture");
    writeFileSync(source, `use std::fs;
use std::io::{self, Read};
use std::path::Path;

${RUST_BUILD_SCRIPT_SHA256}

fn main() {
    let input = std::env::args_os().nth(1).expect("input path");
    println!("{}", sha256_file(Path::new(&input)).expect("hash fixture"));
}
`);
    const compiled = spawnSync("rustc", ["--edition", "2024", "-o", executable, source], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(compiled.status, compiled.stderr).toBe(0);

    const fixtures = [
      Buffer.alloc(0),
      Buffer.from("abc"),
      Buffer.alloc(55, 0x55),
      Buffer.alloc(56, 0x56),
      Buffer.alloc(63, 0x63),
      Buffer.alloc(64, 0x64),
      Buffer.alloc(65, 0x65),
      Buffer.alloc(65_535, 0xa5),
      Buffer.alloc(65_536, 0x5a),
      Buffer.alloc(65_537, 0xc3),
    ];
    for (const [index, bytes] of fixtures.entries()) {
      const fixture = path.join(root, `fixture-${index}.bin`);
      writeFileSync(fixture, bytes);
      const result = spawnSync(executable, [fixture], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
