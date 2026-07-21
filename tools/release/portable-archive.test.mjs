import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import test from "node:test";
import { deflateRawSync, gunzipSync, gzipSync } from "node:zlib";

import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  readPortableArchiveEntries,
} from "./portable-archive.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

let crcTable;
function crc32(buffer) {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      crcTable[value] = crc >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(rows) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const row of rows) {
    const name = Buffer.from(row.localName ?? row.name, "utf8");
    const centralName = Buffer.from(row.name, "utf8");
    const data = Buffer.from(row.data ?? "payload");
    const method = row.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const flags = row.flags ?? 0;
    const actualCrc = crc32(data);
    const storedCrc = row.crc ?? actualCrc;
    const localExtra = row.localExtra ?? Buffer.alloc(0);
    const centralExtra = row.centralExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(storedCrc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const localRecord = Buffer.concat([local, name, localExtra, compressed]);
    locals.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(row.versionMadeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(storedCrc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(row.declaredSize ?? data.length, 24);
    central.writeUInt16LE(centralName.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE((row.externalAttributes ?? (0o100644 << 16)) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(Buffer.concat([central, centralName, centralExtra]));
    localOffset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(rows.length, 8);
  eocd.writeUInt16LE(rows.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function tarOctal(value, length) {
  return Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "ascii");
}

function tarArchive(rows) {
  const records = [];
  for (const row of rows) {
    const header = Buffer.alloc(512);
    Buffer.from(row.name).copy(header, 0);
    tarOctal(row.mode ?? 0o644, 8).copy(header, 100);
    tarOctal(0, 8).copy(header, 108);
    tarOctal(0, 8).copy(header, 116);
    const data = Buffer.from(row.data ?? "");
    tarOctal(data.length, 12).copy(header, 124);
    tarOctal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = (row.type ?? "0").charCodeAt(0);
    Buffer.from("ustar\0", "binary").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
    records.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]), { mtime: 0 });
}

function refreshFirstTarChecksum(tar) {
  tar.fill(0x20, 148, 156);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(tar, 148);
}

function fixtureFile(t, name, bytes) {
  const root = mkdtempSync(path.join(tmpdir(), "portable-archive-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const file = path.join(root, name);
  writeFileSync(file, bytes);
  return { file, root };
}

test("uses a runner-safe default archive memory envelope", () => {
  assert.deepEqual(DEFAULT_PORTABLE_ARCHIVE_LIMITS, {
    maxArchiveBytes: 512 * 1024 * 1024,
    maxEntries: 32_768,
    maxEntryBytes: 512 * 1024 * 1024,
    maxExpandedBytes: 1024 * 1024 * 1024,
  });
});

test("reads a strict ZIP and validates payload bytes", (t) => {
  const { file } = fixtureFile(t, "valid.zip", zipArchive([{ name: "root/file.txt", data: "ok" }]));
  const entries = readPortableArchiveEntries(file);
  assert.deepEqual([...entries.keys()], ["root/file.txt"]);
  assert.equal(entries.get("root/file.txt").data().toString(), "ok");
});

test("accepts an unambiguous FAT-origin ZIP member", (t) => {
  const { file } = fixtureFile(
    t,
    "fat.zip",
    zipArchive([{ name: "file.txt", versionMadeBy: 0x0014, externalAttributes: 0 }]),
  );
  assert.equal(readPortableArchiveEntries(file).get("file.txt").isFile, true);
});

test("rejects truncated ZIPs, duplicates, case collisions, and file-parent collisions", (t) => {
  const valid = zipArchive([{ name: "root/file.txt" }]);
  const truncated = fixtureFile(t, "truncated.zip", valid.subarray(0, valid.length - 1)).file;
  assert.throws(() => readPortableArchiveEntries(truncated), /well-formed ZIP end record/u);

  for (const [name, rows, pattern] of [
    ["duplicate.zip", [{ name: "same" }, { name: "same" }], /repeats archive member/u],
    ["case.zip", [{ name: "Name" }, { name: "name" }], /case\/NFC-colliding/u],
    ["parent.zip", [{ name: "parent" }, { name: "parent/child" }], /as an archive directory/u],
  ]) {
    const file = fixtureFile(t, name, zipArchive(rows)).file;
    assert.throws(() => readPortableArchiveEntries(file), pattern);
  }
});

test("rejects ZIP links, special entries, unsafe paths, and ambiguous creator types", (t) => {
  const cases = [
    ["symlink.zip", { name: "link", externalAttributes: 0o120777 << 16 }, /link or special/u],
    ["special.zip", { name: "device", externalAttributes: 0o020666 << 16 }, /link or special/u],
    ["unsafe.zip", { name: "../escape", externalAttributes: 0o100644 << 16 }, /unsafe archive member/u],
    ["ambiguous.zip", { name: "file", externalAttributes: 0 }, /ambiguous Unix creator type/u],
  ];
  for (const [name, row, pattern] of cases) {
    const file = fixtureFile(t, name, zipArchive([row])).file;
    assert.throws(() => readPortableArchiveEntries(file), pattern);
  }
});

test("rejects ZIP local-central mismatch, unsupported flags/extras, size bombs, and CRC errors", (t) => {
  const unknownExtra = Buffer.from([0xef, 0xbe, 0x00, 0x00]);
  const cases = [
    ["mismatch.zip", { name: "central", localName: "local__" }, /name disagreement/u, {}],
    ["flags.zip", { name: "file", flags: 0x2000 }, /unsupported or encrypted ZIP flags/u, {}],
    ["extra.zip", { name: "file", centralExtra: unknownExtra }, /unsupported ZIP central/u, {}],
    ["bomb.zip", { name: "file", data: "0123456789", method: 8 }, /entry-size limit/u, { maxEntryBytes: 5 }],
    ["crc.zip", { name: "file", crc: 0x12345678 }, /CRC-32 mismatch/u, {}],
    ["setid.zip", { name: "file", externalAttributes: 0o104644 << 16 }, /set-id or sticky/u, {}],
  ];
  for (const [name, row, pattern, options] of cases) {
    const file = fixtureFile(t, name, zipArchive([row])).file;
    assert.throws(() => readPortableArchiveEntries(file, options), pattern);
  }

  const overlappingBytes = zipArchive([
    { name: "first", data: "a" },
    { name: "second", data: "b" },
  ]);
  const overlapEocd = overlappingBytes.length - 22;
  const overlapCentral = overlappingBytes.readUInt32LE(overlapEocd + 16);
  overlappingBytes.writeUInt32LE(2, 18);
  overlappingBytes.writeUInt32LE(2, 22);
  overlappingBytes.writeUInt32LE(2, overlapCentral + 20);
  overlappingBytes.writeUInt32LE(2, overlapCentral + 24);
  const overlapping = fixtureFile(t, "overlap.zip", overlappingBytes).file;
  assert.throws(() => readPortableArchiveEntries(overlapping), /overlapping ZIP local records/u);

  const aggregate = fixtureFile(
    t,
    "aggregate.zip",
    zipArchive([{ name: "one", data: "1234" }, { name: "two", data: "5678" }]),
  ).file;
  assert.throws(
    () => readPortableArchiveEntries(aggregate, { maxEntryBytes: 5, maxExpandedBytes: 7 }),
    /expanded ZIP data limit/u,
  );
  assert.throws(
    () => readPortableArchiveEntries(aggregate, { maxArchiveBytes: 10 }),
    /no larger than 10 bytes/u,
  );
});

test("reads strict ustar and rejects links, bad checksums, padding, and end markers", (t) => {
  const validBytes = tarArchive([{ name: "root/file", data: "ok" }]);
  const valid = fixtureFile(t, "valid.tar.gz", validBytes).file;
  assert.equal(readPortableArchiveEntries(valid).get("root/file").data().toString(), "ok");

  const linked = fixtureFile(t, "link.tar.gz", tarArchive([{ name: "link", type: "2" }])).file;
  assert.throws(() => readPortableArchiveEntries(linked), /link or special ustar entry/u);
  const device = fixtureFile(t, "device.tar.gz", tarArchive([{ name: "device", type: "3" }])).file;
  assert.throws(() => readPortableArchiveEntries(device), /link or special ustar entry/u);

  const setid = fixtureFile(t, "setid.tar.gz", tarArchive([{ name: "file", mode: 0o4644 }])).file;
  assert.throws(() => readPortableArchiveEntries(setid), /set-id or sticky permission bits/u);

  const tar = gunzipForTest(validBytes);
  tar[0] ^= 1;
  const badChecksum = fixtureFile(t, "checksum.tar.gz", gzipSync(tar, { mtime: 0 })).file;
  assert.throws(() => readPortableArchiveEntries(badChecksum), /header checksum/u);

  const withoutEnd = gunzipForTest(validBytes).subarray(0, 1024);
  const badEnd = fixtureFile(t, "end.tar.gz", gzipSync(withoutEnd, { mtime: 0 })).file;
  assert.throws(() => readPortableArchiveEntries(badEnd), /two-block ustar end marker/u);

  const paddedTar = gunzipForTest(validBytes);
  paddedTar[512 + 2] = 1;
  const badPadding = fixtureFile(t, "padding.tar.gz", gzipSync(paddedTar, { mtime: 0 })).file;
  assert.throws(() => readPortableArchiveEntries(badPadding), /non-zero ustar padding/u);

  assert.throws(
    () => readPortableArchiveEntries(valid, { maxExpandedBytes: 1024 }),
    /bounded readable gzip stream/u,
  );

  const numericJunkTar = gunzipForTest(validBytes);
  numericJunkTar[155] = "X".charCodeAt(0);
  const numericJunk = fixtureFile(t, "numeric-junk.tar.gz", gzipSync(numericJunkTar)).file;
  assert.throws(() => readPortableArchiveEntries(numericJunk), /non-padding bytes after the ustar checksum terminator/u);

  const deviceFieldTar = gunzipForTest(validBytes);
  tarOctal(1, 8).copy(deviceFieldTar, 329);
  refreshFirstTarChecksum(deviceFieldTar);
  const deviceField = fixtureFile(t, "device-field.tar.gz", gzipSync(deviceFieldTar)).file;
  assert.throws(() => readPortableArchiveEntries(deviceField), /sets device numbers on non-device/u);

  const linkFieldTar = gunzipForTest(validBytes);
  Buffer.from("unexpected-target\0").copy(linkFieldTar, 157);
  refreshFirstTarChecksum(linkFieldTar);
  const linkField = fixtureFile(t, "link-field.tar.gz", gzipSync(linkFieldTar)).file;
  assert.throws(() => readPortableArchiveEntries(linkField), /sets a link target on non-link/u);
});

test("rejects trailing bytes, concatenated gzip members, and corrupt gzip trailers", (t) => {
  const valid = tarArchive([{ name: "file", data: "payload" }]);
  const concatenated = fixtureFile(t, "concatenated.tar.gz", Buffer.concat([valid, valid])).file;
  assert.throws(() => readPortableArchiveEntries(concatenated), /trailing data or multiple gzip members/u);

  const trailing = fixtureFile(t, "trailing.tar.gz", Buffer.concat([valid, Buffer.from("trailing")])).file;
  assert.throws(() => readPortableArchiveEntries(trailing), /gzip/u);

  const corrupt = Buffer.from(valid);
  corrupt[corrupt.length - 8] ^= 1;
  const corruptTrailer = fixtureFile(t, "corrupt-trailer.tar.gz", corrupt).file;
  assert.throws(() => readPortableArchiveEntries(corruptTrailer), /gzip payload CRC-32/u);
});

test("rejects symlink archive inputs before parsing", (t) => {
  const { file, root } = fixtureFile(t, "real.zip", zipArchive([{ name: "file" }]));
  const linked = path.join(root, "linked.zip");
  symlinkSync(file, linked);
  assert.throws(() => readPortableArchiveEntries(linked), /regular, non-symlink/u);
});

test("accepts ZIPs emitted by the canonical archive_dir producer", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "portable-producer-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const source = path.join(root, "Fixture.xcframework");
  mkdirSync(source);
  writeFileSync(path.join(source, "Info.plist"), "fixture");
  const output = path.join(root, "fixture.zip");
  const result = spawnSync(
    path.join(ROOT, "tools/dev/bun.sh"),
    ["tools/release/archive_dir.mjs", "--keep-parent", source, output],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const entries = readPortableArchiveEntries(output);
  assert.equal(entries.get("Fixture.xcframework/Info.plist").data().toString(), "fixture");
});

function gunzipForTest(buffer) {
  return gunzipSync(buffer);
}
