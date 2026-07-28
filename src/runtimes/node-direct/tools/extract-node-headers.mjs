#!/usr/bin/env node

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {gunzipSync} from 'node:zlib';

const BLOCK_SIZE = 512;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const REQUIRED_HEADERS = [
  'include/node/node_api.h',
  'include/node/node.h',
  'include/node/v8.h',
];

function fail(message) {
  throw new Error(message);
}

function fieldString(block, start, length, label) {
  const field = block.subarray(start, start + length);
  const nul = field.indexOf(0);
  const used = nul === -1 ? field : field.subarray(0, nul);
  if (nul !== -1 && field.subarray(nul).some((byte) => byte !== 0)) {
    fail(`tar ${label} contains bytes after its NUL terminator`);
  }
  if (used.some((byte) => byte < 0x20 || byte > 0x7e)) {
    fail(`tar ${label} must contain printable ASCII only`);
  }
  return used.toString('ascii');
}

function octalField(block, start, length, label) {
  const field = block.subarray(start, start + length);
  if ((field[0] ?? 0) >= 0x80) {
    fail(`tar ${label} uses unsupported base-256 encoding`);
  }
  const text = field.toString('ascii').replaceAll('\0', '').trim();
  if (text === '') {
    return 0;
  }
  if (!/^[0-7]+$/u.test(text)) {
    fail(`tar ${label} is not an octal value`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`tar ${label} exceeds the supported integer range`);
  }
  return value;
}

function verifyHeaderChecksum(block) {
  const expected = octalField(block, 148, 8, 'checksum');
  let actual = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (actual !== expected) {
    fail(`tar header checksum mismatch: expected ${expected}, received ${actual}`);
  }
}

function archivePath(block) {
  const name = fieldString(block, 0, 100, 'name');
  const prefix = fieldString(block, 345, 155, 'prefix');
  return prefix === '' ? name : `${prefix}/${name}`;
}

function safeRelativePath(rawPath, expectedRoot, type) {
  if (rawPath === '' || rawPath.includes('\\') || rawPath.startsWith('/')) {
    fail(`unsafe tar path: ${rawPath || '<empty>'}`);
  }
  if (/^[A-Za-z]:/u.test(rawPath) || /[\u0000-\u001f\u007f]/u.test(rawPath)) {
    fail(`unsafe tar path: ${rawPath}`);
  }

  const withoutTrailingSlash = type === 'directory' && rawPath.endsWith('/')
    ? rawPath.slice(0, -1)
    : rawPath;
  if (withoutTrailingSlash === '' || withoutTrailingSlash.endsWith('/')) {
    fail(`unsafe tar path: ${rawPath}`);
  }

  const parts = withoutTrailingSlash.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`unsafe tar path: ${rawPath}`);
  }
  if (parts[0] !== expectedRoot) {
    fail(`tar entry is outside the expected ${expectedRoot}/ root: ${rawPath}`);
  }

  const relativeParts = parts.slice(1);
  if (relativeParts.length === 0 && type !== 'directory') {
    fail(`tar root entry must be a directory: ${rawPath}`);
  }
  for (const part of relativeParts) {
    if (part.endsWith('.') || part.endsWith(' ') || part.includes(':')) {
      fail(`tar path is not portable across release hosts: ${rawPath}`);
    }
  }
  return relativeParts.join('/');
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function parseArchive(expanded, expectedRoot) {
  const entries = [];
  const paths = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  let expandedFileBytes = 0;
  let pendingLongName = null;

  while (offset + BLOCK_SIZE <= expanded.length) {
    const block = expanded.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (isZeroBlock(block)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) {
        if (!expanded.subarray(offset).every((byte) => byte === 0)) {
          fail('tar archive contains data after its end marker');
        }
        break;
      }
      continue;
    }
    if (zeroBlocks !== 0) {
      fail('tar archive contains an isolated zero block');
    }

    verifyHeaderChecksum(block);
    const typeFlag = block[156];
    const size = octalField(block, 124, 12, 'size');
    if (size > MAX_FILE_BYTES) {
      fail(`tar entry exceeds the ${MAX_FILE_BYTES}-byte per-file limit`);
    }
    if (offset + size > expanded.length) {
      fail('tar entry payload is truncated');
    }
    const data = expanded.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (typeFlag === 0x4c) {
      if (pendingLongName !== null) {
        fail('tar archive contains consecutive GNU long-name records');
      }
      if (archivePath(block) !== '././@LongLink' || size < 2 || size > 4096 || data.at(-1) !== 0) {
        fail('tar archive contains an invalid GNU long-name record');
      }
      const nameBytes = data.subarray(0, -1);
      if (nameBytes.includes(0) || nameBytes.some((byte) => byte < 0x20 || byte > 0x7e)) {
        fail('tar GNU long-name record must contain printable ASCII and one trailing NUL');
      }
      pendingLongName = nameBytes.toString('ascii');
      continue;
    }

    const type = typeFlag === 0 || typeFlag === 0x30
      ? 'file'
      : typeFlag === 0x35
        ? 'directory'
        : null;
    if (type === null) {
      const printableType = typeFlag >= 0x20 && typeFlag <= 0x7e
        ? String.fromCharCode(typeFlag)
        : `0x${typeFlag.toString(16).padStart(2, '0')}`;
      fail(`tar entry type ${printableType} is not a regular file or directory`);
    }

    if (type === 'directory' && size !== 0) {
      fail('tar directory entry must have size zero');
    }
    expandedFileBytes += size;
    if (expandedFileBytes > MAX_EXPANDED_BYTES) {
      fail(`tar file payloads exceed the ${MAX_EXPANDED_BYTES}-byte total limit`);
    }

    const relativePath = safeRelativePath(pendingLongName ?? archivePath(block), expectedRoot, type);
    pendingLongName = null;
    const collisionKey = relativePath.toLowerCase();
    if (paths.has(collisionKey)) {
      fail(`tar archive contains a duplicate or case-colliding path: ${relativePath || expectedRoot}`);
    }
    paths.set(collisionKey, type);

    if (entries.length >= MAX_ENTRIES) {
      fail(`tar archive exceeds the ${MAX_ENTRIES}-entry limit`);
    }
    entries.push({data, relativePath, size, type});
  }

  if (zeroBlocks < 2) {
    fail('tar archive is missing its two-block end marker');
  }
  if (pendingLongName !== null) {
    fail('tar archive ends with an unapplied GNU long-name record');
  }

  for (const entry of entries) {
    const parts = entry.relativePath === '' ? [] : entry.relativePath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/').toLowerCase();
      if (paths.get(parent) === 'file') {
        fail(`tar path has a regular-file parent: ${entry.relativePath}`);
      }
    }
  }

  for (const required of REQUIRED_HEADERS) {
    const entry = entries.find((candidate) => candidate.relativePath === required);
    if (entry === undefined || entry.type !== 'file' || entry.size === 0) {
      fail(`Node headers archive is missing non-empty ${required}`);
    }
  }
  return entries;
}

function extract(entries, destination) {
  const destinationRoot = path.resolve(destination);
  mkdirSync(destinationRoot, {recursive: true, mode: 0o755});
  if (readdirSync(destinationRoot).length !== 0) {
    fail(`Node headers extraction destination is not empty: ${destinationRoot}`);
  }

  const targetPath = (relativePath) => {
    const target = path.resolve(destinationRoot, ...relativePath.split('/'));
    if (target !== destinationRoot && !target.startsWith(`${destinationRoot}${path.sep}`)) {
      fail(`resolved tar path escapes extraction root: ${relativePath}`);
    }
    return target;
  };

  for (const entry of entries.filter((candidate) => candidate.type === 'directory')) {
    if (entry.relativePath !== '') {
      mkdirSync(targetPath(entry.relativePath), {recursive: true, mode: 0o755});
    }
  }
  for (const entry of entries.filter((candidate) => candidate.type === 'file')) {
    const target = targetPath(entry.relativePath);
    mkdirSync(path.dirname(target), {recursive: true, mode: 0o755});
    writeFileSync(target, entry.data, {flag: 'wx', mode: 0o644});
  }
}

function main() {
  const [archive, destination, expectedRoot] = process.argv.slice(2);
  if (archive === undefined || destination === undefined || expectedRoot === undefined || process.argv.length !== 5) {
    fail('usage: extract-node-headers.mjs <archive.tar.gz> <empty-destination> <expected-root>');
  }
  if (!/^node-v[0-9]+\.[0-9]+\.[0-9]+$/u.test(expectedRoot)) {
    fail(`invalid expected Node headers root: ${expectedRoot}`);
  }
  const archiveSize = statSync(archive).size;
  if (archiveSize <= 0 || archiveSize > MAX_ARCHIVE_BYTES) {
    fail(`Node headers archive size must be between 1 and ${MAX_ARCHIVE_BYTES} bytes`);
  }
  const compressed = readFileSync(archive);
  let expanded;
  try {
    expanded = gunzipSync(compressed, {maxOutputLength: MAX_EXPANDED_BYTES});
  } catch (error) {
    fail(`could not decompress bounded Node headers archive: ${error.message}`);
  }
  extract(parseArchive(expanded, expectedRoot), destination);
}

try {
  main();
} catch (error) {
  console.error(`Node headers extraction failed: ${error.message}`);
  process.exit(1);
}
