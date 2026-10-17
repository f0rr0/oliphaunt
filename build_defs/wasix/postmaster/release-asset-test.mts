/** Exercise the conventional launcher from the actual final public archive. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  carrierTree,
  hashRegular,
  verify,
} from '../../../src/wasix/postmaster/lib/verify-sealed-carrier.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import { nativeWasmerReceipt, runtimeAbiFacts } from './native-receipts.mts';

const [archiveArg, shell, launcherSource, readmeSource, licenseSource, noticesSource] =
  Bun.argv.slice(2);
assert(
  archiveArg &&
    shell &&
    launcherSource &&
    readmeSource &&
    licenseSource &&
    noticesSource &&
    Bun.argv.length === 8,
  'usage: release-asset-test.mts ARCHIVE BASH LAUNCHER README LICENSE NOTICES',
);
assert(isAbsolute(shell), 'The selected shell toolchain must provide an absolute executable');
const archive = realpathSync(resolve(archiveArg));
const parent = basename(archive).replace(/\.tar\.zst$/u, '');
assert.notEqual(parent, basename(archive), 'Expected the conventional tar.zst release archive');
const entries = readPortableArchiveEntries(archive);
assert(entries.get(parent)?.isDirectory, 'The public archive must retain its conventional parent');
for (const [name, entry] of entries) {
  assert(name === parent || name.startsWith(`${parent}/`), `Unexpected archive root: ${name}`);
  if (entry.isDirectory) assert.equal(entry.mode, 0o755, `Archive directory mode: ${name}`);
  else if (name.startsWith(`${parent}/carrier/`))
    assert([0o644, 0o755].includes(entry.mode), `Archive carrier mode: ${name}`);
  else
    assert.equal(
      entry.mode,
      name === `${parent}/bin/oliphaunt-wasix-postmaster` ? 0o755 : 0o644,
      `Unexpected conventional archive mode: ${name}`,
    );
}
const work = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'postmaster-public-archive-'));
const diagnostics = process.env.TEST_UNDECLARED_OUTPUTS_DIR
  ? join(process.env.TEST_UNDECLARED_OUTPUTS_DIR, 'postmaster-public-archive')
  : join(work, 'diagnostics');
mkdirSync(diagnostics, { recursive: true });
extractPortableArchiveTree(archive, join(work, 'installed'));
const installed = join(work, 'installed', parent);
assert.deepEqual(readdirSync(installed).sort(), [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'bin',
  'carrier',
]);
assert.deepEqual(readdirSync(join(installed, 'bin')), ['oliphaunt-wasix-postmaster']);
for (const [member, source] of [
  ['bin/oliphaunt-wasix-postmaster', launcherSource],
  ['README.md', readmeSource],
  ['LICENSE', licenseSource],
  ['THIRD_PARTY_NOTICES.md', noticesSource],
])
  assert.deepEqual(
    readFileSync(join(installed, member)),
    readFileSync(realpathSync(resolve(source))),
    `Shipping source bytes differ: ${member}`,
  );
const carrier = join(installed, 'carrier');
// The canonical public archiver normalizes modes. Seal only this private
// installed copy before the unchanged receipt/inventory admission checks.
for (const [member, stat] of [...carrierTree(carrier)].reverse())
  chmodSync(member === '.' ? carrier : join(carrier, member), stat.mode & 0o555);
const wasmer = JSON.parse(readFileSync(join(carrier, 'wasmer-build.receipt'), 'utf8'));
nativeWasmerReceipt(wasmer);
const facts = runtimeAbiFacts(wasmer.runtime_abi);
const manifest = JSON.parse(readFileSync(join(carrier, 'manifest.json'), 'utf8'));
verify(
  carrier,
  hashRegular(join(carrier, 'wasmer-build.receipt')).sha256,
  manifest['postgres-version'],
  facts.wasmerVersion,
  facts.wasixVersion,
  wasmer.runtime_abi.artifact_abi_version,
  carrier,
);
const launcher = join(installed, 'bin/oliphaunt-wasix-postmaster');
const data = join(work, 'pgdata');
async function command(name: string, args: string[]) {
  const child = Bun.spawn([shell, ...args], {
    env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' },
    stdin: 'ignore',
    stdout: Bun.file(join(diagnostics, `${name}.stdout`)),
    stderr: Bun.file(join(diagnostics, `${name}.stderr`)),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${name} timed out`));
        }, 120_000);
      }),
    ]);
    assert.equal(
      code,
      0,
      `${name} failed: ${readFileSync(join(diagnostics, `${name}.stderr`), 'utf8')}`,
    );
    return readFileSync(join(diagnostics, `${name}.stdout`), 'utf8');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const shellVersion = (await command('shell-version', ['--version'])).split('\n')[0];
await command('initialize', [launcher, 'init', '--data-dir', data]);
const postgresVersion = readFileSync(join(data, 'PG_VERSION'), 'utf8').trim();
assert.equal(postgresVersion, String(manifest['postgres-version']).split('.')[0]);
assert(
  lstatSync(join(data, 'global/pg_control')).isFile(),
  'The shipped launcher must produce an actual cluster',
);
const uri = (await command('uri', [launcher, 'uri', '--data-dir', data])).trim();
assert.equal(uri, 'postgresql://postgres@127.0.0.1:5432/postgres');
writeFileSync(
  join(diagnostics, 'archive-result.json'),
  `${JSON.stringify(
    {
      archive: { name: basename(archive), ...hashRegular(archive), members: entries.size },
      manifest: hashRegular(join(carrier, 'manifest.json')),
      executor: hashRegular(join(carrier, 'bin/wasmer-headless')),
      shell: { path: shell, ...hashRegular(realpathSync(shell)), version: shellVersion },
      postgresVersion,
      uri,
      level: 'initialize-cluster',
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Actual public postmaster archive launcher initialized PostgreSQL ${postgresVersion}; ${uri}`,
);
