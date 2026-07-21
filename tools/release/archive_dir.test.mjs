#!/usr/bin/env bun

import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

function zipEntries(archive) {
  const buffer = readFileSync(archive);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (
      buffer.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length
    ) {
      eocd = offset;
      break;
    }
  }
  assert.notEqual(eocd, -1, "ZIP must have an exact end-of-central-directory record");
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const start = buffer.readUInt32LE(eocd + 16);
  assert.equal(start + size, eocd, "ZIP central directory must end at the EOCD");
  const rows = [];
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, `missing central entry ${index}`);
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const nameStart = offset + 46;
    rows.push({
      commentLength,
      date: buffer.readUInt16LE(offset + 14),
      dosDirectory: (externalAttributes & 0x10) !== 0,
      extraLength,
      host: versionMadeBy >>> 8,
      mode: externalAttributes >>> 16,
      name: buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"),
      time: buffer.readUInt16LE(offset + 12),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, eocd, "ZIP central directory must contain only declared entries");
  return rows;
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

test("writes deterministic keep-parent ZIPs with unambiguous Unix member types", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-archive-dir-zip-"));
  try {
    const source = path.join(root, "Fixture.xcframework");
    mkdirSync(path.join(source, "ios-arm64"), { recursive: true });
    writeFileSync(path.join(source, "Info.plist"), "<plist/>\n");
    const library = path.join(source, "ios-arm64", "libFixture");
    writeFileSync(library, "library\n");
    chmodSync(library, 0o755);
    const first = path.join(root, "first.zip");
    const second = path.join(root, "second.zip");
    run(process.execPath, [ARCHIVER, "--keep-parent", source, first]);
    run(process.execPath, [ARCHIVER, "--keep-parent", source, second]);

    assert.equal(digest(first), digest(second), "ZIP output must be byte-for-byte deterministic");
    assert.deepEqual(zipEntries(first), [
      {
        commentLength: 0,
        date: 33,
        dosDirectory: true,
        extraLength: 0,
        host: 3,
        mode: 0o040755,
        name: "Fixture.xcframework/",
        time: 0,
      },
      {
        commentLength: 0,
        date: 33,
        dosDirectory: true,
        extraLength: 0,
        host: 3,
        mode: 0o040755,
        name: "Fixture.xcframework/ios-arm64/",
        time: 0,
      },
      {
        commentLength: 0,
        date: 33,
        dosDirectory: false,
        extraLength: 0,
        host: 3,
        mode: 0o100644,
        name: "Fixture.xcframework/Info.plist",
        time: 0,
      },
      {
        commentLength: 0,
        date: 33,
        dosDirectory: false,
        extraLength: 0,
        host: 3,
        mode: 0o100755,
        name: "Fixture.xcframework/ios-arm64/libFixture",
        time: 0,
      },
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects symbolic links instead of silently dereferencing release inputs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-archive-dir-link-"));
  try {
    const source = path.join(root, "source");
    mkdirSync(source);
    writeFileSync(path.join(source, "payload"), "payload\n");
    symlinkSync("payload", path.join(source, "payload-link"));

    for (const output of [path.join(root, "output.tar.gz"), path.join(root, "output.zip")]) {
      assert.match(
        runFailure(process.execPath, [ARCHIVER, source, output]),
        /source tree contains a symbolic link/u,
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
