import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// rules_cc_autoconf 0.24.0 preserves JSON value types in compile_defines:
// https://github.com/periareon/rules_cc_autoconf/blob/0.24.0/autoconf/private/checker/check.cc
// A real checker AC_DEFINE -> dependency -> AC_CHECK_SIZEOF round trip with
// /D_CRT_SECURE_NO_DEPRECATE and /WX rejected string "1" on clang-cl; integer
// 1 computed sizeof(long)=4. GCC and Clang computed 8 with the integer value.
// The host ABI contract and Windows CI also require the actual SDK probes.
const source = readFileSync(new URL('./host_config.bzl', import.meta.url), 'utf8');

function featureSwitchValue(policy: string): unknown {
  const declaration = /checks\.AC_DEFINE\(d,\s*([^\n)]+)\)\s+for d in definitions\s*\+/u.exec(
    policy,
  );
  const value = declaration?.[1];
  if (!value) throw new Error('host feature-switch AC_DEFINE declaration is missing');
  return JSON.parse(value);
}

test('host probe feature switches use numeric one, matching compiler /D definitions', () => {
  expect(featureSwitchValue(source)).toBe(1);
  // Preserve the regression's distinguishing case: JSON/C string "1" is
  // different from numeric 1 even though both may look like enabled flags.
  const stringSwitches = source.replace(/checks\.AC_DEFINE\(d,\s*1\)/u, 'checks.AC_DEFINE(d, "1")');
  expect(featureSwitchValue(stringSwitches)).not.toBe(1);
});
