import assert from 'node:assert/strict';
import {access, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const postgresRoot = path.join(
  root,
  'src/runtimes/liboliphaunt/wasix/assets/build/postgres',
);
const patchDirectory = path.join(postgresRoot, 'patches');
const retiredPatches = Object.freeze([
  '0035-oliphaunt-wasix-use-single-backend-spinlocks.patch',
  '0036-oliphaunt-wasix-specialize-single-backend-atomics.patch',
]);

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('0035 and 0036 stay reserved while the guest uses PostgreSQL atomics', async () => {
  const [patchNames, series, manifest, configure] = await Promise.all([
    readdir(patchDirectory),
    readFile(path.join(patchDirectory, 'series'), 'utf8'),
    readFile(path.join(postgresRoot, 'source.toml'), 'utf8'),
    source('src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh'),
  ]);

  for (const patchName of retiredPatches) {
    await assert.rejects(
      access(path.join(patchDirectory, patchName)),
      (error) => error?.code === 'ENOENT',
    );
    assert.ok(!patchNames.includes(patchName));
    assert.ok(!series.includes(patchName));
    assert.ok(!manifest.includes(patchName));
  }

  const activePatchText = (
    await Promise.all(
      patchNames
        .filter((patchName) => patchName.endsWith('.patch'))
        .map((patchName) => readFile(path.join(patchDirectory, patchName), 'utf8')),
    )
  ).join('\n');
  assert.doesNotMatch(activePatchText, /OLIPHAUNT_WASM_SINGLE_BACKEND_ATOMICS/u);
  assert.doesNotMatch(activePatchText, /arch-wasix-single\.h/u);
  assert.doesNotMatch(activePatchText, /oliphaunt_wasix_single_user_tas/u);
  assert.doesNotMatch(configure, /--disable-spinlocks/u);
});

test('removing scalar atomics does not remove the independent single-program gates', async () => {
  const [hostPolicy, hostConsumer, rustTaskPolicy, rustHost] = await Promise.all([
    source(
      'src/bindings/wasix-ts/host/patches/0011-wasmer-wasix-deny-single-backend-guest-spawn.patch',
    ),
    source('src/bindings/wasix-ts/host/patches/0021-wasmer-js-stream-direct-pgwire.patch'),
    source(
      'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod/task_policy.rs',
    ),
    source('src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod.rs'),
  ]);

  for (const marker of [
    'pub enum WasiGuestExecutionMode',
    'SingleProgram',
    'max_task_count',
    'Some(1)',
    'proc_exec3.rs',
    'proc_fork.rs',
    'proc_spawn.rs',
    'proc_spawn2.rs',
    'thread_spawn.rs',
    'Errno::Notcapable',
  ]) {
    assert.ok(hostPolicy.includes(marker), `missing TypeScript host gate ${marker}`);
  }
  assert.match(hostConsumer, /WasiGuestExecutionMode::SingleProgram/u);

  for (const marker of [
    'max_threads = Some(1)',
    'fn task_wasm',
    'fn spawn_with_module',
    'Self::reject_guest_wasm_task',
    'assert!(env.fork().is_err())',
  ]) {
    assert.ok(rustTaskPolicy.includes(marker), `missing Rust host gate ${marker}`);
  }
  assert.match(rustHost, /GuestWasmTasks::Deny/u);
  assert.match(rustHost, /constrain_single_backend_tasks\(&mut builder\)/u);
});

test('the evidence disposition keeps 0035 and 0036 coupled and reopenable', async () => {
  const disposition = await readFile(
    path.join(postgresRoot, 'experiment-patch-disposition.toml'),
    'utf8',
  );

  for (const [patchName, upstreamPath] of [
    [retiredPatches[0], 'normal PostgreSQL spinlock path'],
    [retiredPatches[1], 'normal PostgreSQL atomic path'],
  ]) {
    const start = disposition.indexOf(`experiment = "${patchName}"`);
    assert.notEqual(start, -1, `missing disposition for ${patchName}`);
    const end = disposition.indexOf('\n[[patch]]', start + 1);
    const entry = disposition.slice(start, end === -1 ? undefined : end);
    assert.match(entry, /status = "removed-after-evidence-review"/u);
    assert.match(entry, /PR #133/u);
    assert.match(entry, /no factor-isolated A\/B/u);
    assert.ok(entry.includes(upstreamPath));
    assert.match(entry, /coupled experiment/u);
    assert.match(entry, /alternating retained-binary Node runs/u);
  }
});
