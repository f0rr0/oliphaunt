/** Exercise the pinned execution tool with PostGIS's upstream SQLPP string mode. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [gpp, rasterio, config] = process.argv.slice(2);
assert(gpp, 'required: declared GPP executable');
assert(rasterio && config, 'required: declared pinned GDAL source and authored config');
const normalize = (output: string) => output.replaceAll('\r\n', '\n');
function run(args: string[]) {
  const result = Bun.spawnSync([resolve(gpp), ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return normalize(result.stdout.toString());
}

assert.equal(run(['--version']).split('\n')[0], 'GPP 2.28');
const expected = "\nSELECT text, 'text';\n";
// A single CRLF conversion must not hide GPP/CRT double conversion.
const doubledCr = "\r\r\nSELECT text, 'text';\r\r\n";
assert.equal(normalize(doubledCr), "\r\nSELECT text, 'text';\r\n");
assert.notEqual(normalize(doubledCr), expected);

const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-gpp-'));
try {
  for (const [name, newline] of [
    ['lf', '\n'],
    ['crlf', '\r\n'],
  ]) {
    const input = join(directory, `${name}.sql.in`);
    const output = join(directory, `${name}.sql`);
    writeFileSync(input, `#define TYPE text${newline}SELECT TYPE, 'TYPE';${newline}`);
    run(['+z', '-C', '-s', "'", '-o', output, input]);
    assert.equal(normalize(readFileSync(output, 'utf8')), expected);
  }

  // Check only preprocessing of the actual pinned selector and authored config.
  // Exclude includes: actual Windows headers and MSVC compilation belong to CI.
  const simd = readFileSync(resolve(rasterio), 'utf8').match(
    /^#if defined\(__x86_64\) \|\| defined\(_M_X64\)[\s\S]*?(?=^#ifdef HAVE_SSSE3_AT_COMPILE_TIME)/mu,
  )?.[0];
  assert(simd, 'pinned rasterio SIMD selector');
  const selector = simd.replace(/^#include[^\n]*\n/gmu, '');
  const authoredConfig = readFileSync(resolve(config), 'utf8');
  const cases = [
    ['MSVC x64', ['_WIN32', '_M_X64', '_MSC_VER'], ['SSE2']],
    [
      'MSVC AVX2',
      ['_WIN32', '_M_X64', '_MSC_VER', 'HAVE_AVX_AT_COMPILE_TIME', 'HAVE_AVX2_AT_COMPILE_TIME'],
      ['SSE2', 'AVX2'],
    ],
    ['GCC x64', ['__GNUC__', '__x86_64'], ['SSE2']],
    [
      'GCC AVX2',
      ['__GNUC__', '__x86_64', 'HAVE_AVX_AT_COMPILE_TIME', 'HAVE_AVX2_AT_COMPILE_TIME'],
      ['SSE2', 'AVX2'],
    ],
    ['Clang x64', ['__clang__', '__x86_64'], ['SSE2']],
    [
      'Clang AVX2',
      ['__clang__', '__x86_64', 'HAVE_AVX_AT_COMPILE_TIME', 'HAVE_AVX2_AT_COMPILE_TIME'],
      ['SSE2', 'AVX2'],
    ],
    ['Android x64', ['__ANDROID__', '__linux__', '__GNUC__', '__x86_64'], ['SSE2']],
    ['Apple arm64', ['__APPLE__', '__aarch64__'], []],
    ['Android arm64', ['__ANDROID__', '__linux__', '__aarch64__'], []],
    ['WASIX', ['__wasi__', '__wasm32__'], []],
  ] as const;
  for (const [name, defines, selected] of cases) {
    const input = join(directory, 'gdal-selector.c');
    writeFileSync(
      input,
      [
        '#define GDAL_COMPILATION 1',
        ...defines.map((macro) => '#define ' + macro + ' 1'),
        authoredConfig,
        selector,
        '#ifdef HAVE_SSE2\nGDAL_SELECTED_SSE2\n#endif',
        '#ifdef HAVE_AVX2_DISPATCH\nGDAL_SELECTED_AVX2\n#endif\n',
      ].join('\n'),
    );
    assert.deepEqual(
      [...run(['-C', input]).matchAll(/GDAL_SELECTED_(SSE2|AVX2)/gu)].map((match) => match[1]),
      selected,
      name,
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
