/** Canonical GitHub archive envelope around the actual native postmaster carrier. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { safeRelative, stableRead } from '../../../src/wasix/postmaster/lib/receipt-files.mts';
import {
  carrierTree,
  hashRegular,
  verify,
} from '../../../src/wasix/postmaster/lib/verify-sealed-carrier.mts';
import { archiveDirectory } from '../../../tools/packaging/archive-directory.mts';
import { inspectPlatformBinaryBuffer } from '../../../tools/packaging/platform-binary-contract.mts';
import { nativeWasmerReceipt, runtimeAbiFacts } from './native-receipts.mts';

export interface PostmasterReleaseAsset {
  product: string;
  version: string;
  artifact: { product: string; kind: string; asset: string; target: string; triple: string };
  carrier: string;
  carrierFiles: string[];
  sources: { launcher: string; readme: string; license: string; notices: string };
  output: string;
}

export async function packagePostmasterReleaseAsset(spec: PostmasterReleaseAsset) {
  assert.equal(spec.product, 'liboliphaunt-wasix-postmaster');
  assert.equal(spec.artifact.product, spec.product);
  assert.equal(spec.artifact.kind, 'wasix-postmaster-runtime');
  assert(/^\d+\.\d+\.\d+$/.test(spec.version), 'Invalid canonical postmaster version');
  const asset = spec.artifact.asset.replaceAll('{version}', spec.version);
  safeRelative(asset);
  assert.equal(basename(asset), asset);
  assert(asset.endsWith('.tar.zst'));
  assert.equal(basename(spec.output), asset, 'Postmaster output filename differs from catalog');
  assert(
    spec.carrierFiles.length > 0,
    'Postmaster release requires actual declared carrier leaves',
  );
  assert.equal(
    new Set(spec.carrierFiles).size,
    spec.carrierFiles.length,
    'Duplicate declared carrier leaf',
  );
  mkdirSync(dirname(spec.output), { recursive: true });
  const scratch = mkdtempSync(join(dirname(resolve(spec.output)), '.postmaster-release-'));
  const packageRoot = join(scratch, asset.slice(0, -'.tar.zst'.length));
  const carrier = join(packageRoot, 'carrier');
  mkdirSync(carrier, { recursive: true });
  try {
    for (const source of spec.carrierFiles) {
      const member = relative(resolve(spec.carrier), resolve(source));
      safeRelative(member);
      // Dereference only Bazel's single declared-file sandbox projection.
      const input = lstatSync(source).isSymbolicLink()
        ? resolve(dirname(source), readlinkSync(source))
        : source;
      assert(lstatSync(input).isFile(), `Declared carrier leaf is not regular: ${source}`);
      const chunks: Buffer[] = [];
      const stat = stableRead(input, (chunk) => chunks.push(Buffer.from(chunk)));
      const destination = join(carrier, member);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, Buffer.concat(chunks), { flag: 'wx' });
      chmodSync(destination, Number(stat.mode & 0o777n));
    }
    // Source TreeArtifact files are already readonly; seal the new directories.
    for (const [member, stat] of [...carrierTree(carrier)].reverse())
      if (stat.isDirectory()) chmodSync(member === '.' ? carrier : join(carrier, member), 0o555);
    const wasmer = JSON.parse(readFileSync(join(carrier, 'wasmer-build.receipt'), 'utf8'));
    nativeWasmerReceipt(wasmer);
    const facts = runtimeAbiFacts(wasmer.runtime_abi);
    assert.equal(
      facts.target,
      spec.artifact.triple,
      'Postmaster carrier differs from canonical host',
    );
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
    inspectPlatformBinaryBuffer(readFileSync(join(carrier, 'bin/wasmer-headless')), {
      target: spec.artifact.target,
      label: 'postmaster executor',
    });
    for (const [source, destination, mode] of [
      [spec.sources.launcher, 'bin/oliphaunt-wasix-postmaster', 0o555],
      [spec.sources.readme, 'README.md', 0o644],
      [spec.sources.license, 'LICENSE', 0o644],
      [spec.sources.notices, 'THIRD_PARTY_NOTICES.md', 0o644],
    ] as const) {
      const output = join(packageRoot, destination);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, readFileSync(source), { flag: 'wx' });
      chmodSync(output, mode);
    }
    await archiveDirectory(packageRoot, spec.output, { keepParent: true });
  } finally {
    for (const [member, stat] of carrierTree(carrier))
      if (stat.isDirectory()) chmodSync(member === '.' ? carrier : join(carrier, member), 0o755);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [specFile, members] = Bun.argv.slice(2);
  assert(specFile && members?.startsWith('--carrier-files=') && Bun.argv.length === 4);
  await packagePostmasterReleaseAsset({
    ...JSON.parse(readFileSync(specFile, 'utf8')),
    carrierFiles: readFileSync(members.slice('--carrier-files='.length), 'utf8')
      .trimEnd()
      .split('\n'),
  });
}
