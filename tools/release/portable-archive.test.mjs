import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import test from "node:test";
import { deflateRawSync, gunzipSync, gzipSync, zstdCompressSync } from "node:zlib";

import {
  canonicalGzipSync,
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  decompressSingleZstdFrame,
  normalizeCanonicalGzipHeader,
  portableMemberName,
  readAndroidApkEntries,
  readCanonicalTarGzipEntries,
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
} from "./portable-archive.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("exposes the same portable member contract to nested carrier consumers", () => {
  const archive = "/tmp/carrier.tar.gz";
  const member = "carrier/extensions/postgis/postgis-ios-xcframework.tar.gz";
  assert.equal(portableMemberName(member, "file", archive), member);
  assert.throws(
    () => portableMemberName("carrier/extensions/postgis/../escape", "file", archive),
    /unsafe archive member/u,
  );
  assert.throws(
    () => portableMemberName("carrier/extensions/postgis/file/", "file", archive),
    /type\/path-marker mismatch/u,
  );
});

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

function zipArchive(rows, { beforeCentral = Buffer.alloc(0) } = {}) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const row of rows) {
    const name = Buffer.from(row.localName ?? row.name, "utf8");
    const centralName = Buffer.from(row.name, "utf8");
    const data = Buffer.from(row.data ?? "payload");
    const method = row.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const flags = (row.flags ?? 0) | (row.descriptor ? 0x0008 : 0);
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
    let descriptor = Buffer.alloc(0);
    if (row.descriptor) {
      descriptor = Buffer.alloc(row.descriptor === "signed" ? 16 : 12);
      let descriptorOffset = 0;
      if (row.descriptor === "signed") {
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptorOffset = 4;
      }
      descriptor.writeUInt32LE(row.descriptorCrc ?? storedCrc, descriptorOffset);
      descriptor.writeUInt32LE(compressed.length, descriptorOffset + 4);
      descriptor.writeUInt32LE(data.length, descriptorOffset + 8);
    }
    const localRecord = Buffer.concat([
      local,
      name,
      localExtra,
      compressed,
      descriptor,
      row.afterData ?? Buffer.alloc(0),
    ]);
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
  eocd.writeUInt32LE(localOffset + beforeCentral.length, 16);
  return Buffer.concat([...locals, beforeCentral, centralDirectory, eocd]);
}

function androidAlignmentExtra(alignment, paddingLength, paddingByte = 0) {
  const extra = Buffer.alloc(6 + paddingLength, paddingByte);
  extra.writeUInt16LE(0xd935, 0);
  extra.writeUInt16LE(2 + paddingLength, 2);
  extra.writeUInt16LE(alignment, 4);
  return extra;
}

function apkSigningBlock(pairs = [{ id: 0x7109871a, data: "signature" }]) {
  const pairBuffers = pairs.map(({ id, data }) => {
    const value = Buffer.from(data);
    const pair = Buffer.alloc(12 + value.length);
    pair.writeBigUInt64LE(BigInt(4 + value.length), 0);
    pair.writeUInt32LE(id, 8);
    value.copy(pair, 12);
    return pair;
  });
  const pairBytes = Buffer.concat(pairBuffers);
  const size = 24 + pairBytes.length;
  const header = Buffer.alloc(8);
  const footer = Buffer.alloc(8);
  header.writeBigUInt64LE(BigInt(size), 0);
  footer.writeBigUInt64LE(BigInt(size), 0);
  return Buffer.concat([header, pairBytes, footer, Buffer.from("APK Sig Block 42", "ascii")]);
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
  return canonicalGzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
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

test("canonicalizes host-derived gzip metadata without changing payload or caller bytes", () => {
  const payload = Buffer.from("portable gzip payload\n");
  const hostArchive = Buffer.from(gzipSync(payload, { mtime: 0 }));
  hostArchive.fill(0x7f, 4, 9);
  hostArchive[9] = 0x07;
  const original = Buffer.from(hostArchive);

  const canonical = normalizeCanonicalGzipHeader(hostArchive);
  assert.deepEqual(
    canonical.subarray(0, 10),
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]),
  );
  assert.deepEqual(gunzipSync(canonical), payload);
  assert.deepEqual(hostArchive, original);
  assert.throws(
    () => normalizeCanonicalGzipHeader(Buffer.from("not gzip")),
    /flag-free gzip stream/u,
  );
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

test("accepts Android legacy and 0xd935 alignment only in the APK profile", (t) => {
  // This reproduces the exact two zero bytes on the AGP-produced
  // assets/dexopt/baseline.prof that exposed the release failure. The leading
  // record puts its data at a four-byte-aligned offset.
  const legacy = fixtureFile(
    t,
    "legacy-aligned.apk",
    zipArchive([
      { name: "aaaa" },
      { name: "assets/dexopt/baseline.prof", data: "profile", localExtra: Buffer.alloc(2) },
    ]),
  ).file;
  assert.throws(() => readPortableArchiveEntries(legacy), /truncated ZIP local/u);
  assert.equal(
    readAndroidApkEntries(legacy).get("assets/dexopt/baseline.prof").data().toString(),
    "profile",
  );

  // Official apksigner rewrites the same member to d935,size=3,alignment=4,
  // one zero byte; with this path the payload begins at byte offset 64.
  const structured = fixtureFile(
    t,
    "structured-aligned.apk",
    zipArchive([{
      name: "assets/dexopt/baseline.prof",
      data: "profile",
      localExtra: androidAlignmentExtra(4, 1),
    }]),
  ).file;
  assert.throws(() => readPortableArchiveEntries(structured), /unsupported ZIP local/u);
  assert.equal(
    readAndroidApkEntries(structured).get("assets/dexopt/baseline.prof").data().toString(),
    "profile",
  );

  const sharedLibraryName = "lib/arm64-v8a/liboliphaunt.so";
  const unpaddedSharedLibraryOffset = 30 + Buffer.byteLength(sharedLibraryName) + 6;
  const sharedLibraryPadding = (
    16 * 1024 - (unpaddedSharedLibraryOffset % (16 * 1024))
  ) % (16 * 1024);
  const sharedLibrary = fixtureFile(
    t,
    "structured-shared-library.apk",
    zipArchive([{
      name: sharedLibraryName,
      data: "ELF",
      localExtra: androidAlignmentExtra(16 * 1024, sharedLibraryPadding),
    }]),
  ).file;
  assert.equal(
    readAndroidApkEntries(sharedLibrary).get(sharedLibraryName).data().toString(),
    "ELF",
  );
});

test("rejects malformed or misplaced Android alignment metadata", (t) => {
  const cases = [
    [
      "legacy-unaligned.apk",
      { name: "assets/dexopt/baseline.prof", localExtra: Buffer.alloc(2) },
      /malformed legacy APK alignment/u,
    ],
    [
      "legacy-nonzero.apk",
      { name: "assets/dexopt/baseline.prof", localExtra: Buffer.from([0, 1]) },
      /truncated ZIP local/u,
    ],
    [
      "alignment-too-short.apk",
      { name: "assets/dexopt/baseline.prof", localExtra: Buffer.from([0x35, 0xd9, 1, 0, 4]) },
      /malformed APK alignment/u,
    ],
    [
      "alignment-nonzero.apk",
      { name: "assets/dexopt/baseline.prof", localExtra: androidAlignmentExtra(4, 1, 1) },
      /malformed APK alignment/u,
    ],
    [
      "alignment-unaligned.apk",
      { name: "assets/dexopt/baseline.prof", localExtra: androidAlignmentExtra(4, 0) },
      /malformed APK alignment/u,
    ],
    [
      "alignment-wrong-multiple.apk",
      { name: "assets/dexopt/baseline.prof", localExtra: androidAlignmentExtra(8, 5) },
      /malformed APK alignment/u,
    ],
    [
      "alignment-redundant.apk",
      { name: "assets/dexopt/baseline.prof", localExtra: androidAlignmentExtra(4, 5) },
      /malformed APK alignment/u,
    ],
    [
      "alignment-compressed.apk",
      {
        name: "assets/dexopt/baseline.prof",
        method: 8,
        localExtra: androidAlignmentExtra(4, 1),
      },
      /alignment metadata on compressed/u,
    ],
    [
      "alignment-central.apk",
      { name: "assets/dexopt/baseline.prof", centralExtra: androidAlignmentExtra(4, 1) },
      /unsupported ZIP central/u,
    ],
    [
      "alignment-not-last.apk",
      {
        name: "assets/dexopt/baseline.prof",
        localExtra: Buffer.concat([
          androidAlignmentExtra(4, 1),
          Buffer.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0]),
        ]),
      },
      /does not place APK alignment ZIP metadata last/u,
    ],
  ];
  for (const [name, row, pattern] of cases) {
    const file = fixtureFile(t, name, zipArchive([row])).file;
    assert.throws(() => readAndroidApkEntries(file), pattern);
  }
});

test("accepts a framed APK Signing Block and unknown extension pairs", (t) => {
  const block = apkSigningBlock([
    { id: 0x504b4453, data: "unknown-but-framed" },
    { id: 0x7109871a, data: "v2-signature-container" },
  ]);
  for (const descriptor of [undefined, "unsigned", "signed"]) {
    const file = fixtureFile(
      t,
      `signed-${descriptor ?? "none"}.apk`,
      zipArchive(
        [{ name: "AndroidManifest.xml", data: "manifest", descriptor }],
        { beforeCentral: block },
      ),
    ).file;
    assert.throws(() => readPortableArchiveEntries(file), /ambiguous .*gap/u);
    assert.equal(
      readAndroidApkEntries(file).get("AndroidManifest.xml").data().toString(),
      "manifest",
    );
  }

  const manifestRecordBytes = 30
    + Buffer.byteLength("AndroidManifest.xml")
    + Buffer.byteLength("manifest");
  const canonicalPadding = 4096 - manifestRecordBytes;
  const padded = fixtureFile(
    t,
    "signed-canonical-padding.apk",
    zipArchive(
      [{ name: "AndroidManifest.xml", data: "manifest" }],
      { beforeCentral: Buffer.concat([Buffer.alloc(canonicalPadding), block]) },
    ),
  ).file;
  assert.equal(
    readAndroidApkEntries(padded).get("AndroidManifest.xml").data().toString(),
    "manifest",
  );
});

test("rejects malformed APK Signing Block gaps and descriptors", (t) => {
  const valid = apkSigningBlock();
  const badHeaderSize = Buffer.from(valid);
  badHeaderSize.writeBigUInt64LE(badHeaderSize.readBigUInt64LE(0) + 1n, 0);
  const badPairSize = Buffer.from(valid);
  badPairSize.writeBigUInt64LE(3n, 8);
  const unknownOnly = apkSigningBlock([{ id: 0x504b4453, data: "extension" }]);
  const duplicatePair = apkSigningBlock([
    { id: 0x7109871a, data: "first" },
    { id: 0x7109871a, data: "second" },
  ]);
  const cases = [
    ["opaque-gap.apk", Buffer.alloc(32, 1), /unrecognized gap/u],
    ["nonzero-padding.apk", Buffer.concat([Buffer.from([1]), valid]), /non-zero padding/u],
    [
      "noncanonical-zero-padding.apk",
      Buffer.concat([Buffer.alloc(17), valid]),
      /non-canonical zero padding/u,
    ],
    ["size-mismatch.apk", badHeaderSize, /disagreeing APK Signing Block sizes/u],
    ["bad-pair.apk", badPairSize, /invalid APK Signing Block pair size/u],
    ["no-signature-scheme.apk", unknownOnly, /without a v2, v3, or v3[.]1/u],
    ["duplicate-pair.apk", duplicatePair, /repeats APK Signing Block pair ID/u],
  ];
  for (const [name, beforeCentral, pattern] of cases) {
    const file = fixtureFile(
      t,
      name,
      zipArchive([{ name: "AndroidManifest.xml", data: "manifest" }], { beforeCentral }),
    ).file;
    assert.throws(() => readAndroidApkEntries(file), pattern);
  }

  const invalidDescriptor = fixtureFile(
    t,
    "invalid-descriptor.apk",
    zipArchive(
      [{ name: "AndroidManifest.xml", descriptor: "signed", descriptorCrc: 0x12345678 }],
      { beforeCentral: valid },
    ),
  ).file;
  assert.throws(
    () => readAndroidApkEntries(invalidDescriptor),
    /invalid or ambiguous ZIP descriptor/u,
  );

  const internalGap = fixtureFile(
    t,
    "internal-gap.apk",
    zipArchive([
      { name: "first", afterData: Buffer.alloc(4) },
      { name: "second" },
    ]),
  ).file;
  assert.throws(() => readAndroidApkEntries(internalGap), /ambiguous 4-byte gap/u);
});

test("retains entry safety and integrity checks in the Android APK profile", (t) => {
  const cases = [
    ["traversal.apk", [{ name: "../escape" }], /unsafe archive member/u],
    ["duplicate.apk", [{ name: "same" }, { name: "same" }], /repeats archive member/u],
    ["link.apk", [{ name: "link", externalAttributes: 0o120777 << 16 }], /link or special/u],
    ["setid.apk", [{ name: "file", externalAttributes: 0o104644 << 16 }], /set-id or sticky/u],
    ["crc.apk", [{ name: "file", crc: 0x12345678 }], /CRC-32 mismatch/u],
  ];
  for (const [name, rows, pattern] of cases) {
    const file = fixtureFile(t, name, zipArchive(rows)).file;
    assert.throws(() => readAndroidApkEntries(file), pattern);
  }

  const caseSensitive = fixtureFile(
    t,
    "aapt-case-sensitive.apk",
    zipArchive([{ name: "res/2F.xml" }, { name: "res/2f.xml" }]),
  ).file;
  assert.deepEqual(
    [...readAndroidApkEntries(caseSensitive).keys()],
    ["res/2F.xml", "res/2f.xml"],
  );
  assert.throws(() => readPortableArchiveEntries(caseSensitive), /case\/NFC-colliding/u);
});

test("requires ZIP directory type flags and trailing path markers to agree", (t) => {
  const valid = fixtureFile(
    t,
    "directory.zip",
    zipArchive([
      {
        name: "root/",
        data: "",
        externalAttributes: ((0o040755 << 16) | 0x10) >>> 0,
      },
      { name: "root/file.txt", data: "ok" },
    ]),
  ).file;
  const entries = readPortableArchiveEntries(valid);
  assert.equal(entries.get("root").isDirectory, true);
  assert.equal(entries.get("root/file.txt").isFile, true);

  for (const [name, row] of [
    ["missing-marker.zip", { name: "root", data: "", externalAttributes: ((0o040755 << 16) | 0x10) >>> 0 }],
    ["file-with-marker.zip", { name: "root/", externalAttributes: 0o100644 << 16 }],
  ]) {
    const file = fixtureFile(t, name, zipArchive([row])).file;
    assert.throws(() => readPortableArchiveEntries(file), /type\/path-marker|directory metadata/u);
  }
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

test("binds the exact deterministic tar-gzip encoding used by release consumers", (t) => {
  const validBytes = tarArchive([
    { name: "root/LICENSE", data: "license\n" },
    { name: "root/bundle-manifest.json", data: "{}\n" },
  ]);
  const valid = fixtureFile(t, "canonical.tar.gz", validBytes).file;
  assert.deepEqual([...readCanonicalTarGzipEntries(valid).keys()], [
    "root/LICENSE",
    "root/bundle-manifest.json",
  ]);

  const wrongGzipHeader = Buffer.from(validBytes);
  wrongGzipHeader[9] = 0;
  const wrongGzip = fixtureFile(t, "wrong-gzip-header.tar.gz", wrongGzipHeader).file;
  assert.throws(
    () => readCanonicalTarGzipEntries(wrongGzip),
    /canonical gzip method, flags, mtime, XFL, and OS header/u,
  );

  const ownerTar = gunzipForTest(validBytes);
  Buffer.from("builder\0", "ascii").copy(ownerTar, 265);
  refreshFirstTarChecksum(ownerTar);
  const owner = fixtureFile(t, "owner.tar.gz", canonicalGzipSync(ownerTar)).file;
  assert.doesNotThrow(() => readPortableArchiveEntries(owner));
  assert.throws(
    () => readCanonicalTarGzipEntries(owner),
    /exact deterministic POSIX ustar file encoding/u,
  );

  const unsorted = fixtureFile(
    t,
    "unsorted.tar.gz",
    tarArchive([
      { name: "root/z", data: "last" },
      { name: "root/a", data: "first" },
    ]),
  ).file;
  assert.doesNotThrow(() => readPortableArchiveEntries(unsorted));
  assert.throws(
    () => readCanonicalTarGzipEntries(unsorted),
    /canonical file members.*sorted order/u,
  );
});

test("requires ustar directory type flags and trailing path markers to agree", (t) => {
  const valid = fixtureFile(
    t,
    "directory.tar.gz",
    tarArchive([
      { name: "root/", type: "5", mode: 0o755 },
      { name: "root/file", data: "ok" },
    ]),
  ).file;
  const entries = readPortableArchiveEntries(valid);
  assert.equal(entries.get("root").isDirectory, true);
  assert.equal(entries.get("root/file").isFile, true);

  for (const [name, row] of [
    ["missing-marker.tar.gz", { name: "root", type: "5", mode: 0o755 }],
    ["file-with-marker.tar.gz", { name: "root/", type: "0", mode: 0o644 }],
  ]) {
    const file = fixtureFile(t, name, tarArchive([row])).file;
    assert.throws(() => readPortableArchiveEntries(file), /type\/path-marker mismatch/u);
  }
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

test("reads one Zstandard frame and rejects trailing bytes or concatenated frames", (t) => {
  const tar = gunzipForTest(tarArchive([{ name: "root/file", data: "payload" }]));
  const valid = zstdCompressSync(tar);
  const archive = fixtureFile(t, "valid.tar.zst", valid).file;
  assert.equal(readPortableArchiveEntries(archive).get("root/file").data().toString(), "payload");

  const trailing = fixtureFile(
    t,
    "trailing.tar.zst",
    Buffer.concat([valid, Buffer.from("trailing")]),
  ).file;
  assert.throws(
    () => readPortableArchiveEntries(trailing),
    /trailing data or multiple Zstandard frames/u,
  );

  const concatenated = fixtureFile(
    t,
    "concatenated.tar.zst",
    Buffer.concat([valid, valid]),
  ).file;
  assert.throws(
    () => readPortableArchiveEntries(concatenated),
    /trailing data or multiple Zstandard frames/u,
  );
});

test("strictly parses an in-memory tar.zst with the same bounded portable contract", () => {
  const tar = gunzipForTest(tarArchive([
    { name: "oliphaunt/", type: "5", mode: 0o755 },
    { name: "oliphaunt/bin/", type: "5", mode: 0o755 },
    { name: "oliphaunt/bin/postgres", data: "runtime" },
  ]));
  const compressed = zstdCompressSync(tar);
  const entries = readPortableTarZstdBufferEntries(compressed, {
    label: "nested oliphaunt.wasix.tar.zst",
  });
  assert.deepEqual([...entries.keys()], [
    "oliphaunt",
    "oliphaunt/bin",
    "oliphaunt/bin/postgres",
  ]);
  assert.equal(entries.get("oliphaunt/bin/postgres").data().toString(), "runtime");
  assert.equal(
    decompressSingleZstdFrame(compressed, { label: "nested frame" }).equals(tar),
    true,
  );

  for (const [label, rows, pattern] of [
    ["duplicate", [{ name: "same", data: "one" }, { name: "same", data: "two" }], /repeats archive member/u],
    ["traversal", [{ name: "../escape", data: "bad" }], /unsafe archive member/u],
    ["symlink", [{ name: "link", type: "2" }], /link or special ustar entry/u],
    ["special", [{ name: "device", type: "3" }], /link or special ustar entry/u],
  ]) {
    const candidate = zstdCompressSync(gunzipForTest(tarArchive(rows)));
    assert.throws(
      () => readPortableTarZstdBufferEntries(candidate, { label }),
      pattern,
      label,
    );
  }

  assert.throws(
    () => readPortableTarZstdBufferEntries(Buffer.concat([compressed, compressed])),
    /trailing data or multiple Zstandard frames/u,
  );
  assert.throws(
    () => readPortableTarZstdBufferEntries(compressed, { maxArchiveBytes: compressed.length - 1 }),
    /no larger than/u,
  );
  assert.throws(
    () => decompressSingleZstdFrame(compressed, { maxOutputBytes: tar.length - 1 }),
    /bounded readable Zstandard stream/u,
  );
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
