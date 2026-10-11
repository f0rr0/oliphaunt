/** Real archive tests with an independent native writer and frozen Python oracle. */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { assemble, type MemberSpec, safePath } from './member_payload.mts';
import { inspect } from './validate_member_payload.mts';

const directories = new Set<string>();
function temporary(): string {
  const directory = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'member-payload-'));
  directories.add(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'oliphaunt-extension-member-payload-v1',
    sql_name: 'pgtap',
    owner: 'fixture-owner',
    version: '1.3.5',
    configuration: 'linux-x64-gnu',
    family: 'native',
    creates_extension: true,
    default_version: '1.3.5',
    module_profiles: [],
    data_files: [],
    sql_prefixes: [],
    sql_files: [],
    ...overrides,
  };
}

const sqlPrefix = 'share/postgresql/extension/';
function sqlFiles(): Map<string, Buffer> {
  return new Map([
    [`${sqlPrefix}pgtap.control`, Buffer.from("default_version = '1.3.5'\n")],
    [
      `${sqlPrefix}pgtap--1.3.5.sql`,
      Buffer.from("CREATE FUNCTION ok() RETURNS text AS 'SELECT 1' LANGUAGE sql;\n"),
    ],
  ]);
}

function headerChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
}

function physicalName(header: Buffer, name: string): void {
  if (Buffer.byteLength(name) > 100) throw new Error('test archive path exceeds header field');
  header.fill(0, 0, 100);
  header.fill(0, 345, 500);
  header.write(name, 0, 'utf8');
  headerChecksum(header);
}

interface OracleOptions {
  extra?: { name: string; type?: number };
  rename?: (name: string) => string;
  prefixBOM?: boolean;
  inventory?: { path: string; sha256: string }[];
  omitDescriptor?: boolean;
}

async function writeArchive(
  file: string,
  files: Map<string, Buffer>,
  facts = descriptor(),
  options: OracleOptions = {},
): Promise<void> {
  const recorded =
    options.inventory ??
    [...files].map(([name, data]) => ({
      path: name,
      sha256: createHash('sha256').update(data).digest('hex'),
    }));
  const contents = new Map(files);
  if (!options.omitDescriptor) {
    contents.set('extension.json', Buffer.from(JSON.stringify({ ...facts, files: recorded })));
  }
  // Bun's independent libarchive writer provides genuine USTAR fixtures. Raw
  // header mutations exercise cases archive-writing APIs deliberately forbid.
  let tar = Buffer.from(await new Bun.Archive(Object.fromEntries(contents)).bytes());
  let offset = 0;
  while (tar.subarray(offset, offset + 512).some((byte) => byte !== 0)) {
    const header = tar.subarray(offset, offset + 512);
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii'), 8);
    if (options.rename) {
      physicalName(header, options.rename(header.subarray(0, 100).toString('utf8').split('\0')[0]));
    }
    if (options.prefixBOM) {
      header.write('\uFEFF', 345, 'utf8');
      headerChecksum(header);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (options.extra) {
    const independent = Buffer.from(await new Bun.Archive({ extra: '' }).bytes());
    const header = independent.subarray(0, 512);
    physicalName(header, options.extra.name);
    header[156] = options.extra.type ?? 0x30;
    if (header[156] === 0x35) header.write('0000755\0', 100, 'ascii');
    if (header[156] === 0x31 || header[156] === 0x32) header.write('target', 157, 'ascii');
    headerChecksum(header);
    tar = Buffer.concat([tar.subarray(0, offset), header, Buffer.alloc(1024)]);
  }
  await writeFile(file, gzipSync(tar));
}

// Captured from the replaced Python writer: Unicode metadata, an empty nested
// resource and a projected file symlink. No Python interpreter is needed now.
const PYTHON_ORACLE = Buffer.from(
  'H4sIAAAAAAAC/+2XXXKbMBDH/exTMDwHB4GQUa9SZzxCrGIyIChIrt1MDtRz9GIVHyW2J+20D3Y6k/098LFapD/aXQlyYcS9FOrH95U5mMVVCB2M0uHsuDw76Mm1s5NwTdjCCxc3wHZGtG74xcdEFSUskA9L3te/hs5Afg9VY47vUv8X14RE4Rrr/2bxb9r6CaRLgf9m/U+SCOOP6z9ybeBgQHdFrVdPXa3fpf4Jo9Fl/bME1/+b8Lz0PF/WWhWPthXGJYL/yfPLQttDcGA0eNTWvxt8WhAGuu2cMM5PibKDobXfRrb9WtI582dnmWz9r8XGhiHw/vdi6OlXy+lHx1nDvBv5zvgwdg9K2NJs99BOQ/ujKiWqojz299qJ38NkPRPyPByduRFm17v+Vpjz6XYiSljvFWdcxkmqYqZCEZOMiTwGQlUccrmWivBUSB5RBmlMmOISEhrnSUa4kGGUpaE/dPly9wcNb0zBmQSIs1BSGvFUSSIJ5UJlisqUc6YyN3a0FkAJUEZ5xmMqBeUJ5yRbp4lTkCR/IeF1sq83BXMYqzq3JWzdmHOExoZxItz9KNIXc/A8T9uynLWNIRv7fZiS5ptzNq2F5fSqvq7N0Lk/x9jb2DyNc3eUJN3oMUvqrxra3k0VB2NbCEbD0NbJHVS9Cr8ui2YnrDbBnPlBBVUGbdCIY1mLPNiT6aEv5fbixXqTFhWcDPPq27TgbKfuJ/lNVuHKTeDLEvcoBEEQBEEQBEEQBEEQBEEQBEH+jZ94nzpnACgAAA==',
  'base64',
);

test('independent reader requires construction notices and verifies exact pinned license bytes', async () => {
  const root = temporary();
  const archive = join(root, 'payload.tar.gz');
  const prefix = 'share/licenses/llvm-compiler-rt/';
  const license = Buffer.from('fixture upstream license\n');
  const facts = descriptor({
    construction_licenses: [`${prefix}LICENSE.TXT`, `${prefix}SOURCE.json`],
  });
  const files = sqlFiles();
  files.set(`${prefix}LICENSE.TXT`, license);
  files.set(
    `${prefix}SOURCE.json`,
    Buffer.from(
      JSON.stringify({
        schema: 'oliphaunt-compiler-runtime-source-v1',
        files: [
          {
            destination: 'LICENSE.TXT',
            sha256: createHash('sha256').update(license).digest('hex'),
          },
        ],
      }),
    ),
  );
  await writeArchive(archive, files, facts);
  expect(inspect(archive).construction_licenses).toEqual(facts.construction_licenses);
  files.delete(`${prefix}LICENSE.TXT`);
  await writeArchive(archive, files, facts);
  expect(() => inspect(archive)).toThrow('missing a required construction license');
  files.set(`${prefix}LICENSE.TXT`, Buffer.from('different license bytes\n'));
  await writeArchive(archive, files, facts);
  expect(() => inspect(archive)).toThrow('license bytes differ from their upstream source pin');
});

test('writer preserves the frozen tar/inventory oracle and deterministic gzip framing', async () => {
  const root = temporary();
  await mkdir(join(root, 'tree/nested'), { recursive: true });
  await writeFile(join(root, 'tree/café.txt'), 'file');
  await writeFile(join(root, 'tree/nested/empty'), '');
  await symlink(join(root, 'tree/café.txt'), join(root, 'tree/projected'));
  const spec = {
    descriptor: descriptor({
      sql_name: 'fixture',
      version: '1.0.0',
      creates_extension: false,
      default_version: '',
      data_files: ['data/café.txt', 'data/nested/empty', 'data/projected'],
      notes: 'café 🐘\n',
      nested: { z: true, a: [null, 'é'] },
    }),
    inputs: [{ source: join(root, 'tree'), destination: 'data', tree: true }],
  };
  for (const name of ['first', 'second']) {
    await assemble(spec, join(root, `${name}.tar.gz`), join(root, `${name}.json`));
  }
  const archive = await readFile(join(root, 'first.tar.gz'));
  expect(await readFile(join(root, 'second.tar.gz'))).toEqual(archive);
  expect([...archive.subarray(0, 10)]).toEqual([31, 139, 8, 0, 0, 0, 0, 0, 2, 255]);
  expect(gunzipSync(archive)).toEqual(gunzipSync(PYTHON_ORACLE));
  const oracleFiles = await new Bun.Archive(PYTHON_ORACLE).files();
  expect(await readFile(join(root, 'first.json'), 'utf8')).toBe(
    await oracleFiles.get('extension.json')?.text(),
  );
  const files = await new Bun.Archive(archive).files();
  expect([...files.keys()]).toEqual([
    'data/café.txt',
    'data/nested/empty',
    'data/projected',
    'extension.json',
  ]);
  expect(await files.get('data/projected')?.text()).toBe('file');
  expect(await files.get('data/nested/empty')?.bytes()).toEqual(new Uint8Array());
  expect(inspect(join(root, 'first.tar.gz'), 'fixture', 'fixture-owner')).toEqual(
    JSON.parse(await readFile(join(root, 'first.json'), 'utf8')),
  );
});

test('writer flattens projected files, skips linked directories and rejects malformed mappings', async () => {
  const root = temporary();
  await mkdir(join(root, 'sql'));
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'file'), 'file');
  await writeFile(join(root, 'outside/undeclared'), 'outside');
  await symlink(join(root, 'file'), join(root, 'sql/projected'));
  await symlink(join(root, 'outside'), join(root, 'sql/linked-directory'));
  await symlink(join(root, 'sql'), join(root, 'sql/cycle'));
  const output = join(root, 'payload.tar.gz');
  const inventory = join(root, 'inventory.json');
  const entry = { source: join(root, 'file'), destination: 'safe/file' };
  await expect(
    assemble({ descriptor: descriptor(), inputs: [entry, entry] }, output, inventory),
  ).rejects.toThrow('duplicate');
  await expect(
    assemble(
      { descriptor: descriptor(), inputs: [{ ...entry, destination: 'extension.json' }] },
      output,
      inventory,
    ),
  ).rejects.toThrow('duplicate');
  for (const path of [
    '',
    '../escape',
    '/absolute',
    'safe/../escape',
    'safe\\escape',
    'safe//empty',
    './relative',
  ]) {
    expect(() => safePath(path)).toThrow();
  }
  await expect(assemble({ inputs: [entry] } as MemberSpec, output, inventory)).rejects.toThrow(
    'descriptor',
  );
  await expect(
    assemble(
      {
        descriptor: descriptor(),
        inputs: [{ source: join(root, 'sql'), tree: true }],
      } as MemberSpec,
      output,
      inventory,
    ),
  ).rejects.toThrow('destination');
  await assemble(
    {
      descriptor: descriptor(),
      inputs: [{ source: join(root, 'sql'), destination: 'sql', tree: true }],
    },
    output,
    inventory,
  );
  const files = await new Bun.Archive(await readFile(output)).files();
  expect([...files.keys()]).toEqual(['extension.json', 'sql/projected']);
  expect(await files.get('sql/projected')?.text()).toBe('file');
});

test('validator accepts independently written SQL, additional resources and projected archive links', async () => {
  const root = temporary();
  const archive = join(root, 'payload.tar.gz');
  const files = sqlFiles();
  files.set(`${sqlPrefix}utility_helpers.sql`, Buffer.from('helper'));
  files.set(`${sqlPrefix}uninstall.sql`, Buffer.from('uninstall'));
  files.set('share/postgresql/tsearch_data/fixture.rules', Buffer.from('data'));
  await writeArchive(
    archive,
    files,
    descriptor({
      sql_prefixes: ['utility_'],
      sql_files: ['uninstall.sql'],
      data_files: ['share/postgresql/tsearch_data/fixture.rules'],
    }),
  );
  await symlink(archive, join(root, 'projected.tar.gz'));
  expect(inspect(join(root, 'projected.tar.gz'), 'pgtap', 'fixture-owner').default_version).toBe(
    '1.3.5',
  );
  expect(() => inspect(archive, 'other')).toThrow('requested extension');
  expect(() => inspect(archive, 'pgtap', 'other-owner')).toThrow('canonical ownership');
});

test('validator rejects physical links, directories, traversal, dot prefixes and duplicate paths', async () => {
  const archive = join(temporary(), 'payload.tar.gz');
  for (const extra of [
    { name: '../escape' },
    { name: '/absolute' },
    { name: 'safe\\escape' },
    { name: 'safe//empty' },
    { name: 'link', type: 0x32 },
    { name: 'hardlink', type: 0x31 },
    { name: 'directory', type: 0x35 },
    { name: '.', type: 0x35 },
  ]) {
    await writeArchive(archive, sqlFiles(), descriptor(), { extra });
    expect(() => inspect(archive)).toThrow();
  }
  await writeArchive(archive, sqlFiles(), descriptor(), { rename: (name) => `./${name}` });
  expect(() => inspect(archive)).toThrow('safe regular');
  await writeArchive(archive, sqlFiles(), descriptor(), { rename: (name) => `\uFEFF${name}` });
  expect(() => inspect(archive)).toThrow('safe regular');
  await writeArchive(archive, sqlFiles(), descriptor(), { prefixBOM: true });
  expect(() => inspect(archive)).toThrow('safe regular');
  await writeArchive(archive, sqlFiles(), descriptor(), {
    extra: { name: `${sqlPrefix}pgtap.control` },
  });
  expect(() => inspect(archive)).toThrow('repeats');
});

test('validator rejects malformed descriptors, missing inventory, checksum drift and foreign resources', async () => {
  const archive = join(temporary(), 'payload.tar.gz');
  for (const [field, value, message] of [
    ['schema', 'unknown', 'schema'],
    ['sql_name', 'pgTAP', 'SQL identity'],
    ['sql_name', 'pgtap\n', 'SQL identity'],
    ['configuration', 'android-arm64-v8a', 'unsupported'],
    ['family', 'wasix', 'unsupported'],
    ['creates_extension', undefined, 'creates_extension'],
    ['data_files', ['share/postgresql/tsearch_data/missing.rules'], 'data resource'],
    ['data_files', null, 'resource arrays'],
    ['sql_prefixes', null, 'resource arrays'],
    ['sql_files', null, 'resource arrays'],
    ['module_profiles', ['modules'], 'ABI profile'],
    ['module_profiles', ['modules', 'postgresql'], 'ABI profile'],
  ] as const) {
    await writeArchive(archive, sqlFiles(), descriptor({ [field]: value }));
    expect(() => inspect(archive)).toThrow(message);
  }
  await writeArchive(archive, sqlFiles(), descriptor(), { omitDescriptor: true });
  expect(() => inspect(archive)).toThrow('no descriptor');
  const row = { path: `${sqlPrefix}pgtap.control`, sha256: '0'.repeat(64) };
  for (const inventory of [[], [row, row], [row, { ...row, path: 'missing' }]]) {
    await writeArchive(archive, sqlFiles(), descriptor(), { inventory });
    expect(() => inspect(archive)).toThrow('inventory');
  }
  await writeArchive(archive, sqlFiles(), descriptor(), {
    inventory: [...sqlFiles()].map(([path]) => ({ path, sha256: '0'.repeat(64) })),
  });
  expect(() => inspect(archive)).toThrow('checksum');
  const files = sqlFiles();
  files.set(`${sqlPrefix}foreign.control`, Buffer.from('foreign'));
  await writeArchive(archive, files);
  expect(() => inspect(archive)).toThrow('foreign');
  files.delete(`${sqlPrefix}foreign.control`);
  files.set('undeclared/resource', Buffer.from('foreign'));
  await writeArchive(archive, files);
  expect(() => inspect(archive)).toThrow('undeclared');
});

test('validator requires both real ELF x86_64 shared-object profiles', async () => {
  const archive = join(temporary(), 'payload.tar.gz');
  const facts = descriptor({
    module_profiles: ['postgresql', 'modules'],
    module_file: 'fixture.so',
  });
  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf);
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(62, 18);
  const files = sqlFiles();
  for (const profile of ['postgresql', 'modules']) files.set(`lib/${profile}/fixture.so`, elf);
  await writeArchive(archive, files, facts);
  expect(inspect(archive).module_profiles).toEqual(['postgresql', 'modules']);
  for (const invalid of [Buffer.alloc(63), Buffer.from(elf)]) {
    if (invalid.length === 64) invalid.writeUInt16LE(183, 18);
    files.set('lib/modules/fixture.so', invalid);
    await writeArchive(archive, files, facts);
    expect(() => inspect(archive)).toThrow('ELF x86_64');
  }
  files.delete('lib/modules/fixture.so');
  await writeArchive(archive, files, facts);
  expect(() => inspect(archive)).toThrow('required ABI');
  await writeArchive(
    archive,
    sqlFiles(),
    descriptor({ module_profiles: ['postgresql', 'modules'] }),
  );
  expect(() => inspect(archive)).toThrow('module file');
  await writeArchive(archive, sqlFiles(), descriptor({ module_file: 'fixture.so' }));
  expect(() => inspect(archive)).toThrow('both ABI');
});

test('validator checks AArch64 modules against the archive target identity', async () => {
  const archive = join(temporary(), 'payload.tar.gz');
  const facts = descriptor({
    configuration: 'linux-arm64-gnu',
    module_profiles: ['postgresql', 'modules'],
    module_file: 'fixture.so',
  });
  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf);
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(183, 18);
  const files = sqlFiles();
  for (const profile of ['postgresql', 'modules']) files.set(`lib/${profile}/fixture.so`, elf);
  await writeArchive(archive, files, facts);
  expect(inspect(archive).configuration).toBe('linux-arm64-gnu');
  elf.writeUInt16LE(62, 18);
  await writeArchive(archive, files, facts);
  expect(() => inspect(archive)).toThrow('ELF aarch64');
  await writeArchive(archive, files, { ...facts, configuration: 'linux-arm64-musl' });
  expect(() => inspect(archive)).toThrow('configuration');
});

test('validator requires dependency ELF bytes in both ABI layouts and exact data resources', async () => {
  const archive = join(temporary(), 'payload.tar.gz');
  const facts = descriptor({
    module_profiles: ['postgresql', 'modules'],
    module_file: 'fixture.so',
    dependency_modules: ['fixture_deps.so'],
    data_files: ['share/postgresql/contrib/fixture/install.sql'],
  });
  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf);
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(62, 18);
  const files = sqlFiles();
  for (const profile of ['postgresql', 'modules']) {
    for (const module of ['fixture.so', 'fixture_deps.so'])
      files.set(`lib/${profile}/${module}`, elf);
  }
  files.set('share/postgresql/contrib/fixture/install.sql', Buffer.from('SELECT 1;\n'));
  await writeArchive(archive, files, facts);
  expect(inspect(archive).dependency_modules).toEqual(['fixture_deps.so']);
  files.delete('lib/modules/fixture_deps.so');
  await writeArchive(archive, files, facts);
  expect(() => inspect(archive)).toThrow('required ABI');
  files.set('lib/modules/fixture_deps.so', Buffer.alloc(64));
  await writeArchive(archive, files, facts);
  expect(() => inspect(archive)).toThrow('ELF x86_64');
  files.set('lib/modules/fixture_deps.so', elf);
  files.delete('share/postgresql/contrib/fixture/install.sql');
  await writeArchive(archive, files, facts);
  expect(() => inspect(archive)).toThrow('data resource');
});

test('validator recognizes the upstream PostGIS upgrade template without creating a version edge', async () => {
  const archive = join(temporary(), 'payload.tar.gz');
  const files = new Map([
    [`${sqlPrefix}postgis.control`, Buffer.from("default_version = '3.6.3'\n")],
    [`${sqlPrefix}postgis--3.6.3.sql`, Buffer.from('SELECT 1;\n')],
    [`${sqlPrefix}postgis--TEMPLATED--TO--ANY.sql`, Buffer.from('-- upstream upgrade template\n')],
  ]);
  await writeArchive(archive, files, descriptor({ sql_name: 'postgis', default_version: '3.6.3' }));
  expect(inspect(archive).default_version).toBe('3.6.3');
  files.delete(`${sqlPrefix}postgis--3.6.3.sql`);
  await writeArchive(archive, files, descriptor({ sql_name: 'postgis', default_version: '3.6.3' }));
  expect(() => inspect(archive)).toThrow('not installable');
});

test('validator checks control UTF-8/default version and SQL graph reachability through cycles', async () => {
  const archive = join(temporary(), 'payload.tar.gz');
  const files = sqlFiles();
  files.delete(`${sqlPrefix}pgtap--1.3.5.sql`);
  files.set(`${sqlPrefix}pgtap--1.3.3.sql`, Buffer.from('base'));
  files.set(`${sqlPrefix}pgtap--1.3.3--1.3.4.sql`, Buffer.from('upgrade'));
  files.set(`${sqlPrefix}pgtap--1.3.4--1.3.3.sql`, Buffer.from('cycle'));
  await writeArchive(archive, files);
  expect(() => inspect(archive)).toThrow('not installable');
  files.set(`${sqlPrefix}pgtap--1.3.4--1.3.5.sql`, Buffer.from('upgrade'));
  await writeArchive(archive, files);
  expect(inspect(archive).default_version).toBe('1.3.5');
  files.set(`${sqlPrefix}pgtap--a--b--c.sql`, Buffer.from('invalid'));
  await writeArchive(archive, files);
  expect(() => inspect(archive)).toThrow('SQL version path');
  files.delete(`${sqlPrefix}pgtap--a--b--c.sql`);
  for (const control of [
    Buffer.from("default_version = 'other'\n"),
    Buffer.from("\ufeffdefault_version = '1.3.5'\n"),
    Buffer.from([0xff]),
  ]) {
    files.set(`${sqlPrefix}pgtap.control`, control);
    await writeArchive(archive, files);
    expect(() => inspect(archive)).toThrow();
  }
  files.delete(`${sqlPrefix}pgtap.control`);
  await writeArchive(archive, files);
  expect(() => inspect(archive)).toThrow('required extension control');
  // PostgreSQL contrib versions have no required three-component spelling.
  await writeArchive(
    archive,
    new Map([
      [`${sqlPrefix}pgtap.control`, Buffer.from("default_version = '1.6'\n")],
      [`${sqlPrefix}pgtap--1.6.sql`, Buffer.from('base')],
    ]),
    descriptor({ default_version: '1.6' }),
  );
  expect(inspect(archive).default_version).toBe('1.6');
});

test('writer CLI fails closed on missing arguments and malformed UTF-8 or BOM specs', async () => {
  const root = temporary();
  const script = fileURLToPath(new URL('./member_payload.mts', import.meta.url));
  expect(Bun.spawnSync([process.execPath, script], { stderr: 'pipe' }).exitCode).not.toBe(0);
  for (const bytes of [
    Buffer.concat([
      Buffer.from('{"descriptor":{"note":"'),
      Buffer.from([0xff]),
      Buffer.from('"},"inputs":[]}'),
    ]),
    Buffer.concat([
      Buffer.from('\ufeff'),
      Buffer.from(JSON.stringify({ descriptor: descriptor(), inputs: [] })),
    ]),
  ]) {
    const spec = join(root, 'spec.json');
    await writeFile(spec, bytes);
    const result = Bun.spawnSync(
      [
        process.execPath,
        script,
        '--spec',
        spec,
        '--output',
        join(root, 'out.tar.gz'),
        '--inventory',
        join(root, 'out.json'),
      ],
      { stderr: 'pipe' },
    );
    expect(result.exitCode).not.toBe(0);
  }
  expect(() => readFileSync(join(root, 'out.tar.gz'))).toThrow();
});
