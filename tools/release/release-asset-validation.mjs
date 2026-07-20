import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";

export async function assertFileExists(file) {
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() === true;
}

export async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

export async function checksumManifest(file, fail, prefix) {
  const values = new Map();
  const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/u);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/u);
    if (parts.length < 2 || parts[0].length !== 64) {
      fail(prefix, `malformed checksum line ${index + 1}: ${rawLine}`);
    }
    values.set(parts.slice(1).join(" ").replace(/^\.\//u, ""), parts[0].toLowerCase());
  }
  return values;
}

function parseTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer
    .subarray(start, end >= start && end < start + length ? end : start + length)
    .toString("utf8")
    .trim();
}

function parseTarOctal(buffer, start, length) {
  const text = parseTarString(buffer, start, length).replace(/\0/g, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

async function readTarGzEntries(file) {
  const buffer = gunzipSync(await fs.readFile(file));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const mode = parseTarOctal(header, 100, 8);
    const size = parseTarOctal(header, 124, 12);
    const type = header.subarray(156, 157).toString("utf8");
    const dataOffset = offset + 512;
    if (dataOffset + size > buffer.length) {
      throw new Error(`${file} contains a truncated tar member ${fullName}`);
    }
    entries.set(fullName, {
      mode,
      size,
      isFile: type === "" || type === "0",
      isDirectory: type === "5",
      isSymbolicLink: type === "1" || type === "2",
      data: () => buffer.subarray(dataOffset, dataOffset + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer, fail, prefix) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  fail(prefix, "zip archive is missing end of central directory");
}

async function readZipEntries(file, fail, prefix) {
  const buffer = await fs.readFile(file);
  const eocd = findEndOfCentralDirectory(buffer, fail, prefix);
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      fail(prefix, `${path.basename(file)} has an invalid zip central directory`);
    }
    const size = buffer.readUInt32LE(offset + 24);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const mode = externalAttributes >>> 16;
    const unixType = mode & 0o170000;
    const isSymbolicLink = unixType === 0o120000;
    const isDirectory =
      name.endsWith("/") || (externalAttributes & 0x10) !== 0 || unixType === 0o040000;
    const localOffset = buffer.readUInt32LE(offset + 42);
    entries.set(name, {
      mode,
      size,
      isFile: !isDirectory && !isSymbolicLink && (unixType === 0 || unixType === 0o100000),
      isDirectory,
      isSymbolicLink,
      data: () => zipEntryData(buffer, localOffset, compressedSize, size, method, fail, prefix, name),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipEntryData(buffer, offset, compressedSize, size, method, fail, prefix, name) {
  if (offset > buffer.length - 30 || buffer.readUInt32LE(offset) !== 0x04034b50) {
    fail(prefix, `${name} has an invalid zip local file header`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  if (dataStart > buffer.length || compressedSize > buffer.length - dataStart) {
    fail(prefix, `${name} has truncated zip data`);
  }
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  let data;
  if (method === 0) {
    data = compressed;
  } else if (method === 8) {
    try {
      data = inflateRawSync(compressed);
    } catch (error) {
      fail(prefix, `${name} has invalid deflate data: ${error.message}`);
    }
  } else {
    fail(prefix, `${name} uses unsupported zip compression method ${method}`);
  }
  if (data.length !== size) {
    fail(prefix, `${name} zip size ${data.length} does not match declared size ${size}`);
  }
  return data;
}

export async function readArchiveEntries(file, fail, prefix, productLabel) {
  if (file.endsWith(".tar.gz")) {
    return readTarGzEntries(file);
  }
  if (path.extname(file) === ".zip") {
    return readZipEntries(file, fail, prefix);
  }
  fail(prefix, `${path.basename(file)} has unsupported ${productLabel} archive extension`);
}
