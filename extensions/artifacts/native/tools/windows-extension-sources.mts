import assert from 'node:assert/strict';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { preprocessSql } from '../../../external/postgis/tools/preprocess-sql.mts';

const read = (file: string) => readFileSync(file, 'utf8');
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const quote = (value: string) => `'${value.replaceAll('\\', '/').replaceAll("'", "\\'")}'`;
const list = (values: string[]) => values.map((value) => `  ${quote(value)}`).join(',\n');
const glob = (root: string, pattern: string) =>
  [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })].sort();
const version = (root: string, extension: string) => {
  const matches = [
    ...read(path.join(root, `${extension}.control`)).matchAll(
      /^\s*default_version\s*=\s*'([^']+)'\s*$/gm,
    ),
  ];
  assert.equal(matches.length, 1, `${extension} must declare a default_version`);
  return matches[0][1];
};
function copy(source: string, destination: string) {
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (file) => path.basename(file) !== '.git',
  });
}
function replace(file: string, before: string | RegExp, after: string) {
  const original = read(file);
  const updated = original.replace(before, after);
  assert.notEqual(updated, original, `missing Windows source patch anchor in ${file}`);
  write(file, updated);
}

// Only the literal object list is needed from these pinned PGXS projects.
// Reject expressions rather than attempting to implement GNU Make here.
export function pgxsSources(root: string) {
  const makefile = read(path.join(root, 'Makefile')).replace(/\\\r?\n/g, ' ');
  const objects = makefile.match(/^OBJS\s*=\s*([^\n]*)/m)?.[1];
  if (objects === undefined) {
    const modules = makefile
      .match(/^MODULES\s*=\s*([^\n]*)/m)?.[1]
      ?.trim()
      .split(/\s+/);
    assert(
      modules?.length && modules.every((value) => /^[\w-]+$/.test(value)),
      'missing literal PGXS modules',
    );
    return modules.map((module) => `${module}.c`);
  }
  const values = objects.replaceAll('$(WIN32RES)', '').trim().split(/\s+/);
  assert(
    values.length && values.every((value) => /^[\w./-]+\.o$/.test(value)),
    'unsupported PGXS object expression',
  );
  return values.map((value) => value.slice(0, -2) + '.c');
}

function patchTextsearch(root: string) {
  write(
    path.join(root, 'src/oliphaunt_windows_compat.h'),
    '#ifdef _MSC_VER\n#ifndef __attribute__\n#define __attribute__(x)\n#endif\n#endif\n',
  );
  write(
    path.join(root, 'src/unistd.h'),
    '#ifndef OLIPHAUNT_WINDOWS_UNISTD_H\n#define OLIPHAUNT_WINDOWS_UNISTD_H\n#endif\n',
  );
  for (const [file, name, attribute, pack, size, alignment] of [
    ['segment/segment.h', 'TpDictEntryV3', 'aligned(4)', 4, 12, 4],
    ['segment/segment.h', 'TpDictEntry', 'aligned(8)', 8, 16, 8],
    ['segment/segment.h', 'TpSegmentPosting', 'packed', 1, 14, 1],
    ['segment/segment.h', 'TpSkipEntryV3', 'packed', 1, 16, 1],
    ['segment/segment.h', 'TpSkipEntry', 'packed', 1, 20, 1],
    ['segment/segment.h', 'TpCtidMapEntry', 'packed', 1, 6, 1],
    ['memtable/expull.h', 'TpExpullEntry', 'packed', 1, 7, 1],
  ] as const) {
    const target = path.join(root, 'src', file);
    replace(
      target,
      `typedef struct ${name}`,
      `#ifdef _MSC_VER\n#pragma pack(push, ${pack})\n#endif\ntypedef struct ${name}`,
    );
    replace(
      target,
      `} __attribute__((${attribute})) ${name};`,
      `} ${name};\n#ifdef _MSC_VER\n#pragma pack(pop)\nStaticAssertDecl(sizeof(${name}) == ${size}, "${name} size");\nStaticAssertDecl(__alignof(${name}) == ${alignment}, "${name} alignment");\n#endif`,
    );
  }
  for (const file of ['src/am/am.h', 'src/types/vector.h', 'src/types/query.h']) {
    replace(
      path.join(root, file),
      /^Datum (\w+)\(PG_FUNCTION_ARGS\);/gm,
      'extern PGDLLEXPORT Datum $1(PG_FUNCTION_ARGS);',
    );
  }
}

type Config = { repo: string; work: string; postgres: string; install: string };
function moduleRecipe(
  config: Config,
  subdir: string,
  module: string,
  sources: string[],
  data: string[],
  cArgs: string[] = [],
  linkArgs: string[] = [],
  includes: string[] = [],
) {
  const directory = path.join(config.postgres, 'contrib/oliphaunt_external', subdir);
  const variable = subdir.replaceAll('-', '_');
  write(
    path.join(directory, 'meson.build'),
    `${variable} = shared_module(\n  ${quote(module)},\n  files(\n${list(sources)}\n  ),\n  c_pch: pch_postgres_h,\n  include_directories: [${includes.map((value) => `include_directories(${quote(value)})`).join(', ')}],\n  kwargs: contrib_mod_args + { 'c_args': [\n${list(cArgs)}\n], 'link_args': [\n${list(linkArgs)}\n] },\n)\ncontrib_targets += ${variable}\ninstall_data(\n${list(data)},\n  kwargs: contrib_data_args,\n)\n`,
  );
  appendSubdir(config, subdir);
}
function appendSubdir(config: Config, subdir: string) {
  const file = path.join(config.postgres, 'contrib/meson.build');
  const line = `subdir('oliphaunt_external/${subdir}')`;
  const text = read(file);
  if (!text.includes(line)) write(file, text.trimEnd() + '\n' + line + '\n');
}

export function prepareSimple(config: Config, extension: string) {
  const subdir = extension === 'uuid-ossp' ? 'uuid_ossp' : extension;
  const destination = path.join(config.postgres, 'contrib/oliphaunt_external', subdir);
  const cArgs: string[] = [],
    linkArgs: string[] = [],
    includes: string[] = [];
  let sources: string[], data: string[];
  if (extension === 'pgcrypto' || extension === 'uuid-ossp') {
    mkdirSync(destination, { recursive: true });
    const contrib = path.join(config.postgres, 'contrib', extension);
    data = [...glob(contrib, `${extension}--*.sql`), `${extension}.control`].map(
      (file) => `../../${extension}/${file}`,
    );
    if (extension === 'pgcrypto') {
      sources = glob(contrib, '*.c').map((file) => `../../pgcrypto/${file}`);
      cArgs.push(`/I${path.join(config.work, 'windows-dependencies/openssl/include')}`);
      linkArgs.push(
        path.join(config.work, 'windows-dependencies/openssl/lib/libcrypto.lib'),
        'crypt32.lib',
        'advapi32.lib',
        'bcrypt.lib',
        'ws2_32.lib',
        'user32.lib',
      );
    } else {
      copyFileSync(
        path.join(config.repo, 'runtimes/liboliphaunt-native/portable-uuid/portable_uuid.c'),
        path.join(destination, 'portable_uuid.c'),
      );
      sources = ['../../uuid-ossp/uuid-ossp.c', 'portable_uuid.c'];
      cArgs.push(
        `/I${path.join(config.repo, 'runtimes/liboliphaunt-native/portable-uuid/include')}`,
        '/DHAVE_UUID_E2FS=1',
        '/DHAVE_UUID_UUID_H=1',
      );
    }
  } else {
    const checkout = extension === 'vector' ? 'pgvector' : extension;
    copy(path.join(config.repo, 'target/oliphaunt-sources/checkouts', checkout), destination);
    sources = pgxsSources(destination);
    if (extension === 'vector') {
      copyFileSync(
        path.join(destination, 'sql/vector.sql'),
        path.join(destination, `sql/vector--${version(destination, extension)}.sql`),
      );
      cArgs.push('/fp:fast');
    }
    data = [
      ...glob(destination, `${extension}--*.sql`),
      ...glob(destination, `sql/${extension}--*.sql`),
      `${extension}.control`,
    ];
    if (extension === 'pg_textsearch') {
      patchTextsearch(destination);
      cArgs.push(
        '/D_CRT_SECURE_NO_WARNINGS',
        `/DPG_TEXTSEARCH_VERSION="${version(destination, extension)}"`,
        `/FI${path.join(destination, 'src/oliphaunt_windows_compat.h')}`,
      );
      includes.push('src');
    }
    if (extension === 'pg_uuidv7') {
      replace(
        path.join(destination, 'pg_uuidv7.c'),
        '#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)',
        `#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)\n#ifdef _WIN32\n#ifndef CLOCK_REALTIME\n#define CLOCK_REALTIME 0\n#endif\nstatic int oliphaunt_pg_uuidv7_clock_gettime(int clock_id, struct timespec *ts) {\n  TimestampTz unix_usecs;\n  if (clock_id != CLOCK_REALTIME || ts == NULL) return -1;\n  unix_usecs = GetCurrentTimestamp() + EPOCH_DIFF_USECS;\n  ts->tv_sec = (time_t) (unix_usecs / USECS_PER_SEC);\n  ts->tv_nsec = (long) ((unix_usecs % USECS_PER_SEC) * 1000);\n  return 0;\n}\n#define clock_gettime oliphaunt_pg_uuidv7_clock_gettime\n#endif`,
      );
    }
  }
  for (const file of [...sources, ...data])
    assert(existsSync(path.join(destination, file)), `missing extension input ${file}`);
  moduleRecipe(config, subdir, extension, sources, data, cArgs, linkArgs, includes);
}

function postgisVersion(root: string) {
  const text = read(path.join(root, 'Version.config'));
  const values = ['MAJOR', 'MINOR', 'MICRO'].map((key) => {
    const value = text.match(new RegExp(`^POSTGIS_${key}_VERSION=(.+)$`, 'm'))?.[1].trim();
    assert(value && /^[0-9]+$/.test(value), `invalid PostGIS ${key} version`);
    return value;
  });
  return {
    major: values[0],
    minor: values[1],
    micro: values[2],
    version: values.join('.'),
    majorMinor: values.slice(0, 2).join('.'),
  };
}
function postgisDirectory(config: Config) {
  return path.join(config.postgres, 'contrib/oliphaunt_external/postgis');
}
function postgisTemplates(config: Config) {
  return path.join(config.repo, 'extensions/external/postgis/tools/windows');
}
function expand(input: string, output: string, values: Record<string, string>) {
  let text = read(input);
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`@${key}@`, value);
  write(output, text);
}
function sourceDate(config: Config) {
  const pin = Bun.TOML.parse(
    read(path.join(config.repo, 'extensions/external/postgis/source.toml')),
  );
  assert(
    Number.isSafeInteger(pin.source_date_epoch) && pin.source_date_epoch > 0,
    'invalid PostGIS source date',
  );
  assert.equal(
    process.env.SOURCE_DATE_EPOCH,
    String(pin.source_date_epoch),
    'use the pinned PostGIS source date',
  );
  return new Date(pin.source_date_epoch * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
export function preparePostgis(config: Config) {
  const directory = postgisDirectory(config);
  copy(path.join(config.repo, 'target/oliphaunt-sources/checkouts/postgis'), directory);
  const pgis = postgisVersion(directory);
  const source = Bun.TOML.parse(
    read(path.join(config.repo, 'extensions/external/postgis/source.toml')),
  );
  const componentVersion = (component: string) => {
    const pin = Bun.TOML.parse(
      read(
        path.join(
          config.repo,
          'extensions/external/postgis/dependencies',
          component,
          'source.toml',
        ),
      ),
    );
    const value = String(pin.branch).replace(/^v/, '');
    assert(/^\d+\.\d+\.\d+$/.test(value), `invalid pinned ${component} version`);
    return value;
  };
  const number = (value: string) =>
    value
      .split('.')
      .map((part, index) => (index ? part.padStart(2, '0') : part))
      .join('');
  const pgMajor = String(
    Bun.TOML.parse(read(path.join(config.repo, 'third-party/postgres/source.toml'))).postgresql
      .version,
  ).split('.')[0];
  const values = {
    LOCALE_DIR: path.join(config.install, 'share/locale').replaceAll('\\', '/'),
    BUILD_DATE: sourceDate(config),
    GEOS_VERSION: number(componentVersion('geos')),
    LIBXML_VERSION: componentVersion('libxml2'),
    PROJ_VERSION: number(componentVersion('proj')),
    VERSION: pgis.version,
    MAJOR: pgis.major,
    MINOR: pgis.minor,
    MICRO: pgis.micro,
    POSTGIS_VERSION: `${pgis.majorMinor} USE_GEOS=1 USE_PROJ=1 USE_STATS=1`,
  };
  write(path.join(directory, 'postgis_revision.h'), `#define POSTGIS_REVISION ${source.commit}\n`);
  expand(
    path.join(postgisTemplates(config), 'postgis_config.h.in'),
    path.join(directory, 'postgis_config.h'),
    values,
  );
  const macros = {
    POSTGIS_PGSQL_VERSION: `${pgMajor}0`,
    POSTGIS_PGSQL_HR_VERSION: `${pgMajor}.0`,
    POSTGIS_GEOS_VERSION: values.GEOS_VERSION,
    POSTGIS_PROJ_VERSION: values.PROJ_VERSION,
    POSTGIS_LIB_VERSION: pgis.version,
    POSTGIS_LIBXML2_VERSION: values.LIBXML_VERSION,
    POSTGIS_SFCGAL_VERSION: '0',
    POSTGIS_VERSION: values.POSTGIS_VERSION,
    POSTGIS_BUILD_DATE: values.BUILD_DATE,
    POSTGIS_SCRIPTS_VERSION: pgis.version,
    SRID_MAX: '999999',
    SRID_USR_MAX: '998999',
    POSTGIS_MAJOR_VERSION: pgis.major,
    POSTGIS_MINOR_VERSION: pgis.minor,
  };
  for (const file of ['postgis/sqldefines.h', 'liblwgeom/liblwgeom.h'])
    expand(path.join(directory, file + '.in'), path.join(directory, file), macros);
  expand(
    path.join(directory, 'extensions/postgis/postgis.control.in'),
    path.join(directory, 'extensions/postgis/postgis.control'),
    { EXTVERSION: pgis.version, EXTENSION: 'postgis', MODULEPATH: '$libdir/postgis-3' },
  );
  copyFileSync(
    path.join(postgisTemplates(config), 'postgis-compat.h'),
    path.join(directory, 'oliphaunt_postgis_windows_compat.h'),
  );
  copyFileSync(
    path.join(postgisTemplates(config), 'flatgeobuf-compat.h'),
    path.join(directory, 'oliphaunt_flatgeobuf_windows_compat.h'),
  );
  for (const folder of ['postgis', 'libpgcommon', 'liblwgeom']) {
    for (const file of glob(path.join(directory, folder), '**/*.{c,h}')) {
      const target = path.join(directory, folder, file),
        text = read(target);
      const updated = text.replace(
        /^[ \t]*(?!(?:extern\s+)?PGDLLEXPORT\s+)(?:extern\s+)?Datum\s+(\w+)\s*\(PG_FUNCTION_ARGS\);\r?$/gm,
        'extern PGDLLEXPORT Datum $1(PG_FUNCTION_ARGS);',
      );
      if (updated !== text) write(target, updated);
    }
  }
  replace(
    path.join(directory, 'postgis/postgis_legacy.c'),
    /^([ \t]*)Datum[ \t]+funcname[ \t]*\(PG_FUNCTION_ARGS\);[ \t]*\\\r?$/gm,
    '$1extern PGDLLEXPORT Datum funcname(PG_FUNCTION_ARGS); \\',
  );
  for (const variables of [
    ['x', 'y', 'z', 'm'],
    ['xv', 'yv', 'zv', 'mv'],
  ]) {
    replace(
      path.join(directory, 'deps/flatgeobuf/geometryreader.cpp'),
      `pt = (POINT4D) { ${variables.join(', ')} };`,
      ['x', 'y', 'z', 'm'].map((field, index) => `pt.${field} = ${variables[index]};`).join('\n'),
    );
  }
  const comments = path.join(directory, 'doc/postgis_comments.sql');
  if (!existsSync(comments))
    write(comments, '-- Optional SQL comments are not generated by the Windows producer.\n');
}

function firstLibrary(root: string, names: string[]) {
  for (const name of names) {
    const found = glob(root, `**/${name}`)[0];
    if (found) return path.join(root, found);
  }
  throw new Error(`missing library ${names.join('/')} under ${root}`);
}
export function postgisMeson(config: Config) {
  const directory = postgisDirectory(config),
    pgis = postgisVersion(directory);
  const dependencies = path.join(config.work, 'windows-dependencies/postgis');
  const cArgs = [
    '/D_CRT_SECURE_NO_WARNINGS',
    '/D_USE_MATH_DEFINES',
    '/DLIBXML_STATIC',
    '/DRYU_NO_TRAILING_ZEROS',
    `/FI${path.join(directory, 'oliphaunt_postgis_windows_compat.h')}`,
  ];
  // Keep liblwgeom before the similarly named PostgreSQL module headers.
  cArgs.push(
    ...[
      '',
      'liblwgeom',
      'postgis',
      'libpgcommon',
      'deps',
      'deps/flatgeobuf',
      'deps/flatgeobuf/include',
      'deps/ryu',
    ].map((file) => `/I${path.join(directory, file)}`),
  );
  cArgs.push(
    ...[
      'geos/include',
      'proj/include',
      'json-c/include',
      'json-c/include/json-c',
      'libxml2/include/libxml2',
    ].map((file) => `/I${path.join(dependencies, file)}`),
  );
  const linkArgs = [
    firstLibrary(path.join(dependencies, 'flatgeobuf'), ['flatgeobuf.lib']),
    firstLibrary(path.join(dependencies, 'geos'), ['geos_c.lib']),
    firstLibrary(path.join(dependencies, 'geos'), ['geos.lib']),
    firstLibrary(path.join(dependencies, 'proj'), ['proj.lib', 'libproj.lib']),
    firstLibrary(path.join(dependencies, 'sqlite'), ['sqlite3.lib', 'libsqlite3.lib']),
    firstLibrary(path.join(dependencies, 'json-c'), ['json-c.lib', 'json-c-static.lib']),
    firstLibrary(path.join(dependencies, 'libxml2'), ['libxml2s.lib', 'libxml2.lib', 'xml2.lib']),
    'ws2_32.lib',
    'bcrypt.lib',
    'advapi32.lib',
    'shell32.lib',
    'user32.lib',
  ];
  const data = [
    'extensions/postgis/postgis.control',
    ...glob(directory, 'extensions/postgis/sql/postgis--*.sql'),
  ];
  const contrib = [
    'postgis/legacy.sql',
    'postgis/legacy_gist.sql',
    'postgis/legacy_minimal.sql',
    'postgis/postgis.sql',
    'postgis/postgis_upgrade.sql',
    'spatial_ref_sys.sql',
    'postgis/uninstall_legacy.sql',
    'postgis/uninstall_postgis.sql',
    'doc/postgis_comments.sql',
  ];
  expand(
    path.join(postgisTemplates(config), 'meson.build.in'),
    path.join(directory, 'meson.build'),
    {
      C_ARGS: list(cArgs),
      LINK_ARGS: list(linkArgs),
      EXTENSION_DATA: list(data),
      CONTRIB_DATA: list(contrib),
      MAJOR_MINOR: pgis.majorMinor,
    },
  );
  mkdirSync(path.join(directory, 'share/proj'), { recursive: true });
  copyFileSync(
    path.join(dependencies, 'proj/share/proj/proj.db'),
    path.join(directory, 'share/proj/proj.db'),
  );
  appendSubdir(config, 'postgis');
}

const withoutTransactions = (text: string) =>
  text.replaceAll('BEGIN;', '').replaceAll('COMMIT;', '');
const joined = (...texts: string[]) =>
  texts.map((text) => (text.endsWith('\n') ? text : text + '\n')).join('');

export function postgisSql(config: Config, phase: string) {
  const directory = postgisDirectory(config),
    pgis = postgisVersion(directory);
  const pg = path.join(directory, 'postgis'),
    sql = path.join(directory, 'extensions/postgis/sql');
  const raster = path.join(directory, 'raster/rt_pg');
  mkdirSync(sql, { recursive: true });
  if (phase === 'postgis-sql-preprocess') {
    const template = (
      input: string,
      output: string,
      includes: string[],
      module: string,
      strip: boolean,
      removeSchema: boolean,
    ) => {
      let text = preprocessSql(input, includes).replaceAll('MODULE_PATHNAME', module);
      if (strip) text = withoutTransactions(text);
      if (removeSchema) text = text.replaceAll('@extschema@.', '');
      write(output, text);
    };
    template(
      path.join(directory, 'extensions/postgis_extension_helper.sql.in'),
      path.join(directory, 'extensions/postgis_extension_helper.sql'),
      [directory, pg],
      '',
      false,
      false,
    );
    for (const name of ['postgis', 'legacy_minimal', 'legacy', 'legacy_gist']) {
      template(
        path.join(pg, name + '.sql.in'),
        path.join(pg, name + '.sql'),
        [pg],
        '$libdir/postgis-3',
        false,
        true,
      );
    }
    template(
      path.join(pg, 'postgis.sql.in'),
      path.join(sql, 'postgis_for_extension.sql'),
      [pg],
      '$libdir/postgis-3',
      true,
      false,
    );
    write(
      path.join(sql, 'spatial_ref_sys.sql'),
      withoutTransactions(read(path.join(directory, 'spatial_ref_sys.sql'))),
    );
    for (const name of ['rtpostgis', 'rtpostgis_upgrade_cleanup', 'rtpostgis_drop']) {
      template(
        path.join(raster, name + '.sql.in'),
        path.join(raster, name + '.sql'),
        [pg, raster],
        '$libdir/rtpostgis-3',
        false,
        true,
      );
    }
  } else if (phase === 'postgis-sql-upgrade') {
    const upgrade = (body: string) =>
      joined(
        ...[
          path.join(pg, 'common_before_upgrade.sql'),
          path.join(pg, 'postgis_before_upgrade.sql'),
          body,
          path.join(pg, 'postgis_after_upgrade.sql'),
          path.join(pg, 'common_after_upgrade.sql'),
        ].map(read),
      );
    write(
      path.join(pg, 'postgis_upgrade.sql'),
      joined('BEGIN;', upgrade(path.join(pg, 'postgis_upgrade.sql.in')), 'COMMIT;'),
    );
    const extensionUpgrade = withoutTransactions(
      upgrade(path.join(sql, 'postgis_upgrade_for_extension.sql.in')),
    );
    write(path.join(sql, 'postgis_upgrade_for_extension.sql'), extensionUpgrade);
    write(
      path.join(sql, 'postgis_upgrade.sql'),
      extensionUpgrade
        .split(/\r?\n/)
        .flatMap((line) => {
          const drop = line.match(/^(DROP .*);/);
          return drop
            ? [
                `SELECT @extschema@.postgis_extension_drop_if_exists('postgis', '${drop[1]}');`,
                line,
              ]
            : [line];
        })
        .join('\n'),
    );
    write(
      path.join(sql, 'raster_drop_all.sql'),
      joined(
        ...['rtpostgis_upgrade_cleanup.sql', 'rtpostgis_drop.sql', 'uninstall_rtpostgis.sql'].map(
          (file) => read(path.join(raster, file)),
        ),
      ),
    );
  } else if (phase === 'postgis-sql-install') {
    const template = read(
      path.join(directory, 'extensions/postgis/unpackage_raster_if_needed.sql'),
    );
    const marker = template.indexOf('\n', template.indexOf('UNPACKAGE_CODE'));
    assert(
      template.includes('UNPACKAGE_CODE') && marker !== -1,
      'missing raster unpackage insertion marker',
    );
    write(
      path.join(sql, 'raster_unpackage.sql'),
      template.slice(0, marker + 1) +
        joined(read(path.join(sql, 'raster_unpackage_body.sql'))) +
        template.slice(marker + 1),
    );
    const guard = '\\echo Use "CREATE EXTENSION postgis" to load this file. \\quit';
    const joinFiles = (output: string, inputs: string[]) =>
      write(path.join(sql, output), joined(guard, ...inputs.map(read)));
    joinFiles(
      `postgis--${pgis.version}.sql`,
      ['postgis_for_extension.sql', 'spatial_ref_sys_config_dump.sql', 'spatial_ref_sys.sql'].map(
        (file) => path.join(sql, file),
      ),
    );
    joinFiles(`postgis--ANY--${pgis.version}.sql`, [
      path.join(directory, 'extensions/postgis_extension_helper.sql'),
      ...[
        'raster_unpackage.sql',
        'postgis_upgrade.sql',
        'spatial_ref_sys.sql',
        'spatial_ref_sys_config_dump.sql',
      ].map((file) => path.join(sql, file)),
      path.join(directory, 'extensions/postgis_extension_helper_uninstall.sql'),
    ]);
    const tag = `-- Just tag extension postgis version as "ANY"\n-- Installed by postgis ${pgis.version}\n-- Built on ${sourceDate(config)}\n`;
    write(path.join(sql, 'postgis--TEMPLATED--TO--ANY.sql'), tag);
    write(path.join(sql, `postgis--${pgis.version}--ANY.sql`), tag);
    write(path.join(sql, 'postgis--unpackaged.sql'), '-- Nothing to do here\n');
  } else if (phase === 'postgis-sql-unpackaged') {
    const file = path.join(sql, `postgis--unpackaged--${pgis.version}.sql`);
    write(file, joined(read(file), read(path.join(sql, `postgis--ANY--${pgis.version}.sql`))));
  } else throw new Error(`unknown SQL phase ${phase}`);
}

export function pgtap(config: Config, install = false) {
  const directory = path.join(config.work, 'pgtap-windows'),
    sql = path.join(directory, 'sql');
  if (!install) {
    copy(path.join(config.repo, 'target/oliphaunt-sources/checkouts/pgtap'), directory);
    const expandPgtap = (module: string) =>
      read(path.join(sql, 'pgtap.sql.in'))
        .replaceAll('MODULE_PATHNAME', module)
        .replaceAll('__OS__', 'MSWin32')
        .replaceAll('__VERSION__', version(directory, 'pgtap').split('.').slice(0, 2).join('.'));
    write(path.join(sql, 'pgtap.sql'), expandPgtap('pgtap'));
    for (const input of glob(sql, '*.sql.in')) {
      const output = path.join(sql, input.slice(0, -3));
      if (!existsSync(output)) copyFileSync(path.join(sql, input), output);
    }
    write(path.join(sql, 'pgtap-static.sql'), expandPgtap('$libdir/pgtap'));
  } else {
    const release = version(directory, 'pgtap');
    for (const name of ['pgtap', 'pgtap-core', 'pgtap-schema'])
      copyFileSync(path.join(sql, `${name}.sql`), path.join(sql, `${name}--${release}.sql`));
  }
}

if (import.meta.main) {
  const phase = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: Object.fromEntries(
      ['repo', 'work', 'postgres', 'install', 'extension'].map((key) => [key, { type: 'string' }]),
    ),
  });
  for (const key of ['repo', 'work', 'postgres', 'install'])
    assert(typeof values[key] === 'string' && values[key], `missing --${key}`);
  const config = Object.fromEntries(
    ['repo', 'work', 'postgres', 'install'].map((key) => [
      key,
      path.resolve(values[key] as string),
    ]),
  ) as Config;
  switch (phase) {
    case 'simple':
      assert(typeof values.extension === 'string', 'missing --extension');
      prepareSimple(config, values.extension);
      break;
    case 'postgis-config':
      preparePostgis(config);
      break;
    case 'postgis-meson':
      postgisMeson(config);
      break;
    case 'postgis-version':
      console.log(postgisVersion(postgisDirectory(config)).version);
      break;
    case 'postgres-major':
      console.log(
        String(
          Bun.TOML.parse(read(path.join(config.repo, 'third-party/postgres/source.toml')))
            .postgresql.version,
        ).split('.')[0] + '0',
      );
      break;
    case 'postgis-sql-preprocess':
    case 'postgis-sql-upgrade':
    case 'postgis-sql-install':
    case 'postgis-sql-unpackaged':
      postgisSql(config, phase);
      break;
    case 'pgtap':
      pgtap(config);
      break;
    case 'pgtap-install':
      pgtap(config, true);
      break;
    default:
      throw new Error(`unknown Windows extension phase ${phase}`);
  }
}
