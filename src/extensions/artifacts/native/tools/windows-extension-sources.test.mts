import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { patchTextsearch, postgisSql } from './windows-extension-sources.mts';

test('Windows packing applies to each exact textsearch struct, including V3 predecessors', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'textsearch-windows-'));
  const structs = [
    ['segment/segment.h', 'TpDictEntryV3', 'aligned(4)', 4],
    ['segment/segment.h', 'TpDictEntry', 'aligned(8)', 8],
    ['segment/segment.h', 'TpSegmentPosting', 'packed', 1],
    ['segment/segment.h', 'TpSkipEntryV3', 'packed', 1],
    ['segment/segment.h', 'TpSkipEntry', 'packed', 1],
    ['segment/segment.h', 'TpCtidMapEntry', 'packed', 1],
    ['memtable/expull.h', 'TpExpullEntry', 'packed', 1],
  ] as const;
  try {
    for (const file of [
      'segment/segment.h',
      'memtable/expull.h',
      'am/am.h',
      'types/vector.h',
      'types/query.h',
    ]) {
      const target = path.join(root, 'src', file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        structs
          .filter(([header]) => header === file)
          .map(
            ([, name, attribute]) =>
              `typedef struct ${name}\n{ int value; } __attribute__((${attribute})) ${name};\n`,
          )
          .join('') || 'Datum example(PG_FUNCTION_ARGS);\n',
      );
    }
    patchTextsearch(root);
    for (const [file, name, , pack] of structs) {
      const text = readFileSync(path.join(root, 'src', file), 'utf8');
      assert(text.includes(`#pragma pack(push, ${pack})\n#endif\ntypedef struct ${name}\n`), name);
      assert(text.includes(`} ${name};\n#ifdef _MSC_VER\n#pragma pack(pop)\n`), name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows raster SQL installs and upgrades the raster module under its own extension identity', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'postgis-windows-'));
  const directory = path.join(root, 'postgres/contrib/oliphaunt_external/postgis');
  const sql = 'extensions/postgis/sql/';
  const rasterSql = 'extensions/postgis_raster/sql/';
  const write = (file: string, text: string) => {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const originalEpoch = process.env.SOURCE_DATE_EPOCH;
  try {
    const manifest = path.join(root, 'src/extensions/external/postgis/source.toml');
    mkdirSync(path.dirname(manifest), { recursive: true });
    writeFileSync(manifest, 'source_date_epoch = 1780943336\n');
    process.env.SOURCE_DATE_EPOCH = '1780943336';
    write(
      'Version.config',
      'POSTGIS_MAJOR_VERSION=3\nPOSTGIS_MINOR_VERSION=6\nPOSTGIS_MICRO_VERSION=4\n',
    );
    for (const file of [
      'postgis/common_before_upgrade.sql',
      'postgis/postgis_before_upgrade.sql',
      'postgis/postgis_after_upgrade.sql',
      'postgis/common_after_upgrade.sql',
      'postgis/postgis_upgrade.sql.in',
      sql + 'postgis_upgrade_for_extension.sql.in',
      'raster/rt_pg/rtpostgis_upgrade_cleanup.sql',
      'raster/rt_pg/rtpostgis_drop.sql',
      'raster/rt_pg/uninstall_rtpostgis.sql',
      sql + 'raster_unpackage_body.sql',
      sql + 'postgis_for_extension.sql',
      sql + 'spatial_ref_sys_config_dump.sql',
      sql + 'spatial_ref_sys.sql',
      'extensions/postgis_extension_helper.sql',
      'extensions/postgis_extension_helper_uninstall.sql',
    ])
      write(file, '-- fixture\n');
    write(
      rasterSql + 'rtpostgis.sql',
      "CREATE FUNCTION raster_fixture() RETURNS text AS '$libdir/postgis_raster-3', 'raster_fixture' LANGUAGE C;\n",
    );
    write(rasterSql + 'rtpostgis_upgrade.sql.in', 'DROP FUNCTION raster_fixture();\n');
    write('extensions/postgis/unpackage_raster_if_needed.sql', '-- UNPACKAGE_CODE\n-- end\n');
    const config = {
      repo: root,
      work: root,
      postgres: path.join(root, 'postgres'),
      install: path.join(root, 'install'),
    };
    postgisSql(config, 'postgis-sql-upgrade');
    postgisSql(config, 'postgis-sql-install');
    const read = (file: string) => readFileSync(path.join(directory, file), 'utf8');
    const install = read(rasterSql + 'postgis_raster--3.6.4.sql');
    assert(install.includes('CREATE EXTENSION postgis_raster'));
    assert(install.includes('$libdir/postgis_raster-3'));
    const upgrade = read(rasterSql + 'postgis_raster--ANY--3.6.4.sql');
    assert(
      upgrade.includes(
        "postgis_extension_drop_if_exists('postgis_raster', 'DROP FUNCTION raster_fixture()')",
      ),
    );
    assert(!upgrade.includes('BEGIN;'));
    assert(
      read(rasterSql + 'postgis_raster--3.6.4--ANY.sql').includes(
        'extension postgis_raster version',
      ),
    );
    for (const [folder, name] of [
      [sql, 'postgis'],
      [rasterSql, 'postgis_raster'],
    ]) {
      write(folder + name + '--unpackaged--3.6.4.sql', '-- unpackaged objects\n');
    }
    postgisSql(config, 'postgis-sql-unpackaged');
    assert(read(rasterSql + 'postgis_raster--unpackaged--3.6.4.sql').endsWith(upgrade));
  } finally {
    if (originalEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = originalEpoch;
    rmSync(root, { recursive: true, force: true });
  }
});
