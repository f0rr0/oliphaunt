/** Real archives exercise complete requested membership and canonical module binding. */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  assertSharedDesktopLicense,
  desktopMemberModuleRoots,
  validateDesktopConstruction,
} from './construction.mts';

const temporary = new Set<string>();
afterEach(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
  temporary.clear();
});

test('only identical resources declared as construction licenses by both members may overlap', () => {
  const name = 'share/licenses/llvm-compiler-rt/LICENSE.TXT';
  const original = { declared: true, mode: 0o644, data: Buffer.from('upstream license') };
  expect(() => assertSharedDesktopLicense(name, original, { ...original })).not.toThrow();
  for (const incoming of [
    { ...original, data: Buffer.from('different license') },
    { ...original, mode: 0o600 },
    { ...original, declared: false },
  ])
    expect(() => assertSharedDesktopLicense(name, original, incoming)).toThrow(/overlap/);
  expect(() =>
    assertSharedDesktopLicense(name, { ...original, declared: false }, original),
  ).toThrow(/overlap/);
  for (const resource of [
    'lib/modules/vector.so',
    'share/postgresql/extension/vector.control',
    'share/postgresql/extension/vector--1.0.sql',
    'share/postgresql/extension/vector.data',
  ])
    expect(() => assertSharedDesktopLicense(resource, original, original)).toThrow(/overlap/);
});

const moduleEntries = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([name, sql]) => [name, { data: () => Buffer.from(sql) }]));

for (const suffix of ['.so', '.dylib', '.dll']) {
  test(`current controls and install SQL declare primary, companion, and topology roots (${suffix})`, () => {
    const entries = moduleEntries({
      'share/postgresql/extension/postgis.control':
        "default_version = '3.6.2'\nmodule_pathname = '$libdir/postgis-3'\n",
      'share/postgresql/extension/postgis--3.6.2.sql':
        "CREATE FUNCTION postgis_version() RETURNS text AS 'MODULE_PATHNAME', 'postgis_version' LANGUAGE C;\nCREATE FUNCTION postgis_other() RETURNS text as 'module_pathname', 'postgis_other' LANGUAGE C;\n",
      'share/postgresql/extension/postgis_raster.control': `module_pathname = '$libdir/postgis_raster-3${suffix}'\n`,
      'share/postgresql/extension/postgis_topology.control': "default_version = '3.6.2'\n",
      'share/postgresql/extension/postgis_topology--3.6.2.sql':
        "-- there isn't any node\nCREATE FUNCTION topology_version()\nRETURNS text\nAS\n   '$libdir/postgis_topology-3',\n   'topology_version'\nLANGUAGE C;\n",
      [`lib/postgresql/postgis-3${suffix}`]: 'primary PG module',
      [`lib/postgresql/postgis_raster-3${suffix}`]: 'companion PG module',
      [`lib/postgresql/postgis_topology-3${suffix}`]: 'topology PG module',
      [`lib/postgresql/liboliphaunt_postgis_deps${suffix}`]: 'plain support library',
    });
    expect(desktopMemberModuleRoots(entries, `postgis-3${suffix}`)).toEqual([
      `postgis-3${suffix}`,
      `postgis_raster-3${suffix}`,
      `postgis_topology-3${suffix}`,
    ]);
  });
}

test('historical and upgrade SQL cannot introduce roots absent from the current install script', () => {
  const entries = moduleEntries({
    'share/postgresql/extension/current.control':
      "default_version = '2.0'\nmodule_pathname = '$libdir/current'\n",
    'share/postgresql/extension/current--2.0.sql': "AS 'MODULE_PATHNAME', 'current_symbol';\n",
    'lib/postgresql/current.so': 'PG module',
  });
  for (const name of [
    'share/postgresql/extension/current--1.0.sql',
    'share/postgresql/extension/current--1.0--2.0.sql',
    'share/postgresql/extension/unselected--2.0.sql',
  ])
    entries.set(name, {
      data: () => {
        throw new Error('historical or unselected SQL must not be read');
      },
    });
  expect(desktopMemberModuleRoots(entries, 'current.so')).toEqual(['current.so']);
});

test('a newest default reached through upgrades retains its control root without scanning the old base', () => {
  const entries = moduleEntries({
    'share/postgresql/extension/hstore.control':
      "default_version = '1.8'\nmodule_pathname = '$libdir/hstore'\n",
    'lib/postgresql/hstore.so': 'PG module',
  });
  entries.set('share/postgresql/extension/hstore--1.4.sql', {
    data: () => {
      throw new Error('old base SQL must not be read');
    },
  });
  expect(desktopMemberModuleRoots(entries, 'hstore.so')).toEqual(['hstore.so']);
});

test('control and direct active SQL roots require actual candidate PG module files', () => {
  expect(() =>
    desktopMemberModuleRoots(
      moduleEntries({
        'share/postgresql/extension/missing.control': "module_pathname = '$libdir/missing'\n",
      }),
      'primary.so',
    ),
  ).toThrow(/candidate PG module/);
  expect(() =>
    desktopMemberModuleRoots(
      moduleEntries({
        'share/postgresql/extension/missing.control': "default_version = '1.0'\n",
        'share/postgresql/extension/missing--1.0.sql': "AS '$libdir/missing', 'symbol';\n",
      }),
      'primary.so',
    ),
  ).toThrow(/candidate PG module/);
});

test('both control and active SQL declarations reject unsafe or external module paths', () => {
  for (const library of ['/tmp/host.so', '$libdir/../host', '$libdir/subdir/host', 'host']) {
    expect(() =>
      desktopMemberModuleRoots(
        moduleEntries({
          'share/postgresql/extension/unsafe.control': `module_pathname = '${library}'\n`,
        }),
        'primary.so',
      ),
    ).toThrow(/unsupported module/);
    expect(() =>
      desktopMemberModuleRoots(
        moduleEntries({
          'share/postgresql/extension/unsafe.control': "default_version = '1.0'\n",
          'share/postgresql/extension/unsafe--1.0.sql': `AS '${library}', 'symbol';\n`,
        }),
        'primary.so',
      ),
    ).toThrow(/unsupported module/);
  }
});

test('MODULE_PATHNAME SQL requires its control binding while SQL-only members need no module', () => {
  const entries = moduleEntries({
    'share/postgresql/extension/sql_only.control': "default_version = '1.0'\n",
    'share/postgresql/extension/sql_only--1.0.sql': 'SELECT 1;\n',
  });
  expect(desktopMemberModuleRoots(entries, '')).toEqual([]);
  entries.set('share/postgresql/extension/sql_only--1.0.sql', {
    data: () => Buffer.from("AS 'MODULE_PATHNAME', 'symbol';\n"),
  });
  expect(() => desktopMemberModuleRoots(entries, 'primary.so')).toThrow(/control module_pathname/);
});

type Member = {
  sql_name: string;
  label: string;
  owner: string;
  version: string;
  source_kind: string;
  default_version: string;
  creates_extension: boolean;
  module_file: string;
};

function member(name = 'pgtap', compiled = false): Member {
  return {
    sql_name: name,
    label: `//src/extensions/external/${name}:native_payload`,
    owner: `oliphaunt-extension-${name}`,
    version: '1.2.3',
    source_kind: 'oliphaunt-other-extension',
    default_version: '1.2.3',
    creates_extension: true,
    module_file: compiled ? `${name}.so` : '',
  };
}

function plan(members: Member[], configuration = 'linux-x64-gnu') {
  return {
    schema: 'oliphaunt-desktop-extension-construction-v1',
    configuration,
    excluded: ['postgis'],
    members,
  };
}

async function archive(row: Member, overrides: Record<string, unknown> = {}): Promise<string> {
  const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'extension-construction-'));
  temporary.add(root);
  const files = new Map<string, Buffer>([
    [
      `share/postgresql/extension/${row.sql_name}.control`,
      Buffer.from(`default_version = '${row.default_version}'\n`),
    ],
    [
      `share/postgresql/extension/${row.sql_name}--${row.default_version}.sql`,
      Buffer.from('SELECT 1;\n'),
    ],
  ]);
  if (row.module_file) {
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(3, 16);
    elf.writeUInt16LE(62, 18);
    for (const profile of ['postgresql', 'modules']) {
      files.set(`lib/${profile}/${row.module_file}`, elf);
    }
  }
  const descriptor = {
    schema: 'oliphaunt-extension-member-payload-v1',
    ...row,
    configuration: 'linux-x64-gnu',
    family: 'native',
    module_profiles: row.module_file ? ['postgresql', 'modules'] : [],
    ...overrides,
    files: [...files].map(([path, bytes]) => ({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
  files.set('extension.json', Buffer.from(JSON.stringify(descriptor)));
  const path = join(root, 'payload.tar.gz');
  writeFileSync(
    path,
    gzipSync(Buffer.from(await new Bun.Archive(Object.fromEntries(files)).bytes())),
  );
  return path;
}

test('one root independently validates every requested archive including both module ABIs', async () => {
  const sql = member();
  const compiled = member('pg_hashids', true);
  expect(
    validateDesktopConstruction(plan([sql, compiled]), [
      await archive(sql),
      await archive(compiled),
    ]),
  ).toEqual({
    configuration: 'linux-x64-gnu',
    members: ['pgtap', 'pg_hashids'],
    compiled: 1,
    sqlOnly: 1,
  });
});

test('missing, duplicate, swapped, and foreign-owner archives cannot masquerade as complete', async () => {
  const sql = member();
  const compiled = member('pg_hashids', true);
  const files = [await archive(sql), await archive(compiled)];
  expect(() => validateDesktopConstruction(plan([sql, compiled]), files.slice(0, 1))).toThrow(
    /every requested/,
  );
  expect(() => validateDesktopConstruction(plan([sql, sql]), [files[0], files[0]])).toThrow(
    /repeated/,
  );
  expect(() => validateDesktopConstruction(plan([sql, compiled]), files.toReversed())).toThrow(
    /SQL identity/,
  );
  const foreign = await archive(sql, { owner: 'another-product' });
  expect(() => validateDesktopConstruction(plan([sql]), [foreign])).toThrow(/carrier owner/);
});

test('compiled members require actual module bytes and canonical current identity/configuration', async () => {
  const compiled = member('pg_hashids', true);
  const sqlOnly = await archive({ ...compiled, module_file: '' });
  expect(() => validateDesktopConstruction(plan([compiled]), [sqlOnly])).toThrow(/module_file/);
  const valid = await archive(compiled);
  expect(() => validateDesktopConstruction(plan([compiled], 'macos-arm64'), [valid])).toThrow(
    /configuration/,
  );
  const stale = await archive(compiled, { version: '1.2.2' });
  expect(() => validateDesktopConstruction(plan([compiled]), [stale])).toThrow(/version/);
  const changed = await archive(compiled, { source_kind: 'postgres-contrib' });
  expect(() => validateDesktopConstruction(plan([compiled]), [changed])).toThrow(/source_kind/);
});

test('empty, PostGIS, and mobile plans fail before claiming host construction coverage', async () => {
  expect(() => validateDesktopConstruction(plan([]), [])).toThrow(/membership/);
  const sql = member();
  const path = await archive(sql);
  expect(() => validateDesktopConstruction(plan([sql], 'ios-xcframework'), [path])).toThrow(
    /profile/,
  );
  expect(() => validateDesktopConstruction(plan([member('postgis')]), [path])).toThrow(/invalid/);
  expect(() => validateDesktopConstruction({ ...plan([sql]), excluded: [] }, [path])).toThrow(
    /membership/,
  );
});

test('explicit complete desktop selection includes PostGIS and rejects an incomplete or ambiguous plan', async () => {
  const sql = member();
  const postgis = member('postgis', true);
  const files = [await archive(sql), await archive(postgis)];
  const complete = { ...plan([sql, postgis]), include_postgis: true, excluded: [] };
  expect(validateDesktopConstruction(complete, files)).toEqual({
    configuration: 'linux-x64-gnu',
    members: ['pgtap', 'postgis'],
    compiled: 1,
    sqlOnly: 1,
  });
  expect(() => validateDesktopConstruction({ ...complete, members: [sql] }, [files[0]])).toThrow(
    /explicit PostGIS selection/,
  );
  expect(() => validateDesktopConstruction({ ...complete, excluded: ['postgis'] }, files)).toThrow(
    /membership/,
  );
  expect(() =>
    validateDesktopConstruction({ ...complete, include_postgis: 'true' }, files),
  ).toThrow(/membership/);
  expect(() => validateDesktopConstruction({ ...complete, include_postgis: false }, files)).toThrow(
    /membership/,
  );
});
