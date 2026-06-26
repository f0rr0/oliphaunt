#!/usr/bin/env bun
import { deflateRawSync, gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';

function fail(message) {
  console.error(`archive_dir.mjs: ${message}`);
  process.exit(2);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedMode(stat, isDirectory) {
  if (isDirectory) {
    return 0o755;
  }
  return stat.mode & 0o100 ? 0o755 : 0o644;
}

function posixRelative(root, item) {
  const relative = path.relative(root, item).split(path.sep).join('/');
  return relative === '' ? '.' : relative;
}

async function archiveEntries(root) {
  const entries = [{ fullPath: root, name: '.', isDirectory: true }];

  async function walk(directory) {
    const dirents = await fs.readdir(directory, { withFileTypes: true });
    const directories = [];
    const files = [];
    for (const entry of dirents) {
      const fullPath = path.join(directory, entry.name);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        directories.push({ entry, fullPath, recurse: !entry.isSymbolicLink() });
      } else if (stat.isFile()) {
        files.push({ entry, fullPath });
      }
    }
    directories.sort((left, right) => compareText(left.entry.name, right.entry.name));
    files.sort((left, right) => compareText(left.entry.name, right.entry.name));
    for (const entry of directories) {
      entries.push({ fullPath: entry.fullPath, name: posixRelative(root, entry.fullPath), isDirectory: true });
    }
    for (const entry of files) {
      entries.push({ fullPath: entry.fullPath, name: posixRelative(root, entry.fullPath), isDirectory: false });
    }
    for (const entry of directories) {
      if (entry.recurse) {
        await walk(entry.fullPath);
      }
    }
  }

  await walk(root);
  return entries;
}

function tarPathParts(relativePath) {
  if (Buffer.byteLength(relativePath) <= 100) {
    return { name: relativePath, prefix: '' };
  }
  const parts = relativePath.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  fail(`archive path is too long for ustar: ${relativePath}`);
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) {
    fail(`tar header field overflow for '${value}'`);
  }
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8);
  if (text.length > length - 1) {
    fail(`tar header octal field overflow for '${value}'`);
  }
  writeString(buffer, offset, length, `${text.padStart(length - 1, '0')}\0`);
}

function tarHeader(entry, size, mode) {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = tarPathParts(entry.name);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, entry.isDirectory ? '5' : '0');
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const checksumText = checksum.toString(8);
  if (checksumText.length > 6) {
    fail(`tar header checksum overflow for ${entry.name}`);
  }
  writeString(header, 148, 8, `${checksumText.padStart(6, '0')}\0 `);
  return header;
}

async function createTar(root) {
  const chunks = [];
  for (const entry of await archiveEntries(root)) {
    const stat = await fs.stat(entry.fullPath);
    const mode = normalizedMode(stat, entry.isDirectory);
    const data = entry.isDirectory ? Buffer.alloc(0) : await fs.readFile(entry.fullPath);
    chunks.push(tarHeader(entry, data.length, mode));
    if (data.length > 0) {
      chunks.push(data);
      const remainder = data.length % 512;
      if (remainder !== 0) {
        chunks.push(Buffer.alloc(512 - remainder, 0));
      }
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime() {
  return {
    time: 0,
    date: ((1980 - 1980) << 9) | (1 << 5) | 1,
  };
}

function writeUInt16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function writeUInt32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function zipName(entry) {
  return entry.isDirectory && entry.name !== '.' ? `${entry.name}/` : entry.name;
}

async function createZip(root) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  const { time, date } = dosDateTime();

  for (const entry of await archiveEntries(root)) {
    const stat = await fs.stat(entry.fullPath);
    const mode = normalizedMode(stat, entry.isDirectory);
    const name = Buffer.from(zipName(entry));
    const data = entry.isDirectory ? Buffer.alloc(0) : await fs.readFile(entry.fullPath);
    const compressed = entry.isDirectory ? Buffer.alloc(0) : deflateRawSync(data, { level: 9 });
    const method = entry.isDirectory ? 0 : 8;
    const crc = crc32(data);
    const externalAttributes = ((mode & 0o777) << 16) | (entry.isDirectory ? 0x10 : 0);
    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0),
      writeUInt16(method),
      writeUInt16(time),
      writeUInt16(date),
      writeUInt32(crc),
      writeUInt32(compressed.length),
      writeUInt32(data.length),
      writeUInt16(name.length),
      writeUInt16(0),
      name,
    ]);
    localChunks.push(localHeader, compressed);
    centralChunks.push(
      Buffer.concat([
        writeUInt32(0x02014b50),
        writeUInt16((3 << 8) | 20),
        writeUInt16(20),
        writeUInt16(0),
        writeUInt16(method),
        writeUInt16(time),
        writeUInt16(date),
        writeUInt32(crc),
        writeUInt32(compressed.length),
        writeUInt32(data.length),
        writeUInt16(name.length),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt32(externalAttributes),
        writeUInt32(offset),
        name,
      ]),
    );
    offset += localHeader.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(centralChunks.length),
    writeUInt16(centralChunks.length),
    writeUInt32(centralDirectory.length),
    writeUInt32(offset),
    writeUInt16(0),
  ]);
  return Buffer.concat([...localChunks, centralDirectory, end]);
}

function parseArgs(argv) {
  if (argv.length !== 2) {
    fail('usage: tools/release/archive_dir.mjs <source-dir> <output.tar.gz|output.zip>');
  }
  return {
    source: path.resolve(argv[0]),
    output: path.resolve(argv[1]),
  };
}

const { source, output } = parseArgs(Bun.argv.slice(2));
const sourceStat = await fs.stat(source).catch(() => null);
if (!sourceStat?.isDirectory()) {
  fail(`source is not a directory: ${source}`);
}
await fs.mkdir(path.dirname(output), { recursive: true });
if (output.endsWith('.tar.gz')) {
  await fs.writeFile(output, gzipSync(await createTar(source), { mtime: 0 }));
} else if (path.extname(output) === '.zip') {
  await fs.writeFile(output, await createZip(source));
} else {
  fail(`unsupported archive extension: ${output}`);
}
