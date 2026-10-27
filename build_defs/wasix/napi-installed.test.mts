import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWasixNapiConstructionData } from '../../src/wasix/node-addon/tools/carrier-contract.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import { copyNativeInputFile } from '../../tools/release/native-file-identity.mts';
import { runImportedWasixInstalled } from '../extensions/wasix/imported_installed.mts';

const [
  archiveInput,
  lifecycle,
  node,
  consumer,
  productManifest,
  addonInputs,
  extensionConsumer,
  runfiles,
] = process.argv.slice(2);
const root = mkdtempSync(
  path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'oliphaunt-installed-wasix-'),
);
try {
  const declared = path.resolve(archiveInput);
  const executionRoot = path.parse(declared).root;
  const archive = path.join(root, 'carrier.tgz');
  copyNativeInputFile(
    executionRoot,
    path.relative(executionRoot, declared).split(path.sep).join('/'),
    archive,
  );
  const product = JSON.parse(readFileSync(productManifest, 'utf8'));
  const contract = JSON.parse(readFileSync(lifecycle, 'utf8'));
  const entries = readPortableArchiveEntries(archive);
  assert(
    [...entries.keys()].every((member) => member === 'package' || member.startsWith('package/')),
  );
  const member = (name: string) => {
    const entry = entries.get(name);
    assert(
      entry?.isFile && !entry.isSymbolicLink && entry.size > 0,
      `missing regular installed member ${name}`,
    );
    return Buffer.from(entry.data());
  };
  const manifest = JSON.parse(member('package/package.json').toString());
  const provenance = JSON.parse(member('package/artifact-provenance.json').toString());
  assert.equal(manifest.version, product.version);
  assert.equal(manifest.oliphaunt.runtimeVersion, product.oliphaunt.runtimeVersion);
  assert(!Object.hasOwn(manifest.oliphaunt, 'qualificationOnly'));
  assertWasixNapiConstructionData(
    provenance,
    manifest.oliphaunt.target,
    createHash('sha256')
      .update(member('package/prebuilds/oliphaunt_wasix_napi.node'))
      .digest('hex'),
    {
      targetTriple: contract.targetTriple,
      sdkVersion: contract.sdkVersion,
      runtimeVersion: product.oliphaunt.runtimeVersion,
      sqlNames: contract.lifecycles.map((row: any) => row.sqlName),
    },
  );
  assert(/^@oliphaunt\/wasix-napi-[a-z0-9-]+$/u.test(manifest.name));
  extractPortableArchiveTree(archive, path.join(root, 'node_modules', manifest.name), 'package');
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
  for (const key of Object.keys(env))
    if (/^(?:BUN_|RUNFILES|TEST_SRCDIR)/u.test(key)) delete env[key];
  const result = Bun.spawnSync(
    [
      node,
      '--experimental-strip-types',
      '--preserve-symlinks-main',
      consumer,
      manifest.name,
      lifecycle,
    ],
    { cwd: root, env, stdout: 'pipe', stderr: 'pipe', timeout: 240_000 },
  );
  assert.equal(result.exitCode, 0, `${result.stderr.toString()}\n${result.stdout.toString()}`);
  console.log(result.stdout.toString().trim());
  if (contract.extension)
    runImportedWasixInstalled({
      contract: contract.extension,
      runfiles,
      addonInputs,
      addonManifest: manifest,
      addonProvenance: provenance,
      root,
      node,
      consumer: extensionConsumer,
      environment: env,
    });
} finally {
  rmSync(root, { recursive: true, force: true });
}
