import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const identity = (file: string) => {
  // These are exact declared action paths; Bazel may project input files and
  // executable tools as sandbox symlinks. Shipped carrier members use the
  // separate no-follow inventory validator.
  assert(statSync(file).isFile(), `Expected regular AOT input/output: ${file}`);
  const bytes = readFileSync(file);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
};

if (import.meta.main) {
  const [compilerArg, abiPath, sealed, relative, artifact, receipt] = Bun.argv.slice(2);
  assert.equal(Bun.argv.length, 8, 'usage: aot.mts COMPILER ABI SEALED MODULE ARTIFACT RECEIPT');
  const compiler = resolve(compilerArg);
  assert(
    relative &&
      !relative.startsWith('/') &&
      relative.split('/').every((part) => part && part !== '.' && part !== '..'),
  );
  const module = join(sealed, relative);
  const moduleIdentity = identity(module);
  const abi = JSON.parse(readFileSync(abiPath, 'utf8'));
  assert.equal(abi.schema, 'oliphaunt.wasix-postmaster.runtime-abi.native.v2');
  assert.match(abi.runtime_abi_id, /^[0-9a-f]{64}$/);
  const flags = [
    '--llvm',
    '--llvm-opt-level',
    'aggressive',
    '--compiler-threads',
    '1',
    '--enable-exceptions',
    '--enable-threads',
  ];
  for (const args of [
    [...flags, '-o', resolve(artifact), resolve(module)],
    ['verify-aot', resolve(module), resolve(artifact)],
  ]) {
    const child = Bun.spawn([compiler, ...args], {
      env: { LC_ALL: 'C' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    assert.equal(await child.exited, 0, `Postmaster compiler failed: ${await stderr}`);
    const output = (await stdout).trim();
    if (args[0] === 'verify-aot')
      assert.equal(
        output.toLowerCase(),
        moduleIdentity.sha256,
        'AOT embedded module identity differs',
      );
  }
  assert.deepEqual(identity(module), moduleIdentity, 'Sealed input changed during compilation');
  writeFileSync(
    receipt,
    `${JSON.stringify({
      schema: 'oliphaunt.wasix-postmaster.aot.native.v1',
      module_path: relative,
      module: moduleIdentity,
      artifact: identity(artifact),
      compiler: identity(compiler),
      runtime_abi_id: abi.runtime_abi_id,
      artifact_abi_version: abi.artifact_abi_version,
      target: abi.rust.target,
      engine: 'llvm-opta',
      flags,
      cpu_policy: 'generic-baseline',
      cpu_features: [],
    })}\n`,
    { flag: 'wx' },
  );
}
