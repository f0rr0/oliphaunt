import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compilerFacts,
  configure,
  geosHeaderValues,
  targetSubstitutions,
} from './configure_headers.mts';

const facts = (target: string) =>
  compilerFacts(
    [
      '#define HAVE_POSTGIS_COMPILER_SANITY 1',
      `#define SIZEOF_LONG ${target === 'windows-x64-msvc' ? 4 : 8}`,
      '#define SIZEOF_SIZE_T 8',
      '#define SIZEOF_VOID_P 8',
      '#define EILSEQ 42',
      '#define HAVE_STDINT_H 1',
      '#define HAVE_INTTYPES_H 1',
      '#define HAVE_INLINE 1',
      '#define HAVE_MBSTATE_T 1',
      '#define HAVE_DECLSPEC_THREAD 1',
      '/* #undef HAVE_GETRANDOM */',
      '/* #undef HAVE_UNISTD_H */',
    ].join('\n'),
  );

test('the pinned GEOS C API configures its curve documentation without accepting unknown keys', () => {
  const root = fileURLToPath(new URL('./geos_templates/', import.meta.url));
  const values = geosHeaderValues(
    readFileSync(join(root, 'Version.txt'), 'utf8'),
    readFileSync(join(root, 'capi/CMakeLists.txt'), 'utf8'),
  );
  const header = configure(readFileSync(join(root, 'capi/geos_c.h.in'), 'utf8'), values);
  assert.match(header, /This function does not support curved types directly/u);
  assert.match(header, /This function outputs linear geometry types only/u);
  assert.doesNotMatch(header, /@[A-Z_]+@/u);
  assert.throws(
    () => configure('@UNKNOWN_UPSTREAM_KEY@', values),
    /unconfigured upstream template key/u,
  );
});

test('native and WASIX JSON-C templates duplicate the global locale before calling newlocale', () => {
  const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'json-c-locale-'));
  try {
    for (const [name, script, args] of [
      ['native', './configure_headers.mts', ['--target', 'linux-x64-gnu']],
      ['wasix', '../../wasix/dependencies/configure_headers.mts', []],
    ] as const) {
      const output = join(root, name);
      const result = Bun.spawnSync(
        [
          process.execPath,
          '--no-install',
          '--no-env-file',
          fileURLToPath(new URL(script, import.meta.url)),
          '--kind',
          'json_c',
          '--source',
          fileURLToPath(new URL('./json_c_templates/', import.meta.url)),
          '--output',
          output,
          ...args,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      assert.equal(result.exitCode, 0, result.stderr.toString());
      const header = readFileSync(join(output, 'config.h'), 'utf8');
      assert.match(header, /^#define HAVE_USELOCALE$/mu);
      assert.match(header, /^#define HAVE_DUPLOCALE$/mu);
      assert.match(header, /^\/\* #undef NEWLOCALE_NEEDS_FREELOCALE \*\/$/mu);
    }
    const original = {
      HAVE_USELOCALE: '1',
      HAVE_DUPLOCALE: '1',
      JSON_C_HAVE_INTTYPES_H: '1',
    };
    const apple = targetSubstitutions(original, 'macos-arm64', {
      ...facts('macos-arm64'),
      HAVE_USELOCALE: '1',
      HAVE_DUPLOCALE: '1',
    });
    assert.equal(apple.HAVE_DUPLOCALE, '1');
    assert.equal(apple.NEWLOCALE_NEEDS_FREELOCALE, '1');
    const windows = targetSubstitutions(original, 'windows-x64-msvc', facts('windows-x64-msvc'));
    assert(!Object.hasOwn(windows, 'HAVE_USELOCALE'));
    assert(!Object.hasOwn(windows, 'HAVE_DUPLOCALE'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('foreign substitutions consume explicit facts and retain incorporated dependency policy', () => {
  const before = {
    HAVE_GETRANDOM: '1',
    HAVE_UNISTD_H: '1',
    SIZEOF_LONG: '8',
    HAVE_ICONV: '1',
    HAVE_LIBGEOS_C: '1',
    WITH_ICONV: '1',
    WITH_THREADS: '1',
    MODULE_EXTENSION: '.so',
  };
  for (const target of ['macos-arm64', 'windows-x64-msvc']) {
    const after = targetSubstitutions(before, target, facts(target));
    assert.equal(after.SIZEOF_LONG, target === 'windows-x64-msvc' ? '4' : '8');
    assert(!Object.hasOwn(after, 'HAVE_GETRANDOM'));
    assert(!Object.hasOwn(after, 'HAVE_UNISTD_H'));
    assert.equal(after.HAVE_ICONV, '1');
    assert.equal(after.HAVE_LIBGEOS_C, '1');
    assert.equal(after.WITH_ICONV, '1');
    assert.equal(after.WITH_THREADS, '1');
    assert.equal(after.MODULE_EXTENSION, target === 'macos-arm64' ? '.dylib' : '.dll');
    assert(!Object.hasOwn(after, 'XML_THREAD_LOCAL'), 'TLS policy remains disabled');
    assert.equal(
      configure(
        '#undef HAVE_GETRANDOM\n#cmakedefine01 HAVE_UNISTD_H\n#cmakedefine SIZEOF_LONG @SIZEOF_LONG@\n',
        after,
      ),
      '#undef HAVE_GETRANDOM\n#define HAVE_UNISTD_H 0\n#define SIZEOF_LONG ' +
        after.SIZEOF_LONG +
        '\n',
    );
  }
});

test('Linux returns its qualified profile unchanged and rejects foreign fact injection', () => {
  const before = { HAVE_GETRANDOM: '1', SIZEOF_LONG: '8' };
  for (const target of ['linux-x64-gnu', 'linux-arm64-gnu']) {
    assert.strictEqual(targetSubstitutions(before, target), before);
    assert.throws(
      () => targetSubstitutions(before, target, facts('macos-arm64')),
      /does not consume/u,
    );
  }
});

test('missing sanity, mismatched ABI, unsupported targets and duplicate facts fail closed', () => {
  assert.throws(() => targetSubstitutions({}, 'macos-arm64'), /requires declared/u);
  assert.throws(
    () =>
      targetSubstitutions({}, 'macos-arm64', {
        ...facts('macos-arm64'),
        HAVE_POSTGIS_COMPILER_SANITY: '0',
      }),
    /requires declared/u,
  );
  assert.throws(() => targetSubstitutions({}, 'windows-x64-msvc', facts('macos-arm64')), /ABI/u);
  assert.throws(
    () => targetSubstitutions({}, 'macos-arm64', { ...facts('macos-arm64'), SIZEOF_SIZE_T: '4' }),
    /ABI/u,
  );
  assert.throws(
    () => targetSubstitutions({}, 'ios-xcframework', facts('macos-arm64')),
    /unsupported/u,
  );
  assert.throws(
    () => compilerFacts('#define SIZEOF_LONG 4\n#define SIZEOF_LONG 8\n'),
    /duplicate/u,
  );
});

test('libiconv retains upstream type fallbacks and source-bound EILSEQ; JSON type headers use facts', () => {
  const original = {
    EILSEQ: '84',
    USE_MBSTATE_T: '1',
    SPEC___THREAD: '__thread',
    JSON_C_HAVE_INTTYPES_H: '1',
    JSON_C_HAVE_STDINT_H: '1',
  };
  const selected = facts('windows-x64-msvc');
  const result = targetSubstitutions(original, 'windows-x64-msvc', selected);
  assert.equal(result.EILSEQ, '42');
  assert.equal(result.ssize_t, 'long long');
  assert.equal(result.mode_t, 'int');
  assert.equal(result.USE_MBSTATE_T, '1');
  assert.equal(result.SPEC___THREAD, '__declspec(thread)');
  assert.equal(result.JSON_C_HAVE_STDINT_H, '1');
  assert.throws(
    () => targetSubstitutions(original, 'windows-x64-msvc', { ...selected, EILSEQ: '' }),
    /EILSEQ/u,
  );
});

test('static profiles require the actual target proof and disable mobile XML/runtime features', () => {
  const original = {
    WITH_ICONV: '1',
    WITH_THREADS: '1',
    WITH_MODULES: '1',
    HAVE_LIBDL: '1',
    HAVE_ICONV: '1',
    HAVE_ICONVCTL: '1',
    HAVE_LIBICONVCTL: '1',
    HAVE_LIBGEOS_C: '1',
    MODULE_EXTENSION: '.so',
  };
  for (const target of [
    'android-arm64-v8a',
    'android-x86_64',
    'ios-device',
    'ios-simulator',
    'macos-arm64',
  ]) {
    const proof = `HAVE_POSTGIS_TARGET_${target.toUpperCase().replaceAll('-', '_')}`;
    const selected = { ...facts(target), [proof]: '1' };
    const configured = targetSubstitutions(original, target, selected, 'mobile-static');
    assert.equal(configured.WITH_ICONV, '0');
    assert.equal(configured.WITH_THREADS, '0');
    assert.equal(configured.WITH_MODULES, '0');
    assert(!Object.hasOwn(configured, 'HAVE_LIBDL'));
    assert.equal(configured.HAVE_LIBGEOS_C, '1');
    assert.equal(configured.HAVE_ICONV, target.startsWith('android-') ? '1' : undefined);
    assert.equal(configured.MODULE_EXTENSION, target.startsWith('android-') ? '.so' : '.dylib');
    assert.equal(
      configure(
        '#cmakedefine01 WITH_THREADS\n#cmakedefine WITH_MODULES\n#undef HAVE_LIBDL\n',
        configured,
      ),
      '#define WITH_THREADS 0\n/* #undef WITH_MODULES */\n#undef HAVE_LIBDL\n',
    );
    assert.throws(
      () => targetSubstitutions(original, target, facts(target), 'mobile-static'),
      /do not prove/u,
    );
    assert.throws(
      () => targetSubstitutions(original, target, { ...selected, [proof]: '0' }, 'mobile-static'),
      /do not prove/u,
    );
  }
});

test('mobile and desktop configuration selectors cannot substitute one another', () => {
  assert.throws(
    () => targetSubstitutions({}, 'android-arm64-v8a', facts('macos-arm64')),
    /unsupported/u,
  );
  assert.throws(
    () => targetSubstitutions({}, 'linux-x64-gnu', undefined, 'mobile-static'),
    /unsupported/u,
  );
  assert.throws(
    () => targetSubstitutions({}, 'macos-arm64', facts('macos-arm64'), 'unknown'),
    /unsupported PostGIS profile/u,
  );
});

test('libiconv configures every pinned template with numeric visibility and preserves strict unknown keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'libiconv-template-'));
  try {
    for (const visibility of [undefined, '0', '1']) {
      const expected = visibility ?? '0';
      const selected = {
        ...facts('windows-x64-msvc'),
        ...(visibility === undefined ? {} : { HAVE_VISIBILITY: visibility }),
      };
      const header = join(root, 'facts.h');
      writeFileSync(
        header,
        Object.entries(selected)
          .map(([key, value]) => '#define ' + key + ' ' + value)
          .join('\n'),
      );
      const output = join(root, visibility ?? 'absent');
      const result = Bun.spawnSync(
        [
          process.execPath,
          '--no-install',
          '--no-env-file',
          fileURLToPath(new URL('./configure_headers.mts', import.meta.url)),
          '--kind',
          'libiconv',
          '--source',
          fileURLToPath(new URL('./libiconv_templates/', import.meta.url)),
          '--output',
          output,
          '--target',
          'windows-x64-msvc',
          '--facts',
          header,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      assert.equal(result.exitCode, 0, Buffer.from(result.stderr).toString('utf8').slice(-8000));
      assert.match(
        readFileSync(join(output, 'config.h'), 'utf8'),
        new RegExp('^#define HAVE_VISIBILITY ' + expected + '$', 'mu'),
      );
      for (const name of ['iconv.h', 'localcharset.h', 'libcharset.h']) {
        const configured = readFileSync(join(output, name), 'utf8');
        assert.match(configured, new RegExp('^#if ' + expected + ' && BUILDING_LIB', 'mu'));
        assert.match(configured, /^#elif defined _MSC_VER && BUILDING_LIB/mu);
      }
      for (const name of ['config.h', 'iconv.h', 'localcharset.h', 'libcharset.h'])
        assert.doesNotMatch(
          readFileSync(join(output, name), 'utf8'),
          /@[A-Za-z_][A-Za-z_0-9]*@|\$\{[A-Za-z_][A-Za-z_0-9]*\}/u,
        );
    }
    assert.throws(
      () => configure('@UNKNOWN_UPSTREAM_KEY@', {}),
      /unconfigured upstream template key UNKNOWN_UPSTREAM_KEY/u,
    );
    assert.equal(configure('#undef HAVE_UNAVAILABLE\n', {}), '#undef HAVE_UNAVAILABLE\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
