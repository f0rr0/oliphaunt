import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectPlatformBinaryBuffer } from '../../tools/packaging/platform-binary-contract.mts';

const [arm64, x64, nm, header] = process.argv.slice(2);
assert(
  arm64 && x64 && nm && header,
  'expected two actual Android runtimes, declared nm and public C header',
);
const publicFunctions = [
  ...readFileSync(header, 'utf8').matchAll(/^OLIPHAUNT_API\s+[^;]+?\b(oliphaunt_\w+)\s*\(/gmu),
].map((match) => match[1]!);
assert(publicFunctions.length > 0, 'public header has no exported ABI functions');

function symbols(library: string, options: string[]) {
  const result = Bun.spawnSync([nm!, ...options, library], {
    env: { PATH: '/nonexistent', LANG: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(
    result.exitCode,
    0,
    `${library}: declared llvm-nm failed: ${result.stderr.toString()}`,
  );
  return result.stdout.toString();
}

for (const [library, target] of [
  [arm64, 'android-arm64-v8a'],
  [x64, 'android-x86_64'],
] as const) {
  const bytes = readFileSync(library!);
  inspectPlatformBinaryBuffer(bytes, { target, label: library });

  // A malformed copy of an actual runtime verifies the publication validator
  // against the native producer, rather than only against synthetic ELF data.
  const offset = Number(bytes.readBigUInt64LE(32));
  const entrySize = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  const malformed = Buffer.from(bytes);
  let altered = false;
  for (let index = 0; index < count; index++) {
    const entry = offset + entrySize * index;
    if (bytes.readUInt32LE(entry) !== 1) continue;
    malformed.writeBigUInt64LE(4096n, entry + 48);
    altered = true;
    break;
  }
  assert(altered, `${target}: no loadable ELF segment`);
  assert.throws(
    () => inspectPlatformBinaryBuffer(malformed, { target, label: library }),
    /PT_LOAD alignment/u,
  );

  const exports = new Set(
    symbols(library!, ['--dynamic', '--defined-only'])
      .split('\n')
      .map((line) => line.trim().split(/\s+/u).at(-1)),
  );
  for (const name of publicFunctions)
    assert(exports.has(name), `${target}: missing public C ABI ${name}`);
  for (const name of [
    'oliphaunt_builtin_dict_snowball_Pg_magic_func',
    'dsnowball_init',
    'pg_finfo_dsnowball_init',
    'dsnowball_lexize',
    'pg_finfo_dsnowball_lexize',
  ]) {
    assert(exports.has(name), `${target}: missing builtin Snowball ${name}`);
  }
  assert(
    [...exports].some((name) => /^ucol_open(?:_\d+)?$/u.test(name ?? '')),
    `${target}: missing actual linked ICU collation implementation`,
  );
  assert(
    !exports.has('pg_register_static_icu_data'),
    `${target}: embeds an alternate ICU data registration implementation`,
  );

  const defined = symbols(library!, ['--defined-only', '--print-size']);
  for (const line of defined.split('\n')) {
    const match = line.match(/^\s*[a-f0-9]+\s+([a-f0-9]+)\s+\w\s+(icudt\d+[a-z]*_dat)$/iu);
    if (match)
      assert(
        Number.parseInt(match[1]!, 16) <= 4096,
        `${target}: ${match[2]} embeds ICU data rather than the declared external resource`,
      );
  }
  const imports = symbols(library!, ['--dynamic', '--undefined-only'])
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).at(-1)?.split('@')[0]);
  const forbidden = imports.find((name) =>
    /^(?:shm(?:get|ctl|dt|at)|shm_open|sem(?:get|ctl|op|open|close|unlink|wait|post|trywait|timedwait|init|destroy))$/u.test(
      name ?? '',
    ),
  );
  assert.equal(
    forbidden,
    undefined,
    `${target}: imports mobile-forbidden process-global IPC ${forbidden}`,
  );
  console.log(
    `${target}: actual C ABI, ICU, builtin Snowball, Bionic/static-C++/16-KiB ELF and process-local IPC contract pass`,
  );
}
