#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  ARCHIVE_NAME,
  BUILD_REPORT_NAME,
  MANIFEST_NAME,
  TRANSPORT_SCHEMA,
  validateIosAppZipArchive,
} from './ios-app-transport.mts';

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('hex');
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function createApp(
  directory,
  {
    appName = 'Fixture.app',
    executable = 'Fixture',
    executableMode = 0o755,
    includeSymlink = true,
  } = {},
) {
  const app = path.join(directory, appName);
  const resources = path.join(app, 'Resources');
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(
    path.join(app, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleExecutable</key>',
      `  <string>${xml(executable)}</string>`,
      '  <key>CFBundleIdentifier</key>',
      '  <string>dev.oliphaunt.transport-fixture</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  );
  const executableFile = path.join(app, executable);
  await fs.writeFile(executableFile, '#!/bin/sh\nexit 0\n');
  await fs.chmod(executableFile, executableMode);
  await fs.writeFile(path.join(resources, 'Payload.txt'), 'payload\n');
  if (includeSymlink) {
    await fs.symlink('Payload.txt', path.join(resources, 'Payload.link'));
  }
  return { app, appName, executable, executableFile, resources };
}

async function createBuildReport(appDirectory, fixture) {
  const report = path.join(appDirectory, BUILD_REPORT_NAME);
  await writeJson(report, {
    schema: 'oliphaunt-react-native-mobile-build-v1',
    platform: 'ios',
    configuration: 'Release',
    sdk: 'iphonesimulator',
    appArtifact: fixture.app,
    appArtifactBytes: 12345,
    reactNativePackage: '/tmp/oliphaunt-react-native.tgz',
    reactNativePackageBytes: 456,
    selectedExtensions: ['vector'],
    scratchRoot: '/tmp/ios-build',
  });
  return report;
}

async function fixtureRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `oliphaunt-ios-transport-${label}-`));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}

async function manifest(transport) {
  return JSON.parse(await fs.readFile(path.join(transport, MANIFEST_NAME), 'utf8'));
}

async function rewriteArchiveBinding(transport) {
  const archive = path.join(transport, ARCHIVE_NAME);
  const data = await manifest(transport);
  const stat = await fs.stat(archive);
  data.archive.bytes = stat.size;
  data.archive.sha256 = await sha256(archive);
  await writeJson(path.join(transport, MANIFEST_NAME), data);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function writeStoredZip(archive, entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const entry of entries) {
    const centralName = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const mode = entry.mode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644);
    const checksum = crc32(data);
    const flags = 0x0800 | (entry.dataDescriptor ? 0x0008 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.localCrc ?? (entry.dataDescriptor ? 0 : checksum), 14);
    local.writeUInt32LE(
      entry.localCompressedSize ?? (entry.dataDescriptor ? 0 : compressed.length),
      18,
    );
    local.writeUInt32LE(
      entry.localUncompressedSize ?? (entry.dataDescriptor ? 0 : data.length),
      22,
    );
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(0, 28);
    let descriptor = Buffer.alloc(0);
    if (entry.dataDescriptor) {
      const signatureBytes = entry.descriptorSignature === false ? 0 : 4;
      descriptor = Buffer.alloc(12 + signatureBytes);
      let cursor = 0;
      if (signatureBytes > 0) {
        descriptor.writeUInt32LE(0x08074b50, cursor);
        cursor += 4;
      }
      descriptor.writeUInt32LE(entry.descriptorCrc ?? checksum, cursor);
      descriptor.writeUInt32LE(compressed.length, cursor + 4);
      descriptor.writeUInt32LE(data.length, cursor + 8);
    }
    const gap = Buffer.isBuffer(entry.gap) ? entry.gap : Buffer.from(entry.gap ?? '', 'utf8');
    localRecords.push(local, localName, compressed, descriptor, gap);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(centralName.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(central, centralName);
    localOffset +=
      local.length + localName.length + compressed.length + descriptor.length + gap.length;
  }

  const central = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  await fs.writeFile(archive, Buffer.concat([...localRecords, central, eocd]));
}

const [mode, root, variant] = process.argv.slice(2);
if (mode) {
  const appDirectory = path.join(root, 'app');
  const transport = path.join(root, 'transport');
  const output = path.join(root, 'output');
  switch (mode) {
    case 'prepare': {
      const fixture = await createApp(appDirectory, {
        executableMode: variant === 'nonexec' ? 0o644 : 0o755,
      });
      await createBuildReport(appDirectory, fixture);
      if (variant === 'multiple')
        await createApp(appDirectory, { appName: 'Second.app', executable: 'Second' });
      if (variant === 'case') {
        await fs.writeFile(path.join(fixture.resources, 'Case.txt'), 'upper\n');
        await fs.writeFile(path.join(fixture.resources, 'case.txt'), 'lower\n');
        const names = new Set(await fs.readdir(fixture.resources));
        if (!names.has('Case.txt') || !names.has('case.txt')) process.exit(77);
      }
      break;
    }
    case 'check-roundtrip': {
      const first = await manifest(transport);
      assert.equal(first.schema, TRANSPORT_SCHEMA);
      assert.deepEqual(first, await manifest(path.join(root, 'second')));
      assert.equal(
        await sha256(path.join(transport, ARCHIVE_NAME)),
        await sha256(path.join(root, 'second', ARCHIVE_NAME)),
      );
      assert.equal(first.buildReport.configuration, 'Release');
      assert.equal(first.buildReport.sdk, 'iphonesimulator');
      assert.equal(await sha256(path.join(transport, BUILD_REPORT_NAME)), first.buildReport.sha256);
      assert.equal(await sha256(path.join(output, BUILD_REPORT_NAME)), first.buildReport.sha256);
      await fs.access(path.join(output, 'Fixture.app', 'Fixture'), fs.constants.X_OK);
      const link = path.join(output, 'Fixture.app', 'Resources', 'Payload.link');
      assert((await fs.lstat(link)).isSymbolicLink());
      assert.equal(await fs.readlink(link), 'Payload.txt');
      assert.equal(
        await fs.readFile(path.join(output, 'Fixture.app', 'Resources', 'Payload.txt'), 'utf8'),
        'payload\n',
      );
      break;
    }
    case 'stale':
      await fs.mkdir(transport, { recursive: true });
      for (const name of [
        '.' + ARCHIVE_NAME + '.999999.tmp.zip',
        '.' + ARCHIVE_NAME + '.999999.01234567-89ab-cdef-0123-456789abcdef.tmp.zip',
        MANIFEST_NAME + '.999999.tmp',
        '.' + MANIFEST_NAME + '.999999.01234567-89ab-cdef-0123-456789abcdef.tmp',
      ])
        await fs.writeFile(path.join(transport, name), 'stale\n');
      break;
    case 'check-clean':
      assert.deepEqual(
        (await fs.readdir(transport)).sort(),
        [ARCHIVE_NAME, BUILD_REPORT_NAME, MANIFEST_NAME].sort(),
      );
      break;
    case 'check-case':
      assert.equal(
        await fs.readFile(path.join(output, 'Fixture.app', 'Resources', 'Case.txt'), 'utf8'),
        'upper\n',
      );
      assert.equal(
        await fs.readFile(path.join(output, 'Fixture.app', 'Resources', 'case.txt'), 'utf8'),
        'lower\n',
      );
      break;
    case 'tamper-archive':
      await fs.appendFile(path.join(transport, ARCHIVE_NAME), 'tamper');
      break;
    case 'tamper-report':
      await fs.appendFile(path.join(transport, BUILD_REPORT_NAME), ' \n');
      break;
    case 'traversal':
      await writeStoredZip(path.join(transport, ARCHIVE_NAME), [
        { name: 'Fixture.app/' },
        { name: '../escaped.txt', data: 'must never be extracted\n' },
      ]);
      await rewriteArchiveBinding(transport);
      break;
    case 'mutate-payload':
      if (variant === 'unrelated')
        await fs.writeFile(path.join(root, 'payload', 'unrelated.txt'), 'unrelated\n');
      else if (variant === 'multiple')
        await createApp(path.join(root, 'payload'), {
          appName: 'Second.app',
          executable: 'Second',
        });
      else if (variant === 'nonexec')
        await fs.chmod(path.join(root, 'payload', 'Fixture.app', 'Fixture'), 0o644);
      else throw Error('unknown payload mutation');
      break;
    case 'rebind':
      await rewriteArchiveBinding(transport);
      break;
    default:
      throw Error('unknown transport test mode: ' + mode);
  }
  process.exit(0);
}

test('pre-extraction ZIP validation accepts contained regular, directory, and symlink entries', async (t) => {
  const root = await fixtureRoot(t, 'zip-valid');
  const archive = path.join(root, 'valid.zip');
  await writeStoredZip(archive, [
    { name: 'Fixture.app/' },
    { name: 'Fixture.app/Resources/' },
    {
      data: 'payload\n',
      dataDescriptor: true,
      name: 'Fixture.app/Resources/Payload.txt',
    },
    {
      data: 'unsigned descriptor\n',
      dataDescriptor: true,
      descriptorSignature: false,
      name: 'Fixture.app/Resources/Unsigned.txt',
    },
    {
      data: 'Resources/Payload.txt',
      method: 8,
      mode: 0o120777,
      name: 'Fixture.app/Payload.link',
    },
  ]);
  assert.deepEqual(await validateIosAppZipArchive(archive, 'Fixture.app'), {
    entries: 5,
    zip64: false,
  });
});

test('pre-extraction ZIP validation rejects traversal, absolute, and unrelated paths', async (t) => {
  const root = await fixtureRoot(t, 'zip-paths');
  for (const [label, name, pattern] of [
    ['parent', '../escaped.txt', /unsafe member path/u],
    ['nested-parent', 'Fixture.app/../../escaped.txt', /unsafe member path/u],
    ['absolute', '/escaped.txt', /unsafe member path/u],
    ['backslash', 'Fixture.app\\escaped.txt', /unsafe member path/u],
    ['unrelated', 'Other.app/Payload.txt', /outside Fixture\.app/u],
  ]) {
    const archive = path.join(root, `${label}.zip`);
    await writeStoredZip(archive, [{ name: 'Fixture.app/' }, { data: 'bad', name }]);
    await assert.rejects(() => validateIosAppZipArchive(archive, 'Fixture.app'), pattern, label);
  }
});

test('pre-extraction ZIP validation rejects special entries and header ambiguity', async (t) => {
  const root = await fixtureRoot(t, 'zip-special');
  for (const [label, entries, pattern] of [
    [
      'fifo',
      [{ name: 'Fixture.app/' }, { mode: 0o010644, name: 'Fixture.app/pipe' }],
      /unsupported special mode/u,
    ],
    [
      'local-name-mismatch',
      [
        { name: 'Fixture.app/' },
        { data: 'bad', localName: '../escaped.txt', name: 'Fixture.app/Safe.txt' },
      ],
      /local header filename does not match/u,
    ],
    [
      'local-crc-mismatch',
      [{ name: 'Fixture.app/' }, { data: 'bad', localCrc: 123, name: 'Fixture.app/Payload.txt' }],
      /local CRC or sizes disagree/u,
    ],
    [
      'local-size-mismatch',
      [
        { name: 'Fixture.app/' },
        { data: 'bad', localCompressedSize: 999, name: 'Fixture.app/Payload.txt' },
      ],
      /local CRC or sizes disagree/u,
    ],
    [
      'descriptor-mismatch',
      [
        { name: 'Fixture.app/' },
        {
          data: 'bad',
          dataDescriptor: true,
          descriptorCrc: 123,
          name: 'Fixture.app/Payload.txt',
        },
      ],
      /data descriptor disagrees/u,
    ],
    [
      'unreferenced-gap',
      [
        { name: 'Fixture.app/' },
        { data: 'bad', gap: 'hidden local bytes', name: 'Fixture.app/Payload.txt' },
      ],
      /unreferenced or ambiguous .* gap/u,
    ],
    [
      'escaping-symlink',
      [
        { name: 'Fixture.app/' },
        { data: '../../escaped.txt', mode: 0o120777, name: 'Fixture.app/Escape.link' },
      ],
      /symlink .* escapes Fixture\.app/u,
    ],
    [
      'symlink-descendant',
      [
        { name: 'Fixture.app/' },
        { data: 'Resources', mode: 0o120777, name: 'Fixture.app/Alias' },
        { data: 'bad', name: 'Fixture.app/Alias/Payload.txt' },
      ],
      /descends through non-directory/u,
    ],
    [
      'case-ambiguous-symlink-descendant',
      [
        { name: 'Fixture.app/' },
        { data: 'Resources', mode: 0o120777, name: 'Fixture.app/Alias' },
        { data: 'bad', name: 'Fixture.app/alias/Payload.txt' },
      ],
      /case-ambiguous non-directory ancestor/u,
    ],
    [
      'unicode-case-ambiguous-symlink-descendant',
      [
        { data: 'Resources', mode: 0o120777, name: 'Fixture.app/straße' },
        { name: 'Fixture.app/' },
        { data: 'bad', name: 'Fixture.app/STRASSE/Payload.txt' },
      ],
      /case-ambiguous non-directory ancestor/u,
    ],
  ]) {
    const archive = path.join(root, `${label}.zip`);
    await writeStoredZip(archive, entries);
    await assert.rejects(() => validateIosAppZipArchive(archive, 'Fixture.app'), pattern, label);
  }
});
