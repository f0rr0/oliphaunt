import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { compilerFacts, configure, targetSubstitutions } from './configure_headers.mts';

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
