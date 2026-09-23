import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { deflateRawSync } from 'node:zlib';

let crcTable;
export function crc32(buffer) {
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

export function zipArchive(rows, { beforeCentral = Buffer.alloc(0) } = {}) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const row of rows) {
    const name = Buffer.from(row.localName ?? row.name, 'utf8');
    const centralName = Buffer.from(row.name, 'utf8');
    const data = Buffer.from(row.data ?? 'payload');
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
      descriptor = Buffer.alloc(row.descriptor === 'signed' ? 16 : 12);
      let descriptorOffset = 0;
      if (row.descriptor === 'signed') {
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
    central.writeUInt32LE((row.externalAttributes ?? 0o100644 << 16) >>> 0, 38);
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

export async function maliciousZip(archive: string, name: string, kind: string) {
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(
    archive,
    zipArchive([
      {
        name,
        data: kind === 'symlink' ? '../outside' : 'malicious',
        externalAttributes: (kind === 'symlink' ? 0o120777 : 0o100644) << 16,
      },
    ]),
  );
}
export async function fixtureFiles(root: string) {
  if (!root) return [];
  const rows: { name: string; data: Buffer }[] = [];
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, name);
    if ((await stat(path)).isFile())
      rows.push({ name: name.replaceAll('\\', '/'), data: await readFile(path) });
  }
  return rows;
}
export async function metadataZip(archive: string, creator: string, legalRoot = '') {
  await mkdir(dirname(archive), { recursive: true });
  const unix = creator !== 'fat',
    ambiguous = creator === 'ambiguous-unix';
  const directory = (name: string, ambiguous = false) => ({
    name,
    data: '',
    versionMadeBy: unix ? 0x0314 : 0x0014,
    externalAttributes: unix ? ((ambiguous ? 0o755 : 0o40755) << 16) | 0x10 : 0x10,
  });
  const file = (name: string, data: string | Buffer, ambiguous = false) => ({
    name,
    data,
    versionMadeBy: unix ? 0x0314 : 0x0014,
    externalAttributes: unix ? ((ambiguous ? 0o644 : 0o100644) << 16) | 0x20 : 0x20,
  });
  const extra =
    creator === 'unicode-extra' ? Buffer.from('757005000100000000', 'hex') : Buffer.alloc(0);
  const rows = [
    directory('liboliphaunt.xcframework/', ambiguous),
    {
      ...file('liboliphaunt.xcframework/Info.plist', '<plist><dict/></plist>\n', ambiguous),
      localExtra: extra,
      centralExtra: extra,
    },
  ];
  const legal = (await fixtureFiles(legalRoot)).filter((row) => row.name !== 'Info.plist');
  const parents = new Set<string>();
  for (const { name } of legal)
    for (let parent = posix.dirname(name); parent !== '.'; parent = posix.dirname(parent))
      parents.add(parent);
  rows.push(...[...parents].sort().map((name) => directory(`liboliphaunt.xcframework/${name}/`)));
  rows.push(...legal.map(({ name, data }) => file(`liboliphaunt.xcframework/${name}`, data)));
  await writeFile(archive, zipArchive(rows));
}
