import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ARCHIVE_DIR = path.resolve(import.meta.dir, '../release/archive_dir.mjs');

export function fail(message) {
  console.error(`release-fixture-utils.mjs: ${message}`);
  process.exit(1);
}

export function parseCommonArgs(argv, description) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(`${description}\nusage: --asset-dir <dir> --version <version>`);
    }
    args.set(key, value);
    index += 1;
  }
  const assetDir = args.get('--asset-dir');
  const version = args.get('--version');
  if (!assetDir || !version || args.size !== 2) {
    fail(`${description}\nusage: --asset-dir <dir> --version <version>`);
  }
  return { assetDir: path.resolve(assetDir), version };
}

export async function writeEntriesArchive(output, entries, modes = {}) {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'oliphaunt-release-fixture-'));
  try {
    for (const [name, data] of Object.entries(entries).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const file = path.join(stage, ...name.split('/'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data);
      await fs.chmod(file, modes[name] ?? 0o644);
    }
    await archiveDirectory(stage, output);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function archiveDirectory(source, output) {
  const result = spawnSync(process.execPath, [ARCHIVE_DIR, source, output], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(`failed to create archive ${output}`);
  }
}

export async function writeChecksumManifest(assetDir, name) {
  const checksumAsset = path.join(assetDir, name);
  const dirents = await fs.readdir(assetDir, { withFileTypes: true });
  const files = dirents
    .filter((entry) => entry.isFile() && entry.name !== name)
    .map((entry) => entry.name)
    .sort();
  const lines = [];
  for (const file of files) {
    const digest = createHash('sha256')
      .update(await fs.readFile(path.join(assetDir, file)))
      .digest('hex');
    lines.push(`${digest}  ./${file}`);
  }
  await fs.writeFile(checksumAsset, `${lines.join('\n')}\n`, 'utf8');
}

function packedAppleVersion(major, minor = 0, patch = 0) {
  return (major << 16) | (minor << 8) | patch;
}

export function machoFixture({
  platform = 1,
  minos = [11, 0, 0],
  cpu = 0x0100000c,
  cpuSubtype = 0,
} = {}) {
  const commandSize = 24;
  const buffer = Buffer.alloc(32 + commandSize);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpu, 4);
  buffer.writeUInt32LE(cpuSubtype, 8);
  buffer.writeUInt32LE(6, 12);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(commandSize, 20);
  buffer.writeUInt32LE(0, 24);
  buffer.writeUInt32LE(0, 28);
  buffer.writeUInt32LE(0x32, 32);
  buffer.writeUInt32LE(commandSize, 36);
  buffer.writeUInt32LE(platform, 40);
  buffer.writeUInt32LE(packedAppleVersion(...minos), 44);
  buffer.writeUInt32LE(packedAppleVersion(...minos), 48);
  buffer.writeUInt32LE(0, 52);
  return buffer;
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

export function elfFixture({
  machine = 62,
  requiredVersions = [],
  androidApi = null,
  type = 3,
} = {}) {
  const versionBytes = Buffer.from(`\0${requiredVersions.join('\0')}\0`, 'ascii');
  const note = androidApi === null ? null : Buffer.alloc(24);
  if (note !== null) {
    note.writeUInt32LE(8, 0);
    note.writeUInt32LE(4, 4);
    note.writeUInt32LE(1, 8);
    note.write('Android\0', 12, 'ascii');
    note.writeUInt32LE(androidApi, 20);
  }
  const noteOffset = align(64 + versionBytes.length, 4);
  const sectionOffset = note === null ? 0 : align(noteOffset + note.length, 8);
  const buffer = Buffer.alloc(note === null ? 64 + versionBytes.length : sectionOffset + 128);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(buffer, 0);
  buffer[4] = 2;
  buffer[5] = 1;
  buffer[6] = 1;
  buffer.writeUInt16LE(type, 16);
  buffer.writeUInt16LE(machine, 18);
  buffer.writeUInt32LE(1, 20);
  buffer.writeUInt16LE(64, 52);
  versionBytes.copy(buffer, 64);
  if (note !== null) {
    note.copy(buffer, noteOffset);
    buffer.writeBigUInt64LE(BigInt(sectionOffset), 40);
    buffer.writeUInt16LE(64, 58);
    buffer.writeUInt16LE(2, 60);
    const noteSection = sectionOffset + 64;
    buffer.writeUInt32LE(7, noteSection + 4);
    buffer.writeBigUInt64LE(BigInt(noteOffset), noteSection + 24);
    buffer.writeBigUInt64LE(BigInt(note.length), noteSection + 32);
    buffer.writeBigUInt64LE(4n, noteSection + 48);
  }
  return buffer;
}

export function windowsPeFixture({ machine = 0x8664, imports = [], delayImports = [] } = {}) {
  const peOffset = 0x80;
  const optionalSize = 240;
  const sectionTable = peOffset + 24 + optionalSize;
  const rawOffset = 0x200;
  const rawSize = 0x400;
  const virtualAddress = 0x1000;
  const buffer = Buffer.alloc(rawOffset + rawSize);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write('PE\0\0', peOffset, 'ascii');
  const coff = peOffset + 4;
  buffer.writeUInt16LE(machine, coff);
  buffer.writeUInt16LE(1, coff + 2);
  buffer.writeUInt16LE(optionalSize, coff + 16);
  buffer.writeUInt16LE(0x2022, coff + 18);
  const optional = coff + 20;
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeBigUInt64LE(0x140000000n, optional + 24);
  buffer.writeUInt32LE(rawOffset, optional + 60);
  buffer.writeUInt32LE(16, optional + 108);
  const descriptorBytes = (imports.length + 1) * 20;
  if (imports.length > 0) {
    buffer.writeUInt32LE(virtualAddress, optional + 120);
    buffer.writeUInt32LE(descriptorBytes, optional + 124);
  }
  if (delayImports.length > 0) {
    const delayDescriptorOffset = rawOffset + 0x100;
    buffer.writeUInt32LE(virtualAddress + delayDescriptorOffset - rawOffset, optional + 216);
    buffer.writeUInt32LE((delayImports.length + 1) * 32, optional + 220);
  }
  buffer.write('.rdata\0\0', sectionTable, 'ascii');
  buffer.writeUInt32LE(rawSize, sectionTable + 8);
  buffer.writeUInt32LE(virtualAddress, sectionTable + 12);
  buffer.writeUInt32LE(rawSize, sectionTable + 16);
  buffer.writeUInt32LE(rawOffset, sectionTable + 20);
  let nameOffset = rawOffset + 0x200;
  for (let index = 0; index < imports.length; index += 1) {
    const descriptor = rawOffset + index * 20;
    buffer.writeUInt32LE(virtualAddress + nameOffset - rawOffset, descriptor + 12);
    buffer.write(`${imports[index]}\0`, nameOffset, 'ascii');
    nameOffset += Buffer.byteLength(imports[index]) + 1;
  }
  for (let index = 0; index < delayImports.length; index += 1) {
    const descriptor = rawOffset + 0x100 + index * 32;
    buffer.writeUInt32LE(1, descriptor);
    buffer.writeUInt32LE(virtualAddress + nameOffset - rawOffset, descriptor + 4);
    buffer.write(`${delayImports[index]}\0`, nameOffset, 'ascii');
    nameOffset += Buffer.byteLength(delayImports[index]) + 1;
  }
  return buffer;
}

function coffArchiveMember(rawName, data) {
  if (!Buffer.isBuffer(data)) {
    throw new TypeError('COFF archive fixture member data must be a Buffer');
  }
  if (!rawName || Buffer.byteLength(rawName, 'ascii') > 16) {
    throw new Error(`invalid COFF archive fixture member name ${JSON.stringify(rawName)}`);
  }
  const header = Buffer.from(
    `${rawName.padEnd(16, ' ')}${'0'.padEnd(12, ' ')}${'0'.padEnd(6, ' ')}${'0'.padEnd(6, ' ')}${'100644'.padEnd(8, ' ')}${String(data.length).padEnd(10, ' ')}\`\n`,
    'ascii',
  );
  return Buffer.concat([
    header,
    data,
    ...(data.length % 2 === 0 ? [] : [Buffer.from('\n', 'ascii')]),
  ]);
}

function coffObjectFixture(machine, symbol) {
  const symbolBytes = Buffer.from(`${symbol}\0`, 'ascii');
  const symbolTable = 20 + 40;
  const stringTable = symbolTable + 18;
  const buffer = Buffer.alloc(stringTable + 4 + symbolBytes.length);
  buffer.writeUInt16LE(machine, 0);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt32LE(symbolTable, 8);
  buffer.writeUInt32LE(1, 12);
  buffer.writeUInt16LE(0, 16);
  buffer.write('.drectve', 20, 'ascii');
  buffer.writeUInt32LE(0, symbolTable);
  buffer.writeUInt32LE(4, symbolTable + 4);
  buffer.writeInt16LE(1, symbolTable + 12);
  buffer.writeUInt8(2, symbolTable + 16);
  buffer.writeUInt32LE(4 + symbolBytes.length, stringTable);
  symbolBytes.copy(buffer, stringTable + 4);
  return buffer;
}

function coffImportObjectFixture({ dllName, machine, symbol }) {
  const strings = Buffer.from(`${symbol}\0${dllName}\0`, 'ascii');
  const buffer = Buffer.alloc(20 + strings.length);
  buffer.writeUInt16LE(0, 0);
  buffer.writeUInt16LE(0xffff, 2);
  buffer.writeUInt16LE(0, 4);
  buffer.writeUInt16LE(machine, 6);
  buffer.writeUInt32LE(strings.length, 12);
  buffer.writeUInt16LE(1 << 2, 18);
  strings.copy(buffer, 20);
  return buffer;
}

function nullTerminatedAscii(values) {
  return Buffer.from(`${values.join('\0')}\0`, 'ascii');
}

export function windowsImportLibraryFixture({
  dllName = 'oliphaunt.dll',
  importMachine = 0x8664,
  objectMachine = 0x8664,
  symbol,
  importSymbols = symbol === undefined ? ['oliphaunt_init', 'oliphaunt_init_ex'] : [symbol],
} = {}) {
  if (!Array.isArray(importSymbols) || importSymbols.length === 0) {
    throw new Error('Windows import-library fixture requires at least one import symbol');
  }
  const descriptorSymbol = '__IMPORT_DESCRIPTOR_oliphaunt';
  const symbols = [descriptorSymbol, ...importSymbols];
  const firstNames = nullTerminatedAscii(symbols);
  const secondNames = nullTerminatedAscii(symbols);
  const firstSize = 4 + symbols.length * 4 + firstNames.length;
  const memberCount = 1 + importSymbols.length;
  const secondSize = 4 + memberCount * 4 + 4 + symbols.length * 2 + secondNames.length;
  const paddedMemberSize = (size) => 60 + size + (size % 2);
  const firstOffset = 8;
  const secondOffset = firstOffset + paddedMemberSize(firstSize);
  const descriptorOffset = secondOffset + paddedMemberSize(secondSize);
  const descriptor = coffObjectFixture(objectMachine, descriptorSymbol);
  const memberOffsets = [descriptorOffset];
  let nextOffset = descriptorOffset + paddedMemberSize(descriptor.length);
  const importObjects = importSymbols.map((importSymbol) => {
    const object = coffImportObjectFixture({
      dllName,
      machine: importMachine,
      symbol: importSymbol,
    });
    memberOffsets.push(nextOffset);
    nextOffset += paddedMemberSize(object.length);
    return object;
  });

  const first = Buffer.alloc(firstSize);
  first.writeUInt32BE(symbols.length, 0);
  for (let index = 0; index < memberOffsets.length; index += 1) {
    first.writeUInt32BE(memberOffsets[index], 4 + index * 4);
  }
  firstNames.copy(first, 4 + memberOffsets.length * 4);

  const second = Buffer.alloc(secondSize);
  second.writeUInt32LE(memberCount, 0);
  for (let index = 0; index < memberOffsets.length; index += 1) {
    second.writeUInt32LE(memberOffsets[index], 4 + index * 4);
  }
  const symbolCountOffset = 4 + memberCount * 4;
  second.writeUInt32LE(symbols.length, symbolCountOffset);
  for (let index = 0; index < symbols.length; index += 1) {
    second.writeUInt16LE(index + 1, symbolCountOffset + 4 + index * 2);
  }
  secondNames.copy(second, symbolCountOffset + 4 + symbols.length * 2);

  return Buffer.concat([
    Buffer.from('!<arch>\n', 'ascii'),
    coffArchiveMember('/', first),
    coffArchiveMember('/', second),
    coffArchiveMember('descr.obj/', descriptor),
    ...importObjects.map((object, index) => coffArchiveMember(`import${index}.obj/`, object)),
  ]);
}
