/** Bounded WASIX wasm32 LP32 configuration over the pinned upstream templates. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { configure, geosHeaderValues } from '../../extensions/postgis/configure_headers.mts';

type Values = Record<string, string>;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const read = (file: string): string => utf8.decode(readFileSync(file));
const enabled = (names: string): Values =>
  Object.fromEntries(
    names
      .split(' ')
      .filter(Boolean)
      .map((name) => [name, '1']),
  );

export function generateWasixHeaders({
  kind,
  source,
  output,
  identity,
}: {
  kind: string;
  source: string;
  output: string;
  identity?: string;
}) {
  source = resolve(source);
  output = resolve(output);
  const emit = (input: string, member: string, values: Values) => {
    const destination = join(output, member);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, configure(read(join(source, input)), values));
  };

  if (kind === 'json_c') {
    const version = /project\(json-c LANGUAGES C VERSION ([0-9]+)\.([0-9]+)\)/u.exec(
      read(join(source, 'CMakeLists.txt')),
    );
    assert(version, 'Review pinned json-c upstream version syntax');
    // The selected WASIX ehpic driver supplies process-clock emulation.
    // JSON's optional threading and x86 RDRAND remain disabled.
    const values = {
      ...enabled(
        'HAVE_DLFCN_H HAVE_ENDIAN_H HAVE_FCNTL_H HAVE_INTTYPES_H HAVE_LIMITS_H HAVE_LOCALE_H HAVE_MEMORY_H HAVE_STDARG_H HAVE_STDINT_H HAVE_STDLIB_H HAVE_STRINGS_H HAVE_STRING_H HAVE_SYSLOG_H HAVE_SYS_CDEFS_H HAVE_SYS_PARAM_H HAVE_SYS_RANDOM_H HAVE_SYS_RESOURCE_H HAVE_SYS_STAT_H HAVE_SYS_TYPES_H HAVE_UNISTD_H HAVE_ATOMIC_BUILTINS HAVE_DECL_INFINITY HAVE_DECL_ISINF HAVE_DECL_ISNAN HAVE_DECL_NAN HAVE_OPEN HAVE_REALLOC HAVE_SETLOCALE HAVE_SNPRINTF HAVE_STRCASECMP HAVE_STRDUP HAVE_STRERROR HAVE_STRNCASECMP HAVE_USELOCALE HAVE_DUPLOCALE HAVE_VASPRINTF HAVE_VPRINTF HAVE_VSNPRINTF HAVE_VSYSLOG HAVE_GETRANDOM HAVE_GETRUSAGE HAVE_STRTOLL HAVE_STRTOULL HAVE___THREAD JSON_C_HAVE_INTTYPES_H JSON_C_HAVE_STDINT_H STDC_HEADERS',
      ),
      PROJECT_NAME: 'json-c',
      JSON_C_BUGREPORT: 'json-c@googlegroups.com',
      CPACK_PACKAGE_VERSION_MAJOR: version[1],
      CPACK_PACKAGE_VERSION_MINOR: version[2],
      CPACK_PACKAGE_VERSION_PATCH: '0',
      SIZEOF_INT: '4',
      SIZEOF_INT64_T: '8',
      SIZEOF_LONG: '4',
      SIZEOF_LONG_LONG: '8',
      SIZEOF_SIZE_T: '4',
      SIZEOF_SSIZE_T: '4',
      SPEC___THREAD: '__thread',
      json_c_strtoll: 'strtoll',
      json_c_strtoull: 'strtoull',
      JSON_H_JSON_POINTER: '#include "json_pointer.h"',
      JSON_H_JSON_PATCH: '#include "json_patch.h"',
    };
    emit('cmake/config.h.in', 'config.h', values);
    emit('cmake/json_config.h.in', 'json_config.h', values);
    emit('json.h.cmakein', 'json.h', values);
  } else if (kind === 'libxml2') {
    const version = read(join(source, 'VERSION')).trim();
    assert.match(version, /^\d+\.\d+\.\d+$/u, 'Invalid pinned libxml2 VERSION');
    const [major, minor, patch] = version.split('.').map(Number);
    const values = {
      ...enabled(
        'HAVE_DECL_GETENTROPY HAVE_DECL_GLOB HAVE_FUNC_ATTRIBUTE_DESTRUCTOR HAVE_POLL_H HAVE_STDINT_H WITH_C14N WITH_CATALOG WITH_DEBUG WITH_HTML WITH_ISO8859X WITH_OUTPUT WITH_PATTERN WITH_PUSH WITH_READER WITH_REGEXPS WITH_RELAXNG WITH_SAX1 WITH_SCHEMAS WITH_SCHEMATRON WITH_VALID WITH_WRITER WITH_XINCLUDE WITH_XPATH WITH_XPTR',
      ),
      // The selected WASIX ehpic driver supplies mmap emulation. Canonical
      // XML disables threads, modules, iconv, HTTP and compressed input.
      HAVE_DECL_MMAP: '1',
      VERSION: version,
      LIBXML_VERSION_NUMBER: String(major * 10000 + minor * 100 + patch),
      LIBXML_VERSION_EXTRA: '',
      MODULE_EXTENSION: '.so',
      XML_SYSCONFDIR: '/oliphaunt/runtime/etc',
      WITH_THREADS: '0',
      WITH_THREAD_ALLOC: '0',
      WITH_MODULES: '0',
      WITH_ICONV: '0',
      WITH_HTTP: '0',
      WITH_ICU: '0',
      WITH_LZMA: '0',
      WITH_ZLIB: '0',
    };
    emit('config.h.cmake.in', 'config.h', values);
    emit('include/libxml/xmlversion.h.in', 'libxml/xmlversion.h', values);
  } else if (kind === 'libiconv') {
    const values = {
      ...enabled(
        'HAVE_GETC_UNLOCKED HAVE_LANGINFO_CODESET HAVE_MBRTOWC HAVE_SETLOCALE HAVE_STDDEF_H HAVE_STDLIB_H HAVE_STRING_H HAVE_VISIBILITY HAVE_WCRTOMB HAVE_WORKING_O_NOFOLLOW WORDS_LITTLEENDIAN HAVE_STDIO_H HAVE_STRINGS_H HAVE_SYS_STAT_H HAVE_SYS_TYPES_H HAVE_UNISTD_H HAVE_INTTYPES_H HAVE_STDINT_H',
      ),
      DLL_VARIABLE: '',
      ICONV_CONST: '',
      // iconv.h includes errno.h first. Preserve the selected WASI sysroot's
      // exact ABI symbol (__errno_values.h), rather than a Linux errno number.
      EILSEQ: '__WASI_ERRNO_ILSEQ',
      USE_MBSTATE_T: '1',
      BROKEN_WCHAR_H: '0',
      INSTALLPREFIX: '"/oliphaunt/runtime"',
      prefix: '/oliphaunt/runtime',
    };
    emit('lib/config.h.in', 'config.h', values);
    emit('include/iconv.h.build.in', 'iconv.h', values);
    emit('libcharset/include/localcharset.h.build.in', 'localcharset.h', values);
    emit('libcharset/include/libcharset.h.build.in', 'libcharset.h', values);
  } else if (kind === 'proj') {
    // Canonical WASIX PROJ has no libdl, TIFF, curl or Emscripten fetch.
    emit('cmake/proj_config.cmake.in', 'proj_config.h', enabled('HAVE_LOCALECONV HAVE_STRERROR'));
  } else if (kind === 'geos') {
    const values = geosHeaderValues(
      read(join(source, 'Version.txt')),
      read(join(source, 'capi/CMakeLists.txt')),
    );
    emit('include/geos/version.h.in', 'geos/version.h', values);
    emit('capi/geos_c.h.in', 'geos_c.h', values);
  } else if (kind === 'postgis') {
    assert(identity, 'PostGIS configuration requires declared --identity');
    const facts = JSON.parse(read(identity)) as {
      commit: string;
      source_date_epoch: number;
      default_version: string;
      postgres_major: number;
      postgres_version: string;
      dependencies: Record<string, { branch: string }>;
    };
    const version = Object.fromEntries(
      [...read(join(source, 'Version.config')).matchAll(/^(\w+)=(.*)$/gmu)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    const major = version.POSTGIS_MAJOR_VERSION;
    const minor = version.POSTGIS_MINOR_VERSION;
    const micro = version.POSTGIS_MICRO_VERSION;
    const fullVersion = `${major}.${minor}.${micro}`;
    assert(
      fullVersion === facts.default_version &&
        facts.postgres_major === 18 &&
        /^[a-f0-9]{40}$/u.test(facts.commit),
      'PostGIS source/configuration disagrees with canonical identity',
    );
    const dependencyVersion = (name: string) => {
      const value = facts.dependencies[name].branch.replace(/^v/u, '');
      assert.match(value, /^\d+\.\d+\.\d+$/u, `Invalid pinned ${name} version`);
      return value;
    };
    const number = (value: string) =>
      value
        .split('.')
        .map((part, index) => (index ? part.padStart(2, '0') : part))
        .join('');
    const date = new Date(facts.source_date_epoch * 1000);
    assert(
      Number.isSafeInteger(facts.source_date_epoch) &&
        facts.source_date_epoch > 0 &&
        !Number.isNaN(date.valueOf()),
      'Invalid canonical PostGIS build epoch',
    );
    const displayVersion = `${major}.${minor} USE_GEOS=1 USE_PROJ=1 USE_STATS=1`;
    const values = {
      ...enabled(
        'HAVE_FSEEKO HAVE_ICONV HAVE_ICONVCTL HAVE_LIBGEOS_C HAVE_LIBICONVCTL HAVE_LIBJSON HAVE_LIBPROJ HAVE_LIBXML2 HAVE_LIBXML_PARSER_H HAVE_LIBXML_TREE_H HAVE_LIBXML_XPATHINTERNALS_H HAVE_LIBXML_XPATH_H HAVE_UNISTD_H STDC_HEADERS YYTEXT_POINTER',
      ),
      POSTGIS_LIB_VERSION: fullVersion,
      POSTGIS_MAJOR_VERSION: major,
      POSTGIS_MINOR_VERSION: minor,
      POSTGIS_MICRO_VERSION: micro,
      POSTGIS_GEOS_VERSION: number(dependencyVersion('geos')),
      POSTGIS_GDAL_VERSION: number(dependencyVersion('gdal')),
      POSTGIS_PROJ_VERSION: number(dependencyVersion('proj')),
      POSTGIS_LIBXML2_VERSION: dependencyVersion('libxml2'),
      POSTGIS_SFCGAL_VERSION: '0',
      POSTGIS_PGSQL_VERSION: '180',
      POSTGIS_PGSQL_HR_VERSION: facts.postgres_version,
      POSTGIS_VERSION: displayVersion,
      POSTGIS_BUILD_DATE: date.toISOString().slice(0, 19).replace('T', ' '),
      POSTGIS_SCRIPTS_VERSION: fullVersion,
      SRID_MAX: '999999',
      SRID_USR_MAX: '998999',
      EXTVERSION: fullVersion,
      EXTENSION: 'postgis',
      MODULEPATH: '$libdir/postgis-3',
    };
    const quoted = {
      ...values,
      POSTGIS_LIB_VERSION: JSON.stringify(fullVersion),
      POSTGIS_LIBXML2_VERSION: JSON.stringify(values.POSTGIS_LIBXML2_VERSION),
      POSTGIS_VERSION: JSON.stringify(displayVersion),
      POSTGIS_BUILD_DATE: JSON.stringify(values.POSTGIS_BUILD_DATE),
      POSTGIS_SCRIPTS_VERSION: JSON.stringify(fullVersion),
      PGSQL_LOCALEDIR: '"/oliphaunt/runtime/share/locale"',
      LT_OBJDIR: '".libs/"',
    };
    emit('postgis_config.h.in', 'postgis_config.h', quoted);
    emit('liblwgeom/liblwgeom.h.in', 'liblwgeom/liblwgeom.h', values);
    emit('postgis/sqldefines.h.in', 'postgis/sqldefines.h', values);
    emit('raster/raster_config.h.in', 'raster/rt_core/raster_config.h', values);
    emit('extensions/postgis/postgis.control.in', 'extensions/postgis/postgis.control', values);
    for (const member of ['postgis_raster', 'postgis_topology', 'postgis_tiger_geocoder']) {
      emit(`extensions/${member}/${member}.control.in`, `extensions/${member}/${member}.control`, {
        ...values,
        EXTENSION: member,
        MODULEPATH: `$libdir/${member}-${major}`,
      });
    }
    writeFileSync(join(output, 'postgis_revision.h'), `#define POSTGIS_REVISION ${facts.commit}\n`);
  } else {
    throw new Error(`Unknown WASIX configuration ${kind}`);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      kind: { type: 'string' },
      source: { type: 'string' },
      output: { type: 'string' },
      identity: { type: 'string' },
    },
  });
  assert(values.kind && values.source && values.output, 'Expected --kind --source --output');
  generateWasixHeaders({
    kind: values.kind,
    source: values.source,
    output: values.output,
    identity: values.identity,
  });
}
