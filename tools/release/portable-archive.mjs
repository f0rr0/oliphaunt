import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync, zstdDecompressSync } from "node:zlib";

export const DEFAULT_PORTABLE_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 32_768,
  maxEntryBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
});

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const ZIP_ALLOWED_FLAGS = 0x080e;
const ZIP_ALLOWED_EXTRA_FIELDS = new Set([0x5455, 0x5855, 0x7875]);

function archiveError(file, message) {
  return new Error(`portable-archive: ${path.basename(file)} ${message}`);
}

function positiveLimit(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`portable-archive: ${label} must be a positive safe integer`);
  }
  return result;
}

function limits(options) {
  return {
    maxArchiveBytes: positiveLimit(
      options.maxArchiveBytes,
      DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxArchiveBytes,
      "maxArchiveBytes",
    ),
    maxEntries: positiveLimit(
      options.maxEntries,
      DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxEntries,
      "maxEntries",
    ),
    maxEntryBytes: positiveLimit(
      options.maxEntryBytes,
      DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxEntryBytes,
      "maxEntryBytes",
    ),
    maxExpandedBytes: positiveLimit(
      options.maxExpandedBytes,
      DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxExpandedBytes,
      "maxExpandedBytes",
    ),
  };
}

function requireRegularArchive(file, maxArchiveBytes) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (cause) {
    throw archiveError(file, `cannot be inspected: ${cause.message}`);
  }
  if (!stat.isFile()) {
    throw archiveError(file, "must be a regular, non-symlink archive file");
  }
  if (stat.size <= 0 || stat.size > maxArchiveBytes) {
    throw archiveError(
      file,
      `must be non-empty and no larger than ${maxArchiveBytes} bytes; got ${stat.size}`,
    );
  }
  return stat;
}

function boundedSlice(buffer, offset, length, file, label) {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset > buffer.length
    || length > buffer.length - offset
  ) {
    throw archiveError(file, `has a truncated or unsafe ${label}`);
  }
  return buffer.subarray(offset, offset + length);
}

function decodeUtf8(bytes, file, label, { requireAscii = false } = {}) {
  if (bytes.length === 0) {
    throw archiveError(file, `has an empty ${label}`);
  }
  if (requireAscii && bytes.some((byte) => byte >= 0x80)) {
    throw archiveError(file, `has a non-ASCII ${label} without the ZIP UTF-8 flag`);
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    throw archiveError(file, `has invalid UTF-8 in ${label}`);
  }
}

export function portableMemberName(raw, type, file, { allowRoot = false } = {}) {
  if (allowRoot && type === "directory" && (raw === "." || raw === "./")) return null;
  const directoryMarker = raw.endsWith("/");
  if ((type === "directory") !== directoryMarker) {
    throw archiveError(file, `has a member type/path-marker mismatch: ${JSON.stringify(raw)}`);
  }
  if (
    raw.includes("\\")
    || raw.startsWith("/")
    || /^[A-Za-z]:/u.test(raw)
    || /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    throw archiveError(file, `has an unsafe archive member: ${JSON.stringify(raw)}`);
  }
  let value = directoryMarker ? raw.slice(0, -1) : raw;
  if (value === "." || value === "./") {
    throw archiveError(file, `has an ambiguous root archive member: ${JSON.stringify(raw)}`);
  }
  if (value.startsWith("./")) value = value.slice(2);
  const parts = value.split("/");
  if (parts.length === 0 || parts.some((part) => !part || part === "." || part === "..")) {
    throw archiveError(file, `has an unsafe archive member: ${JSON.stringify(raw)}`);
  }
  if (value !== value.normalize("NFC")) {
    throw archiveError(file, `has a non-NFC archive member: ${JSON.stringify(raw)}`);
  }
  if (Buffer.byteLength(value, "utf8") > 4096) {
    throw archiveError(file, `has an overlong archive member: ${JSON.stringify(raw)}`);
  }
  for (const segment of parts) {
    if (
      Buffer.byteLength(segment, "utf8") > 255
      ||
      /[<>:"|?*]/u.test(segment)
      || /[ .]$/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
    ) {
      throw archiveError(file, `has a non-portable archive member: ${JSON.stringify(raw)}`);
    }
  }
  return value;
}

function checkedEntries(entries, file, archiveLimits) {
  if (entries.length === 0) throw archiveError(file, "contains no archive members");
  if (entries.length > archiveLimits.maxEntries) {
    throw archiveError(file, `exceeds the ${archiveLimits.maxEntries}-entry limit`);
  }
  const exact = new Set();
  const portable = new Map();
  const files = new Set();
  let expandedBytes = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw archiveError(file, `declares an unsafe size for ${entry.name}`);
    }
    if (entry.size > archiveLimits.maxEntryBytes) {
      throw archiveError(
        file,
        `member ${entry.name} exceeds the ${archiveLimits.maxEntryBytes}-byte entry limit`,
      );
    }
    expandedBytes += entry.size;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > archiveLimits.maxExpandedBytes) {
      throw archiveError(
        file,
        `exceeds the ${archiveLimits.maxExpandedBytes}-byte expanded-data limit`,
      );
    }
    if (exact.has(entry.name)) {
      throw archiveError(file, `repeats archive member ${entry.name}`);
    }
    exact.add(entry.name);
    const portableKey = entry.name.normalize("NFC").toLowerCase();
    const prior = portable.get(portableKey);
    if (prior !== undefined && prior !== entry.name) {
      throw archiveError(
        file,
        `contains case/NFC-colliding archive members ${prior} and ${entry.name}`,
      );
    }
    portable.set(portableKey, entry.name);
    if (entry.type === "file") files.add(entry.name);
  }
  for (const entry of entries) {
    let separator = entry.name.indexOf("/");
    while (separator >= 0) {
      const parent = entry.name.slice(0, separator);
      if (files.has(parent)) {
        throw archiveError(file, `uses regular file ${parent} as an archive directory`);
      }
      separator = entry.name.indexOf("/", separator + 1);
    }
  }
  return new Map(entries.map((entry) => [entry.name, Object.freeze(entry)]));
}

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

function validateZipExtra(extra, file, label) {
  const seen = new Set();
  for (let offset = 0; offset < extra.length;) {
    if (extra.length - offset < 4) {
      throw archiveError(file, `has a truncated ZIP ${label} extra field`);
    }
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (size > extra.length - offset) {
      throw archiveError(file, `has a truncated ZIP ${label} extra field`);
    }
    if (seen.has(id)) {
      throw archiveError(
        file,
        `repeats ZIP ${label} extra field 0x${id.toString(16).padStart(4, "0")}`,
      );
    }
    seen.add(id);
    if (!ZIP_ALLOWED_EXTRA_FIELDS.has(id)) {
      throw archiveError(
        file,
        `uses unsupported ZIP ${label} extra field 0x${id.toString(16).padStart(4, "0")}`,
      );
    }
    const value = extra.subarray(offset, offset + size);
    if (id === 0x5455) {
      if (![5, 9, 13].includes(size) || (value[0] & ~0x07) !== 0 || (value[0] & 0x01) === 0) {
        throw archiveError(file, "has malformed extended-timestamp ZIP metadata");
      }
    } else if (id === 0x5855) {
      if (size !== 8 && size !== 12) {
        throw archiveError(file, "has malformed legacy Unix ZIP metadata");
      }
    } else if (id === 0x7875) {
      if (size < 5 || value[0] !== 1) {
        throw archiveError(file, "has malformed Unix UID/GID ZIP metadata");
      }
      const uidBytes = value[1];
      const gidOffset = 2 + uidBytes;
      if (uidBytes < 1 || uidBytes > 8 || gidOffset >= value.length) {
        throw archiveError(file, "has malformed Unix UID/GID ZIP metadata");
      }
      const gidBytes = value[gidOffset];
      if (gidBytes < 1 || gidBytes > 8 || gidOffset + 1 + gidBytes !== value.length) {
        throw archiveError(file, "has malformed Unix UID/GID ZIP metadata");
      }
    }
    offset += size;
  }
}

function zipEntryType(versionMadeBy, externalAttributes, rawName, file) {
  const host = versionMadeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const unixType = unixMode & 0o170000;
  const pathDirectory = rawName.endsWith("/");
  const dosDirectory = (externalAttributes & 0x10) !== 0;
  let type;
  if (host === 3) {
    if (unixType === 0o100000) {
      if (dosDirectory) {
        throw archiveError(file, `marks Unix regular file ${rawName} as a DOS directory`);
      }
      type = "file";
    } else if (unixType === 0o040000) {
      type = "directory";
    } else if (unixType === 0) {
      throw archiveError(file, `has an ambiguous Unix creator type for ${rawName}`);
    } else {
      throw archiveError(file, `contains a link or special ZIP entry: ${rawName}`);
    }
  } else if (host === 0) {
    if (unixType !== 0) {
      throw archiveError(file, `has conflicting FAT/Unix type metadata for ${rawName}`);
    }
    if (pathDirectory !== dosDirectory) {
      throw archiveError(file, `has inconsistent FAT directory metadata for ${rawName}`);
    }
    type = pathDirectory ? "directory" : "file";
  } else {
    throw archiveError(file, `uses unsupported ZIP creator host ${host} for ${rawName}`);
  }
  if ((type === "directory") !== pathDirectory) {
    throw archiveError(file, `has a member type/path-marker mismatch: ${rawName}`);
  }
  if (host === 3) validatePortableMode(unixMode & 0o7777, type, rawName, file);
  return { mode: unixMode, type };
}

function validatePortableMode(mode, type, name, file) {
  if ((mode & 0o7000) !== 0) {
    throw archiveError(file, `uses set-id or sticky permission bits for ${name}`);
  }
  if (type === "file" && (mode & 0o400) === 0) {
    throw archiveError(file, `has an owner-unreadable regular file ${name}`);
  }
  if (type === "directory" && (mode & 0o500) !== 0o500) {
    throw archiveError(file, `has an owner-unreadable or untraversable directory ${name}`);
  }
}

function findZipEnd(buffer, file) {
  if (buffer.length < 22) throw archiveError(file, "is too short to be a ZIP archive");
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (
      buffer.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length
    ) {
      return offset;
    }
  }
  throw archiveError(file, "has no well-formed ZIP end record");
}

function validateZipDescriptor(buffer, entry, offset, length, file) {
  if (length !== 12 && length !== 16) {
    throw archiveError(file, `has an ambiguous ${length}-byte gap after ZIP member ${entry.name}`);
  }
  const descriptor = boundedSlice(buffer, offset, length, file, `ZIP descriptor for ${entry.name}`);
  let cursor = 0;
  if (length === 16) {
    if (descriptor.readUInt32LE(0) !== 0x08074b50) {
      throw archiveError(file, `has an invalid ZIP descriptor signature for ${entry.name}`);
    }
    cursor = 4;
  }
  if (
    descriptor.readUInt32LE(cursor) !== entry.crc32
    || descriptor.readUInt32LE(cursor + 4) !== entry.compressedSize
    || descriptor.readUInt32LE(cursor + 8) !== entry.size
  ) {
    throw archiveError(file, `has a ZIP descriptor that disagrees with ${entry.name}`);
  }
}

function inflateZipEntry(buffer, entry, file, maxEntryBytes) {
  const compressed = boundedSlice(
    buffer,
    entry.dataOffset,
    entry.compressedSize,
    file,
    `ZIP payload for ${entry.name}`,
  );
  let data;
  if (entry.method === 0) {
    data = compressed;
  } else {
    let inflated;
    try {
      inflated = inflateRawSync(compressed, {
        info: true,
        maxOutputLength: Math.min(maxEntryBytes, entry.size) + 1,
      });
    } catch (cause) {
      throw archiveError(file, `has invalid or oversized deflate data for ${entry.name}: ${cause.message}`);
    }
    if (inflated.engine.bytesWritten !== compressed.length) {
      throw archiveError(file, `has trailing compressed bytes in ZIP member ${entry.name}`);
    }
    data = inflated.buffer;
  }
  if (data.length !== entry.size) {
    throw archiveError(
      file,
      `expanded ZIP size for ${entry.name} is ${data.length}, expected ${entry.size}`,
    );
  }
  const actualCrc = crc32(data);
  if (actualCrc !== entry.crc32) {
    throw archiveError(
      file,
      `CRC-32 mismatch for ZIP member ${entry.name}: expected ${entry.crc32.toString(16).padStart(8, "0")}, got ${actualCrc.toString(16).padStart(8, "0")}`,
    );
  }
  return data;
}

function readZipEntries(file, archiveLimits) {
  const buffer = readFileSync(file);
  const eocdOffset = findZipEnd(buffer, file);
  const eocd = boundedSlice(buffer, eocdOffset, 22, file, "ZIP end record");
  const disk = eocd.readUInt16LE(4);
  const centralDisk = eocd.readUInt16LE(6);
  const diskEntries = eocd.readUInt16LE(8);
  const entryCount = eocd.readUInt16LE(10);
  const centralSize = eocd.readUInt32LE(12);
  const centralOffset = eocd.readUInt32LE(16);
  const commentLength = eocd.readUInt16LE(20);
  if (
    disk === 0xffff
    || centralDisk === 0xffff
    || diskEntries === 0xffff
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
  ) {
    throw archiveError(file, "uses unsupported ZIP64 metadata");
  }
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw archiveError(file, "uses unsupported multi-disk ZIP metadata");
  }
  if (commentLength !== 0) throw archiveError(file, "has an unsupported ZIP archive comment");
  if (entryCount === 0 || entryCount > archiveLimits.maxEntries) {
    throw archiveError(file, `has an invalid ZIP entry count ${entryCount}`);
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw archiveError(file, "has an invalid or ambiguous ZIP central-directory extent");
  }

  const entries = [];
  let offset = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const header = boundedSlice(buffer, offset, 46, file, `ZIP central header ${index + 1}`);
    if (header.readUInt32LE(0) !== 0x02014b50) {
      throw archiveError(file, `has an invalid ZIP central header ${index + 1}`);
    }
    const versionMadeBy = header.readUInt16LE(4);
    const versionNeeded = header.readUInt16LE(6);
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    const modTime = header.readUInt16LE(12);
    const modDate = header.readUInt16LE(14);
    const expectedCrc = header.readUInt32LE(16);
    const compressedSize = header.readUInt32LE(20);
    const size = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const memberCommentLength = header.readUInt16LE(32);
    const diskStart = header.readUInt16LE(34);
    const externalAttributes = header.readUInt32LE(38);
    const localOffset = header.readUInt32LE(42);
    if (versionNeeded > 20) {
      throw archiveError(file, `requires unsupported ZIP version ${versionNeeded}`);
    }
    if ((flags & ~ZIP_ALLOWED_FLAGS) !== 0 || (flags & 0x0001) !== 0) {
      throw archiveError(file, `uses unsupported or encrypted ZIP flags 0x${flags.toString(16)}`);
    }
    if (method !== 0 && method !== 8) {
      throw archiveError(file, `uses unsupported ZIP compression method ${method}`);
    }
    if (method === 0 && (flags & 0x0006) !== 0) {
      throw archiveError(file, "uses deflate-only flags on a stored ZIP member");
    }
    if (
      compressedSize === 0xffffffff
      || size === 0xffffffff
      || localOffset === 0xffffffff
      || diskStart === 0xffff
    ) {
      throw archiveError(file, "uses unsupported ZIP64 entry metadata");
    }
    if (diskStart !== 0) throw archiveError(file, "contains a multi-disk ZIP member");
    if (memberCommentLength !== 0) throw archiveError(file, "contains a ZIP member comment");
    if (size > archiveLimits.maxEntryBytes) {
      throw archiveError(file, `ZIP member ${index + 1} exceeds the entry-size limit`);
    }
    expandedBytes += size;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > archiveLimits.maxExpandedBytes) {
      throw archiveError(file, "exceeds the expanded ZIP data limit");
    }
    const recordLength = 46 + nameLength + extraLength;
    if (offset > eocdOffset - recordLength) {
      throw archiveError(file, `has a truncated ZIP central member ${index + 1}`);
    }
    const variable = boundedSlice(
      buffer,
      offset + 46,
      nameLength + extraLength,
      file,
      `ZIP central member ${index + 1}`,
    );
    const rawNameBytes = variable.subarray(0, nameLength);
    const rawName = decodeUtf8(rawNameBytes, file, `ZIP member name ${index + 1}`, {
      requireAscii: (flags & 0x0800) === 0,
    });
    validateZipExtra(variable.subarray(nameLength), file, `central ${JSON.stringify(rawName)}`);
    const { mode, type } = zipEntryType(versionMadeBy, externalAttributes, rawName, file);
    const name = portableMemberName(rawName, type, file);
    if (type === "directory" && (size !== 0 || expectedCrc !== 0)) {
      throw archiveError(file, `has a non-empty ZIP directory member ${rawName}`);
    }
    if (method === 0 && compressedSize !== size) {
      throw archiveError(file, `has inconsistent stored ZIP sizes for ${rawName}`);
    }

    const local = boundedSlice(buffer, localOffset, 30, file, `ZIP local header for ${name}`);
    if (local.readUInt32LE(0) !== 0x04034b50) {
      throw archiveError(file, `has an invalid ZIP local header for ${name}`);
    }
    if (
      local.readUInt16LE(4) !== versionNeeded
      || local.readUInt16LE(6) !== flags
      || local.readUInt16LE(8) !== method
      || local.readUInt16LE(10) !== modTime
      || local.readUInt16LE(12) !== modDate
    ) {
      throw archiveError(file, `has local/central ZIP metadata disagreement for ${name}`);
    }
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    const localVariable = boundedSlice(
      buffer,
      localOffset + 30,
      localNameLength + localExtraLength,
      file,
      `ZIP local variable fields for ${name}`,
    );
    if (!localVariable.subarray(0, localNameLength).equals(rawNameBytes)) {
      throw archiveError(file, `has a local/central ZIP name disagreement for ${name}`);
    }
    validateZipExtra(localVariable.subarray(localNameLength), file, `local ${JSON.stringify(rawName)}`);
    const descriptor = (flags & 0x0008) !== 0;
    const localCrc = local.readUInt32LE(14);
    const localCompressedSize = local.readUInt32LE(18);
    const localSize = local.readUInt32LE(22);
    if (descriptor) {
      if (
        (localCrc !== 0 && localCrc !== expectedCrc)
        || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
        || (localSize !== 0 && localSize !== size)
      ) {
        throw archiveError(file, `has local/descriptor ZIP disagreement for ${name}`);
      }
    } else if (
      localCrc !== expectedCrc
      || localCompressedSize !== compressedSize
      || localSize !== size
    ) {
      throw archiveError(file, `has local/central ZIP CRC or size disagreement for ${name}`);
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset > centralOffset || compressedSize > centralOffset - dataOffset) {
      throw archiveError(file, `has ZIP payload outside local-record bounds for ${name}`);
    }
    entries.push({
      compressedSize,
      crc32: expectedCrc,
      dataEnd: dataOffset + compressedSize,
      dataOffset,
      descriptor,
      isDirectory: type === "directory",
      isFile: type === "file",
      isSymbolicLink: false,
      localOffset,
      method,
      mode,
      name,
      size,
      type,
    });
    offset += recordLength;
  }
  if (offset !== eocdOffset) {
    throw archiveError(file, "has trailing or missing ZIP central-directory records");
  }
  const extents = [...entries].sort(
    (left, right) => left.localOffset - right.localOffset || left.dataEnd - right.dataEnd,
  );
  if (extents[0]?.localOffset !== 0) {
    throw archiveError(file, "has unreferenced bytes before its first ZIP local record");
  }
  for (let index = 0; index < extents.length; index += 1) {
    const entry = extents[index];
    const nextOffset = extents[index + 1]?.localOffset ?? centralOffset;
    if (entry.dataEnd > nextOffset) throw archiveError(file, "has overlapping ZIP local records");
    const gap = nextOffset - entry.dataEnd;
    if (entry.descriptor) validateZipDescriptor(buffer, entry, entry.dataEnd, gap, file);
    else if (gap !== 0) {
      throw archiveError(file, `has an ambiguous ${gap}-byte gap after ZIP member ${entry.name}`);
    }
  }

  for (const entry of entries) {
    const payload = {
      compressedSize: entry.compressedSize,
      crc32: entry.crc32,
      dataOffset: entry.dataOffset,
      method: entry.method,
      name: entry.name,
      size: entry.size,
    };
    inflateZipEntry(buffer, payload, file, archiveLimits.maxEntryBytes);
    entry.data = () => inflateZipEntry(buffer, payload, file, archiveLimits.maxEntryBytes);
    delete entry.compressedSize;
    delete entry.crc32;
    delete entry.dataEnd;
    delete entry.dataOffset;
    delete entry.descriptor;
    delete entry.localOffset;
    delete entry.method;
  }
  return checkedEntries(entries, file, archiveLimits);
}

function tarString(header, offset, length, file, label, { allowEmpty = false } = {}) {
  const field = header.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  const value = zero < 0 ? field : field.subarray(0, zero);
  if (zero >= 0 && field.subarray(zero).some((byte) => byte !== 0)) {
    throw archiveError(file, `has malformed ustar ${label}`);
  }
  if (value.length === 0) {
    if (allowEmpty) return "";
    throw archiveError(file, `has an empty ustar ${label}`);
  }
  try {
    return UTF8.decode(value);
  } catch {
    throw archiveError(file, `has invalid UTF-8 in ustar ${label}`);
  }
}

function tarOctal(header, offset, length, file, label, { allowEmpty = false } = {}) {
  const field = header.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) {
    throw archiveError(file, `uses unsupported base-256 ustar ${label}`);
  }
  const zero = field.indexOf(0);
  const value = zero < 0 ? field : field.subarray(0, zero);
  if (zero >= 0 && field.subarray(zero + 1).some((byte) => byte !== 0 && byte !== 0x20)) {
    throw archiveError(file, `has non-padding bytes after the ustar ${label} terminator`);
  }
  if (value.some((byte) => byte !== 0x20 && (byte < 0x30 || byte > 0x37))) {
    throw archiveError(file, `has invalid ustar ${label}`);
  }
  const text = value.toString("ascii").trim();
  if (text.length === 0 && allowEmpty) return 0;
  if (!/^[0-7]+$/u.test(text)) throw archiveError(file, `has invalid ustar ${label}`);
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw archiveError(file, `has unsafe ustar ${label}`);
  }
  return parsed;
}

function gzipPortableText(compressed, start, end, file, label) {
  const bytes = compressed.subarray(start, end);
  if (
    bytes.some((byte) => byte < 0x20 || byte > 0x7e)
    || bytes.length === 0
  ) {
    throw archiveError(file, `has a non-portable gzip ${label}`);
  }
}

function gzipZeroTerminatedEnd(compressed, offset, trailerOffset, file, label) {
  const end = compressed.indexOf(0, offset);
  if (end < offset || end >= trailerOffset) {
    throw archiveError(file, `has a truncated gzip ${label}`);
  }
  gzipPortableText(compressed, offset, end, file, label);
  return end + 1;
}

function strictGunzip(compressed, file, maxOutputLength) {
  if (
    compressed.length < 18
    || compressed[0] !== 0x1f
    || compressed[1] !== 0x8b
    || compressed[2] !== 8
  ) {
    throw archiveError(file, "is not a gzip-compressed deflate stream");
  }
  const flags = compressed[3];
  if ((flags & 0xe0) !== 0) throw archiveError(file, "uses reserved gzip flags");
  const trailerOffset = compressed.length - 8;
  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (offset > trailerOffset - 2) throw archiveError(file, "has a truncated gzip extra length");
    const extraLength = compressed.readUInt16LE(offset);
    offset += 2;
    if (extraLength > trailerOffset - offset) throw archiveError(file, "has truncated gzip extra data");
    offset += extraLength;
  }
  if ((flags & 0x08) !== 0) {
    offset = gzipZeroTerminatedEnd(compressed, offset, trailerOffset, file, "filename");
  }
  if ((flags & 0x10) !== 0) {
    offset = gzipZeroTerminatedEnd(compressed, offset, trailerOffset, file, "comment");
  }
  if ((flags & 0x02) !== 0) {
    if (offset > trailerOffset - 2) throw archiveError(file, "has a truncated gzip header CRC");
    const expectedHeaderCrc = compressed.readUInt16LE(offset);
    const actualHeaderCrc = crc32(compressed.subarray(0, offset)) & 0xffff;
    if (expectedHeaderCrc !== actualHeaderCrc) throw archiveError(file, "has an invalid gzip header CRC");
    offset += 2;
  }
  if (offset >= trailerOffset) throw archiveError(file, "has no gzip deflate payload");
  const deflate = compressed.subarray(offset, trailerOffset);
  let inflated;
  try {
    inflated = inflateRawSync(deflate, { info: true, maxOutputLength });
  } catch (cause) {
    throw archiveError(file, `is not a bounded readable gzip stream: ${cause.message}`);
  }
  if (inflated.engine.bytesWritten !== deflate.length) {
    throw archiveError(file, "contains trailing data or multiple gzip members");
  }
  const expectedCrc = compressed.readUInt32LE(trailerOffset);
  const expectedSize = compressed.readUInt32LE(trailerOffset + 4);
  const actualCrc = crc32(inflated.buffer);
  if (actualCrc !== expectedCrc) throw archiveError(file, "has an invalid gzip payload CRC-32");
  if (inflated.buffer.length !== expectedSize) throw archiveError(file, "has an invalid gzip payload size");
  return inflated.buffer;
}

export function decompressSingleZstdFrame(
  input,
  {
    label = "Zstandard payload",
    maxInputBytes = DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxArchiveBytes,
    maxOutputBytes = DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxExpandedBytes,
  } = {},
) {
  const checkedMaxInputBytes = positiveLimit(
    maxInputBytes,
    DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxArchiveBytes,
    "maxInputBytes",
  );
  const checkedMaxOutputBytes = positiveLimit(
    maxOutputBytes,
    DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxExpandedBytes,
    "maxOutputBytes",
  );
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw archiveError(label, "must be provided as a Buffer or Uint8Array");
  }
  const compressed = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (compressed.length === 0 || compressed.length > checkedMaxInputBytes) {
    throw archiveError(
      label,
      `must be non-empty and no larger than ${checkedMaxInputBytes} bytes; got ${compressed.length}`,
    );
  }
  if (
    compressed.length < 4
    || compressed[0] !== 0x28
    || compressed[1] !== 0xb5
    || compressed[2] !== 0x2f
    || compressed[3] !== 0xfd
  ) {
    throw archiveError(label, "is not a Zstandard frame");
  }
  let decompressed;
  try {
    decompressed = zstdDecompressSync(compressed, {
      info: true,
      maxOutputLength: checkedMaxOutputBytes,
    });
  } catch (cause) {
    throw archiveError(label, `is not a bounded readable Zstandard stream: ${cause.message}`);
  }
  if (decompressed.engine.bytesWritten !== compressed.length) {
    throw archiveError(label, "contains trailing data or multiple Zstandard frames");
  }
  return decompressed.buffer;
}

function parseTarEntries(tar, file, archiveLimits) {
  if (tar.length === 0 || tar.length % 512 !== 0) {
    throw archiveError(file, "has a truncated or non-block-aligned ustar stream");
  }
  const entries = [];
  let offset = 0;
  let memberCount = 0;
  let zeroBlocks = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks >= 2) {
        if (tar.subarray(offset).some((byte) => byte !== 0)) {
          throw archiveError(file, "has data after its two-block ustar end marker");
        }
        break;
      }
      continue;
    }
    if (zeroBlocks !== 0) throw archiveError(file, "has an incomplete ustar end marker");
    memberCount += 1;
    if (memberCount > archiveLimits.maxEntries) {
      throw archiveError(file, `exceeds the ${archiveLimits.maxEntries}-entry limit`);
    }
    const posixUstar = header.subarray(257, 263).equals(Buffer.from("ustar\0"))
      && header.subarray(263, 265).equals(Buffer.from("00"));
    const gnuUstar = header.subarray(257, 263).equals(Buffer.from("ustar "))
      && header[263] === 0x20
      && header[264] === 0;
    if (!posixUstar && !gnuUstar) throw archiveError(file, "contains a non-ustar header");
    const storedChecksum = tarOctal(header, 148, 8, file, "checksum");
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (storedChecksum !== actualChecksum) {
      throw archiveError(file, "has an invalid ustar header checksum");
    }
    const rawName = tarString(header, 0, 100, file, "name");
    const prefix = tarString(header, 345, 155, file, "prefix", { allowEmpty: true });
    const raw = prefix ? `${prefix}/${rawName}` : rawName;
    const mode = tarOctal(header, 100, 8, file, `mode for ${raw}`);
    const uid = tarOctal(header, 108, 8, file, `uid for ${raw}`, { allowEmpty: true });
    const gid = tarOctal(header, 116, 8, file, `gid for ${raw}`, { allowEmpty: true });
    const size = tarOctal(header, 124, 12, file, `size for ${raw}`);
    const mtime = tarOctal(header, 136, 12, file, `mtime for ${raw}`, { allowEmpty: true });
    const typeFlag = header[156];
    const type = typeFlag === 0 || typeFlag === 0x30
      ? "file"
      : typeFlag === 0x35
        ? "directory"
        : null;
    if (type === null) throw archiveError(file, `contains a link or special ustar entry: ${raw}`);
    if (type === "directory" && size !== 0) {
      throw archiveError(file, `has a non-empty ustar directory member ${raw}`);
    }
    if (tarString(header, 157, 100, file, `link name for ${raw}`, { allowEmpty: true }) !== "") {
      throw archiveError(file, `sets a link target on non-link ustar member ${raw}`);
    }
    tarString(header, 265, 32, file, `owner name for ${raw}`, { allowEmpty: true });
    tarString(header, 297, 32, file, `group name for ${raw}`, { allowEmpty: true });
    const deviceMajor = tarOctal(header, 329, 8, file, `device major for ${raw}`, { allowEmpty: true });
    const deviceMinor = tarOctal(header, 337, 8, file, `device minor for ${raw}`, { allowEmpty: true });
    if (deviceMajor !== 0 || deviceMinor !== 0) {
      throw archiveError(file, `sets device numbers on non-device ustar member ${raw}`);
    }
    if (posixUstar && header.subarray(500, 512).some((byte) => byte !== 0)) {
      throw archiveError(file, `has non-zero reserved ustar header bytes for ${raw}`);
    }
    if (gnuUstar && header.subarray(345, 512).some((byte) => byte !== 0)) {
      throw archiveError(file, `uses unsupported extended GNU ustar metadata for ${raw}`);
    }
    if (mode > 0o7777) throw archiveError(file, `has invalid ustar permission bits for ${raw}`);
    validatePortableMode(mode, type, raw, file);
    if (size > archiveLimits.maxEntryBytes) {
      throw archiveError(file, `ustar member ${raw} exceeds the entry-size limit`);
    }
    const name = portableMemberName(raw, type, file, { allowRoot: true });
    const dataOffset = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    if (
      !Number.isSafeInteger(paddedSize)
      || dataOffset > tar.length
      || paddedSize > tar.length - dataOffset
    ) {
      throw archiveError(file, `has a truncated ustar payload for ${raw}`);
    }
    if (tar.subarray(dataOffset + size, dataOffset + paddedSize).some((byte) => byte !== 0)) {
      throw archiveError(file, `has non-zero ustar padding for ${raw}`);
    }
    if (name !== null) {
      const data = tar.subarray(dataOffset, dataOffset + size);
      entries.push({
        data: () => data,
        gid,
        isDirectory: type === "directory",
        isFile: type === "file",
        isSymbolicLink: false,
        mode,
        mtime,
        name,
        size,
        type,
        uid,
      });
    }
    offset = dataOffset + paddedSize;
  }
  if (zeroBlocks < 2) throw archiveError(file, "is missing its two-block ustar end marker");
  return checkedEntries(entries, file, archiveLimits);
}

function decompressedTarBuffer(compressed, file, archiveLimits, compression) {
  try {
    if (compression === "gzip") {
      return strictGunzip(compressed, file, archiveLimits.maxExpandedBytes);
    }
    return decompressSingleZstdFrame(compressed, {
      label: file,
      maxInputBytes: archiveLimits.maxArchiveBytes,
      maxOutputBytes: archiveLimits.maxExpandedBytes,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("portable-archive:")) throw cause;
    throw archiveError(file, `is not a bounded readable ${compression} stream: ${cause.message}`);
  }
}

function readTarBufferEntries(compressed, file, archiveLimits, compression = "gzip") {
  return parseTarEntries(
    decompressedTarBuffer(compressed, file, archiveLimits, compression),
    file,
    archiveLimits,
  );
}

function canonicalTarPathParts(name, file) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  const parts = name.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const suffix = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) {
      return { name: suffix, prefix };
    }
  }
  throw archiveError(file, `has a path that cannot use canonical POSIX ustar fields: ${name}`);
}

function writeCanonicalTarString(header, offset, length, value, file, label) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) {
    throw archiveError(file, `has an overlong canonical ustar ${label}`);
  }
  bytes.copy(header, offset);
}

function writeCanonicalTarOctal(header, offset, length, value, file, label) {
  const text = value.toString(8);
  if (text.length > length - 1) {
    throw archiveError(file, `has a canonical ustar ${label} overflow`);
  }
  writeCanonicalTarString(
    header,
    offset,
    length,
    `${text.padStart(length - 1, "0")}\0`,
    file,
    label,
  );
}

function canonicalTarHeader(name, size, mode, file) {
  const header = Buffer.alloc(512);
  const fields = canonicalTarPathParts(name, file);
  writeCanonicalTarString(header, 0, 100, fields.name, file, `name for ${name}`);
  writeCanonicalTarOctal(header, 100, 8, mode, file, `mode for ${name}`);
  writeCanonicalTarOctal(header, 108, 8, 0, file, `uid for ${name}`);
  writeCanonicalTarOctal(header, 116, 8, 0, file, `gid for ${name}`);
  writeCanonicalTarOctal(header, 124, 12, size, file, `size for ${name}`);
  writeCanonicalTarOctal(header, 136, 12, 0, file, `mtime for ${name}`);
  header.fill(0x20, 148, 156);
  writeCanonicalTarString(header, 156, 1, "0", file, `type for ${name}`);
  writeCanonicalTarString(header, 257, 6, "ustar\0", file, `magic for ${name}`);
  writeCanonicalTarString(header, 263, 2, "00", file, `version for ${name}`);
  writeCanonicalTarString(header, 345, 155, fields.prefix, file, `prefix for ${name}`);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  const checksumText = checksum.toString(8);
  if (checksumText.length > 6) {
    throw archiveError(file, `has a canonical ustar checksum overflow for ${name}`);
  }
  writeCanonicalTarString(
    header,
    148,
    8,
    `${checksumText.padStart(6, "0")}\0 `,
    file,
    `checksum for ${name}`,
  );
  return header;
}

function canonicalFileTar(entries, file, mode) {
  const names = [...entries.keys()];
  const sorted = [...names].sort();
  if (JSON.stringify(names) !== JSON.stringify(sorted)) {
    throw archiveError(file, "must list canonical file members in bytewise sorted order");
  }
  const chunks = [];
  for (const [name, entry] of entries) {
    if (
      !entry.isFile
      || entry.isDirectory
      || entry.isSymbolicLink
      || entry.mode !== mode
      || entry.uid !== 0
      || entry.gid !== 0
      || entry.mtime !== 0
    ) {
      throw archiveError(
        file,
        `member ${name} must be a canonical regular mode=${mode.toString(8).padStart(4, "0")} uid=0 gid=0 mtime=0 file`,
      );
    }
    const data = Buffer.from(entry.data());
    if (data.length !== entry.size) {
      throw archiveError(file, `member ${name} changed while reconstructing its canonical ustar bytes`);
    }
    chunks.push(canonicalTarHeader(name, data.length, mode, file), data);
    const remainder = data.length % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function readTarEntries(file, archiveLimits, compression = "gzip") {
  return readTarBufferEntries(readFileSync(file), file, archiveLimits, compression);
}

function inferredFormat(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".zip") || lower.endsWith(".jar") || lower.endsWith(".aar") || lower.endsWith(".apk")) {
    return "zip";
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".crate")) {
    return "tar.gz";
  }
  if (lower.endsWith(".tar.zst")) return "tar.zst";
  return undefined;
}

export function readPortableArchiveEntries(file, options = {}) {
  const archiveLimits = limits(options);
  requireRegularArchive(file, archiveLimits.maxArchiveBytes);
  const format = options.format ?? inferredFormat(file);
  if (format === "zip") return readZipEntries(file, archiveLimits);
  if (format === "tar.gz") return readTarEntries(file, archiveLimits);
  if (format === "tar.zst") return readTarEntries(file, archiveLimits, "zstd");
  throw archiveError(file, `has an unsupported archive format ${JSON.stringify(format)}`);
}

/**
 * Read a deterministic file-only tar.gz emitted by Oliphaunt's canonical
 * carrier producer. In addition to the portable archive safety contract, this
 * binds the exact gzip header and POSIX ustar byte encoding used by consumers.
 */
export function readCanonicalTarGzipEntries(file, options = {}) {
  const archiveLimits = limits(options);
  requireRegularArchive(file, archiveLimits.maxArchiveBytes);
  const mode = options.fileMode ?? 0o644;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw archiveError(file, "canonical tar.gz fileMode must be an integer between 0000 and 0777");
  }
  const compressed = readFileSync(file);
  const canonicalGzipHeader = Buffer.from([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
  ]);
  if (
    compressed.length < 18
    || !compressed.subarray(0, canonicalGzipHeader.length).equals(canonicalGzipHeader)
  ) {
    throw archiveError(file, "must use the canonical gzip method, flags, mtime, XFL, and OS header");
  }
  const tar = decompressedTarBuffer(compressed, file, archiveLimits, "gzip");
  const entries = parseTarEntries(tar, file, archiveLimits);
  const canonical = canonicalFileTar(entries, file, mode);
  if (!tar.equals(canonical)) {
    throw archiveError(file, "must use the exact deterministic POSIX ustar file encoding");
  }
  return entries;
}

export function readPortableTarZstdBufferEntries(input, options = {}) {
  const archiveLimits = limits(options);
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw archiveError(options.label ?? "nested.tar.zst", "must be provided as a Buffer or Uint8Array");
  }
  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const label = options.label ?? "nested.tar.zst";
  if (buffer.length === 0 || buffer.length > archiveLimits.maxArchiveBytes) {
    throw archiveError(
      label,
      `must be non-empty and no larger than ${archiveLimits.maxArchiveBytes} bytes; got ${buffer.length}`,
    );
  }
  return readTarBufferEntries(buffer, label, archiveLimits, "zstd");
}
