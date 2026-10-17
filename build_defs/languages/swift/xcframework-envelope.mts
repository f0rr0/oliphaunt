import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateAppleXcframeworkAsset } from '../../../src/native/sdks/swift/tools/swift-xcframework-contract.mts';
import { createDeterministicZip } from '../../../tools/packaging/archive-directory.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../../tools/packaging/release-notices.mts';
import { stageMobileLegalSources } from '../mobile-legal.mts';

const FRAMEWORK = 'OliphauntNativeBindingsFFI.xcframework';
const TARGETS = ['ios-arm64', 'ios-simulator-arm64', 'macos-arm64'];

export async function packageBindingsXcframework(
  input: string,
  output: string,
  sources: Record<string, string>,
): Promise<void> {
  output = path.resolve(output);
  mkdirSync(path.dirname(output), { recursive: true });
  const scratch = mkdtempSync(path.join(path.dirname(output), '.swift-bindings-'));
  try {
    const sourceRoot = path.join(scratch, 'sources');
    const contract = stageMobileLegalSources(sources, sourceRoot);
    await validateAppleXcframeworkAsset(realpathSync(input), 'OliphauntNativeBindingsFFI');
    const framework = path.join(scratch, FRAMEWORK);
    extractPortableArchiveTree(realpathSync(input), framework, FRAMEWORK);
    for (const target of TARGETS) {
      const directory = path.join(framework, 'licenses', target);
      stageReleaseNotices(directory, { profile: 'source-sdk', sourceRoot });
      contract.stageRustDependencyLicenses(directory, target);
      contract.assertRustDependencyLicensesInDirectory(directory, { target });
    }
    const bytes = await createDeterministicZip(framework, { keepParent: true });
    writeFileSync(output, bytes, { mode: 0o644 });
    const entries = readPortableArchiveEntries(output, { format: 'zip' });
    for (const target of TARGETS)
      contract.assertRustDependencyLicensesInEntries(entries, {
        target,
        prefix: `${FRAMEWORK}/licenses/${target}`,
        label: output,
      });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [input, output, sources, checksums] = process.argv.slice(2);
  assert.equal(
    process.argv.length,
    6,
    'Expected intermediate archive, output, sources and checksum manifest',
  );
  await packageBindingsXcframework(input, output, JSON.parse(readFileSync(sources, 'utf8')));
  const sha = createHash('sha256').update(readFileSync(output)).digest('hex');
  writeFileSync(checksums, `${sha}  ./${path.basename(output)}\n`, { mode: 0o644 });
}
