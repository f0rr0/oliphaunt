import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const rustc = process.argv[2];
assert(rustc, 'usage: build-script-regression.mts /absolute/path/to/rustc');
const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'windows-v8-build-script-'));
const template = readFileSync(new URL('./build.rs.tpl', import.meta.url), 'utf8');
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !['OUT_DIR', 'TARGET', 'CARGO_MANIFEST_DIR', 'CARGO_FEATURE_V8', 'FACADE_FAIL'].includes(
        name,
      ),
  ),
);
function run(command: string, args: string[], env = environment) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}
function compile(name: string, source: string, enabled: boolean, extra: string[] = []) {
  const input = join(root, `${name}.rs`);
  const binary = join(root, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  writeFileSync(input, source);
  const result = run(resolve(rustc), [
    input,
    '--edition=2024',
    ...(enabled ? ['--cfg', 'feature="v8"'] : []),
    ...extra,
    '-o',
    binary,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return binary;
}
try {
  const disabled = compile('disabled', template, false);
  assert.equal(run(disabled, []).status, 0, 'disabled feature requires no facade or Cargo paths');

  const facadeSource = join(root, 'facade.rs');
  const facadeLibrary = join(root, 'libfacade.rlib');
  writeFileSync(
    facadeSource,
    `
pub fn write_dll(path: &std::path::Path) -> std::io::Result<()> {
    if std::env::var_os("FACADE_FAIL").is_some() {
        return Err(std::io::Error::other("injected facade failure"));
    }
    std::fs::write(path, b"fake facade reconstructed payload")
}
`,
  );
  const facade = run(resolve(rustc), [
    facadeSource,
    '--edition=2024',
    '--crate-type=rlib',
    '--crate-name',
    'oliphaunt_wasmer_v8_windows_x64_msvc',
    '-o',
    facadeLibrary,
  ]);
  assert.equal(facade.status, 0, facade.stderr);
  const enabled = compile('enabled', template, true, [
    '--extern',
    `oliphaunt_wasmer_v8_windows_x64_msvc=${facadeLibrary}`,
  ]);
  const manifest = join(root, 'api-crate');
  const output = join(root, 'out');
  mkdirSync(join(manifest, 'prebuilt'), { recursive: true });
  mkdirSync(output);
  writeFileSync(join(manifest, 'prebuilt/embedded_bindings.rs'), 'declared C bindings');
  const env = {
    ...environment,
    CARGO_MANIFEST_DIR: manifest,
    OUT_DIR: output,
    TARGET: 'x86_64-pc-windows-msvc',
  };
  const success = run(enabled, [], env);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(readFileSync(join(output, 'v8_bindings.rs'), 'utf8'), 'declared C bindings');
  assert.equal(
    readFileSync(join(output, 'oliphaunt_wee8.dll'), 'utf8'),
    'fake facade reconstructed payload',
  );
  assert.deepEqual(readdirSync(join(manifest, 'prebuilt')), ['embedded_bindings.rs']);

  rmSync(join(output, 'oliphaunt_wee8.dll'));
  const failure = run(enabled, [], { ...env, FACADE_FAIL: '1' });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /injected facade failure/);
  assert(!existsSync(join(output, 'oliphaunt_wee8.dll')));
  const wrongTarget = run(enabled, [], { ...env, TARGET: 'x86_64-unknown-linux-gnu' });
  assert.notEqual(wrongTarget.status, 0);
  assert.match(wrongTarget.stderr, /x86_64-pc-windows-msvc/);
  console.log(
    'build-script regression: disabled feature, facade delivery, facade failure and target guard passed',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
