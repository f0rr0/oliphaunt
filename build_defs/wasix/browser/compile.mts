import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function run(binary: string, arguments_: string[], cwd?: string) {
  const result = Bun.spawnSync([resolve(binary), ...arguments_], {
    cwd,
    env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '', BINARYEN_CORES: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  assert.equal(result.exitCode, 0, `${binary} compiler failed`);
}

if (import.meta.main) {
  const [mode, input, output, compiler, context] = Bun.argv.slice(2);
  assert(mode && input && output && compiler);
  const outputPath = resolve(output);
  if (mode === 'bindgen') {
    const metadata = JSON.parse(await readFile(context, 'utf8'));
    const profile = metadata.bindgen.profile;
    const flags = ['--target', 'web', '--weak-refs', '--typescript', '--out-name', 'wasmer_js'];
    if (profile['debug-js-glue']) flags.push('--debug');
    if (!profile['demangle-name-section']) flags.push('--no-demangle');
    if (profile['dwarf-debug-info']) flags.push('--keep-debug');
    await mkdir(outputPath, { recursive: true });
    run(compiler, [resolve(input), '--out-dir', outputPath, ...flags]);
  } else if (mode === 'optimize') {
    const metadata = JSON.parse(await readFile(context, 'utf8'));
    await cp(input, outputPath, { recursive: true, dereference: true });
    await chmod(outputPath, 0o755);
    await chmod(join(outputPath, 'wasmer_js_bg.wasm'), 0o644);
    run(compiler, [
      join(resolve(input), 'wasmer_js_bg.wasm'),
      ...metadata.wasmOpt,
      '-o',
      join(outputPath, 'wasmer_js_bg.wasm'),
    ]);
  } else throw new Error(`Unknown browser compiler action ${mode}`);
}
