#!/usr/bin/env bun

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const ARCHIVER = path.resolve(import.meta.dir, "archive_dir.mjs");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
}

function runFailure(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.notEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly succeeded`);
  return `${result.stderr}${result.stdout}`;
}

function tarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end >= offset && end < offset + length ? end : offset + length).toString("utf8");
}

function tarOctal(buffer, offset, length) {
  const value = tarString(buffer, offset, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function entries(archive) {
  const buffer = gunzipSync(readFileSync(archive));
  const rows = [];
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const size = tarOctal(header, 124, 12);
    rows.push({
      headerName: name,
      name: prefix ? `${prefix}/${name}` : name,
      prefix,
      type: tarString(header, 156, 1),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return rows;
}

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

test("writes deterministic canonical ustar directory markers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-archive-dir-"));
  try {
    const source = path.join(root, "source");
    mkdirSync(path.join(source, "nested", "child"), { recursive: true });
    const longParent = "parent".repeat(14);
    const longChild = "child".repeat(7);
    mkdirSync(path.join(source, longParent, longChild), { recursive: true });
    writeFileSync(path.join(source, "nested", "child", "payload.txt"), "payload\n");
    writeFileSync(path.join(source, "top.txt"), "top\n");
    const first = path.join(root, "first.tar.gz");
    const second = path.join(root, "second.tar.gz");
    run(process.execPath, [ARCHIVER, source, first]);
    run(process.execPath, [ARCHIVER, source, second]);

    assert.equal(digest(first), digest(second), "archive output must be byte-for-byte deterministic");
    assert.deepEqual(entries(first), [
      { headerName: ".", name: ".", prefix: "", type: "5" },
      { headerName: "nested/", name: "nested/", prefix: "", type: "5" },
      { headerName: `${longParent}/`, name: `${longParent}/`, prefix: "", type: "5" },
      { headerName: "top.txt", name: "top.txt", prefix: "", type: "0" },
      { headerName: "nested/child/", name: "nested/child/", prefix: "", type: "5" },
      { headerName: "nested/child/payload.txt", name: "nested/child/payload.txt", prefix: "", type: "0" },
      { headerName: `${longChild}/`, name: `${longParent}/${longChild}/`, prefix: longParent, type: "5" },
    ]);

    const extracted = path.join(root, "extracted");
    mkdirSync(extracted);
    run("tar", ["-xzf", first, "-C", extracted]);
    assert.equal(readFileSync(path.join(extracted, "nested", "child", "payload.txt"), "utf8"), "payload\n");

    const unsplittable = path.join(root, "unsplittable");
    mkdirSync(path.join(unsplittable, "x".repeat(100)), { recursive: true });
    assert.match(
      runFailure(process.execPath, [ARCHIVER, unsplittable, path.join(root, "unsplittable.tar.gz")]),
      /archive path is too long for ustar/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
