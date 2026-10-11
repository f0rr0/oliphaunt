/** Real archives exercise complete requested membership and canonical module binding. */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { validateDesktopConstruction } from './construction.mts';

const temporary = new Set<string>();
afterEach(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
  temporary.clear();
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
