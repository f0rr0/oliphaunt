/** Canonical upstream templates, with declared compiler facts for foreign hosts. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

type Values = Record<string, string>;
const targets = new Set(['linux-x64-gnu', 'linux-arm64-gnu', 'macos-arm64', 'windows-x64-msvc']);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function read(path: string): string {
  return utf8.decode(readFileSync(path));
}

export function configure(template: string, values: Values): string {
  let configured = template.replace(/^#undef (\w+)$/gmu, (line, key: string) =>
    values[key] === undefined ? line : `#define ${key} ${values[key]}`,
  );
  configured = configured.replace(
    /^#cmakedefine(01)?\s+(\w+)([^\n]*)$/gmu,
    (_line, numeric: string | undefined, key: string, tail: string) => {
      const enabled = values[key] !== undefined && !['0', '', 'OFF', 'FALSE'].includes(values[key]);
      if (numeric) return `#define ${key} ${enabled ? '1' : '0'}`;
      return enabled ? `#define ${key}${tail}` : `/* #undef ${key} */`;
    },
  );
  configured = configured.replace(
    /@([A-Za-z_][A-Za-z_0-9]*)@|\$\{([A-Za-z_][A-Za-z_0-9]*)\}/gu,
    (_token, at: string | undefined, dollar: string | undefined) => {
      const key = at ?? dollar ?? '';
      if (values[key] === undefined) throw new Error(`unconfigured upstream template key ${key}`);
      return values[key];
    },
  );
  if (configured.includes('@@')) throw new Error('unconfigured anonymous upstream template token');
  return configured;
}

function enabled(names: string): Values {
  return Object.fromEntries(
    names
      .split(' ')
      .filter(Boolean)
      .map((key) => [key, '1']),
  );
}

/** Only the maintained checker's explicit defines become template substitutions. */
export function compilerFacts(header: string): Values {
  const result: Values = {};
  for (const line of header.split(/\r?\n/u)) {
    const match = /^#define ([A-Z][A-Z_0-9]*) (.+)$/u.exec(line);
    if (!match) continue;
    if (Object.hasOwn(result, match[1])) throw new Error(`duplicate compiler fact ${match[1]}`);
    result[match[1]] = match[2];
  }
  return result;
}

export function targetSubstitutions(original: Values, target: string, facts?: Values): Values {
  if (!targets.has(target)) throw new Error(`unsupported PostGIS configuration target ${target}`);
  if (target.startsWith('linux-')) {
    if (facts) throw new Error('the qualified Linux profile does not consume foreign facts');
    return original;
  }
  if (
    !facts ||
    facts.HAVE_POSTGIS_COMPILER_SANITY !== '1' ||
    !facts.SIZEOF_LONG ||
    !facts.SIZEOF_SIZE_T ||
    !facts.SIZEOF_VOID_P
  )
    throw new Error('foreign PostGIS configuration requires declared compiler facts');
  const expectedLong = target === 'windows-x64-msvc' ? '4' : '8';
  if (
    facts.SIZEOF_LONG !== expectedLong ||
    facts.SIZEOF_SIZE_T !== '8' ||
    facts.SIZEOF_VOID_P !== '8'
  )
    throw new Error(`compiler facts disagree with ${target} ABI`);
  const result = { ...original };
  for (const key of Object.keys(result)) {
    if (key.startsWith('HAVE_') || key.startsWith('SIZEOF_')) delete result[key];
  }
  Object.assign(result, facts);
  if (Object.hasOwn(original, 'JSON_C_HAVE_INTTYPES_H'))
    result.JSON_C_HAVE_INTTYPES_H = facts.HAVE_INTTYPES_H ?? '0';
  if (Object.hasOwn(original, 'JSON_C_HAVE_STDINT_H'))
    result.JSON_C_HAVE_STDINT_H = facts.HAVE_STDINT_H ?? '0';
  // These facts describe the declared dependency graph, rather than libc probes.
  for (const key of Object.keys(original)) {
    if (
      /^HAVE_(?:ICONV(?:CTL)?|LIB(?:GEOS_C|ICONVCTL|JSON|PROJ|XML2|XML_(?:PARSER|TREE|XPATHINTERNALS|XPATH)_H))$/u.test(
        key,
      )
    )
      result[key] = original[key];
  }
  if (Object.hasOwn(result, 'SPEC___THREAD')) {
    result.SPEC___THREAD = facts.HAVE___THREAD ? '__thread' : '__declspec(thread)';
    if (!facts.HAVE___THREAD && !facts.HAVE_DECLSPEC_THREAD) delete result.SPEC___THREAD;
  }
  if (Object.hasOwn(result, 'EILSEQ')) {
    if (!facts.EILSEQ) throw new Error('libiconv requires compiler-derived EILSEQ');
    result.EILSEQ = facts.EILSEQ;
    result.USE_MBSTATE_T = facts.HAVE_MBSTATE_T ? '1' : '0';
    if (!facts.HAVE_INLINE) {
      if (!facts.HAVE___INLINE) throw new Error('libiconv requires a supported inline spelling');
      result.inline = '__inline';
    }
    if (!facts.HAVE_MODE_T) result.mode_t = 'int';
    // srcm4/ssize_t.m4 uses long long for the selected _WIN64 profile.
    if (!facts.HAVE_SSIZE_T) result.ssize_t = 'long long';
  }
  if (Object.hasOwn(result, 'MODULE_EXTENSION'))
    result.MODULE_EXTENSION = target === 'macos-arm64' ? '.dylib' : '.dll';
  return result;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      kind: { type: 'string' },
      source: { type: 'string' },
      output: { type: 'string' },
      identity: { type: 'string' },
      target: { type: 'string', default: 'linux-x64-gnu' },
      facts: { type: 'string' },
    },
  });
  if (!values.kind || !values.source || !values.output)
    throw new Error('expected --kind --source --output');
  const source = resolve(values.source);
  const output = resolve(values.output);
  const facts = values.facts ? compilerFacts(read(values.facts)) : undefined;
  const emit = (input: string, path: string, substitutions: Values): void => {
    const destination = join(output, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      configure(
        read(join(source, input)),
        targetSubstitutions(substitutions, values.target, facts),
      ),
    );
  };
  if (values.kind === 'geos') {
    const version = Object.fromEntries(
      [...read(join(source, 'Version.txt')).matchAll(/^(\w+)=(.*)$/gmu)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    const major = version.GEOS_VERSION_MAJOR;
    const minor = version.GEOS_VERSION_MINOR;
    const patch = version.GEOS_VERSION_PATCH;
    const apiMajor = Number(version.CAPI_INTERFACE_CURRENT) - Number(version.CAPI_INTERFACE_AGE);
    if (!major || !minor || !patch || !Number.isInteger(apiMajor))
      throw new Error('invalid GEOS upstream Version.txt');
    const substitutions = {
      VERSION_MAJOR: major,
      VERSION_MINOR: minor,
      VERSION_PATCH: patch,
      VERSION: `${major}.${minor}.${patch}${version.GEOS_PATCH_WORD ?? ''}`,
      JTS_PORT: version.JTS_PORT,
      CAPI_VERSION_MAJOR: String(apiMajor),
      CAPI_VERSION_MINOR: version.CAPI_INTERFACE_AGE,
      CAPI_VERSION_PATCH: version.CAPI_INTERFACE_REVISION,
      CAPI_VERSION: `${apiMajor}.${version.CAPI_INTERFACE_AGE}.${version.CAPI_INTERFACE_REVISION}`,
    };
    emit('include/geos/version.h.in', 'geos/version.h', substitutions);
    emit('capi/geos_c.h.in', 'geos_c.h', substitutions);
  } else if (values.kind === 'json_c') {
    const cmake = read(join(source, 'CMakeLists.txt'));
    const version = /project\(json-c LANGUAGES C VERSION ([0-9]+)\.([0-9]+)\)/u.exec(cmake);
    if (!version) throw new Error('review json-c upstream version syntax');
    const substitutions = {
      ...enabled(
        'HAVE_DLFCN_H HAVE_ENDIAN_H HAVE_FCNTL_H HAVE_INTTYPES_H HAVE_LIMITS_H HAVE_LOCALE_H HAVE_MEMORY_H HAVE_STDARG_H HAVE_STDINT_H HAVE_STDLIB_H HAVE_STRINGS_H HAVE_STRING_H HAVE_SYSLOG_H HAVE_SYS_CDEFS_H HAVE_SYS_PARAM_H HAVE_SYS_RANDOM_H HAVE_SYS_RESOURCE_H HAVE_SYS_STAT_H HAVE_SYS_TYPES_H HAVE_UNISTD_H HAVE_ATOMIC_BUILTINS HAVE_DECL_INFINITY HAVE_DECL_ISINF HAVE_DECL_ISNAN HAVE_DECL_NAN HAVE_OPEN HAVE_REALLOC HAVE_SETLOCALE HAVE_SNPRINTF HAVE_STRCASECMP HAVE_STRDUP HAVE_STRERROR HAVE_STRNCASECMP HAVE_USELOCALE HAVE_VASPRINTF HAVE_VPRINTF HAVE_VSNPRINTF HAVE_VSYSLOG HAVE_GETRANDOM HAVE_GETRUSAGE HAVE_STRTOLL HAVE_STRTOULL HAVE___THREAD JSON_C_HAVE_INTTYPES_H JSON_C_HAVE_STDINT_H STDC_HEADERS',
      ),
      PROJECT_NAME: 'json-c',
      JSON_C_BUGREPORT: 'json-c@googlegroups.com',
      CPACK_PACKAGE_VERSION_MAJOR: version[1],
      CPACK_PACKAGE_VERSION_MINOR: version[2],
      CPACK_PACKAGE_VERSION_PATCH: '0',
      SIZEOF_INT: '4',
      SIZEOF_INT64_T: '8',
      SIZEOF_LONG: '8',
      SIZEOF_LONG_LONG: '8',
      SIZEOF_SIZE_T: '8',
      SIZEOF_SSIZE_T: '8',
      SPEC___THREAD: '__thread',
      json_c_strtoll: 'strtoll',
      json_c_strtoull: 'strtoull',
      JSON_H_JSON_POINTER: '#include "json_pointer.h"',
      JSON_H_JSON_PATCH: '#include "json_patch.h"',
    };
    emit('cmake/config.h.in', 'config.h', substitutions);
    emit('cmake/json_config.h.in', 'json_config.h', substitutions);
    emit('json.h.cmakein', 'json.h', substitutions);
  } else if (values.kind === 'libxml2') {
    const version = read(join(source, 'VERSION')).trim();
    const parts = version.split('.').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part)))
      throw new Error('invalid libxml2 VERSION');
    const substitutions = {
      ...enabled(
        'HAVE_DECL_GETENTROPY HAVE_DECL_GLOB HAVE_DECL_MMAP HAVE_FUNC_ATTRIBUTE_DESTRUCTOR HAVE_DLOPEN HAVE_POLL_H HAVE_STDINT_H WITH_C14N WITH_CATALOG WITH_DEBUG WITH_HTML WITH_ICONV WITH_ISO8859X WITH_MODULES WITH_OUTPUT WITH_PATTERN WITH_PUSH WITH_READER WITH_REGEXPS WITH_RELAXNG WITH_SAX1 WITH_SCHEMAS WITH_SCHEMATRON WITH_THREADS WITH_VALID WITH_WRITER WITH_XINCLUDE WITH_XPATH WITH_XPTR',
      ),
      VERSION: version,
      LIBXML_VERSION_NUMBER: String(parts[0] * 10000 + parts[1] * 100 + parts[2]),
      LIBXML_VERSION_EXTRA: '',
      MODULE_EXTENSION: '.so',
      XML_SYSCONFDIR: '/oliphaunt/runtime/etc',
      WITH_HTTP: '0',
      WITH_ICU: '0',
      WITH_LZMA: '0',
      WITH_THREAD_ALLOC: '0',
      WITH_ZLIB: '0',
    };
    emit('config.h.cmake.in', 'config.h', substitutions);
    emit('include/libxml/xmlversion.h.in', 'libxml/xmlversion.h', substitutions);
  } else if (values.kind === 'proj') {
    emit(
      'cmake/proj_config.cmake.in',
      'proj_config.h',
      enabled('HAVE_LIBDL HAVE_LOCALECONV HAVE_STRERROR'),
    );
  } else if (values.kind === 'libiconv') {
    const substitutions = {
      ...enabled(
        'HAVE_GETC_UNLOCKED HAVE_LANGINFO_CODESET HAVE_MBRTOWC HAVE_SETLOCALE HAVE_STDDEF_H HAVE_STDLIB_H HAVE_STRING_H HAVE_VISIBILITY HAVE_WCRTOMB HAVE_WORKING_O_NOFOLLOW WORDS_LITTLEENDIAN HAVE_STDIO_H HAVE_STRINGS_H HAVE_SYS_STAT_H HAVE_SYS_TYPES_H HAVE_UNISTD_H HAVE_INTTYPES_H HAVE_STDINT_H',
      ),
      DLL_VARIABLE: '',
      ICONV_CONST: '',
      EILSEQ: '84',
      USE_MBSTATE_T: '1',
      BROKEN_WCHAR_H: '0',
      INSTALLPREFIX: '"/oliphaunt/runtime"',
      prefix: '/oliphaunt/runtime',
    };
    emit('lib/config.h.in', 'config.h', substitutions);
    emit('include/iconv.h.build.in', 'iconv.h', substitutions);
    emit('libcharset/include/localcharset.h.build.in', 'localcharset.h', substitutions);
    emit('libcharset/include/libcharset.h.build.in', 'libcharset.h', substitutions);
  } else if (values.kind === 'postgis') {
    if (!values.identity) throw new Error('PostGIS configuration requires declared --identity');
    const identity = JSON.parse(read(values.identity)) as {
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
    if (
      fullVersion !== identity.default_version ||
      identity.postgres_major !== 18 ||
      !/^[0-9a-f]{40}$/u.test(identity.commit)
    ) {
      throw new Error('PostGIS source/configuration disagrees with canonical identity');
    }
    const dependencyVersion = (name: string): string => {
      const value = identity.dependencies[name].branch.replace(/^v/u, '');
      if (!/^\d+\.\d+\.\d+$/u.test(value)) throw new Error(`invalid pinned ${name} version`);
      return value;
    };
    const number = (value: string): string =>
      value
        .split('.')
        .map((part, index) => (index ? part.padStart(2, '0') : part))
        .join('');
    const date = new Date(identity.source_date_epoch * 1000);
    if (
      !Number.isSafeInteger(identity.source_date_epoch) ||
      identity.source_date_epoch <= 0 ||
      Number.isNaN(date.valueOf())
    )
      throw new Error('invalid canonical PostGIS build epoch');
    const buildDate = date.toISOString().slice(0, 19).replace('T', ' ');
    const displayVersion = `${major}.${minor} USE_GEOS=1 USE_PROJ=1 USE_STATS=1`;
    const substitutions = {
      ...enabled(
        'HAVE_FSEEKO HAVE_ICONV HAVE_ICONVCTL HAVE_LIBGEOS_C HAVE_LIBICONVCTL HAVE_LIBJSON HAVE_LIBPROJ HAVE_LIBXML2 HAVE_LIBXML_PARSER_H HAVE_LIBXML_TREE_H HAVE_LIBXML_XPATHINTERNALS_H HAVE_LIBXML_XPATH_H HAVE_UNISTD_H STDC_HEADERS YYTEXT_POINTER',
      ),
      POSTGIS_LIB_VERSION: fullVersion,
      POSTGIS_MAJOR_VERSION: major,
      POSTGIS_MINOR_VERSION: minor,
      POSTGIS_MICRO_VERSION: micro,
      POSTGIS_GEOS_VERSION: number(dependencyVersion('geos')),
      POSTGIS_PROJ_VERSION: number(dependencyVersion('proj')),
      POSTGIS_LIBXML2_VERSION: dependencyVersion('libxml2'),
      POSTGIS_SFCGAL_VERSION: '0',
      POSTGIS_PGSQL_VERSION: '180',
      POSTGIS_PGSQL_HR_VERSION: identity.postgres_version,
      POSTGIS_VERSION: displayVersion,
      POSTGIS_BUILD_DATE: buildDate,
      POSTGIS_SCRIPTS_VERSION: fullVersion,
      SRID_MAX: '999999',
      SRID_USR_MAX: '998999',
      EXTVERSION: fullVersion,
      EXTENSION: 'postgis',
      MODULEPATH: '$libdir/postgis-3',
    };
    const quoted = {
      ...substitutions,
      POSTGIS_LIB_VERSION: JSON.stringify(fullVersion),
      POSTGIS_LIBXML2_VERSION: JSON.stringify(substitutions.POSTGIS_LIBXML2_VERSION),
      POSTGIS_VERSION: JSON.stringify(displayVersion),
      POSTGIS_BUILD_DATE: JSON.stringify(buildDate),
      POSTGIS_SCRIPTS_VERSION: JSON.stringify(fullVersion),
      PGSQL_LOCALEDIR: '"/oliphaunt/runtime/share/locale"',
      LT_OBJDIR: '".libs/"',
    };
    emit('postgis_config.h.in', 'postgis_config.h', quoted);
    emit('liblwgeom/liblwgeom.h.in', 'liblwgeom/liblwgeom.h', substitutions);
    emit('postgis/sqldefines.h.in', 'postgis/sqldefines.h', substitutions);
    emit(
      'extensions/postgis/postgis.control.in',
      'extensions/postgis/postgis.control',
      substitutions,
    );
    writeFileSync(
      join(output, 'postgis_revision.h'),
      `#define POSTGIS_REVISION ${identity.commit}\n`,
    );
  } else {
    throw new Error(`unknown configuration ${values.kind}`);
  }
}
