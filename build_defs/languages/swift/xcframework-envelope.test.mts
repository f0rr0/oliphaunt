import { expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMobileDependencyLicenseContract } from '../../../src/native/mobile-bindings/tools/dependency-license-contract.mts';
import { createDeterministicZip } from '../../../tools/packaging/archive-directory.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { packageBindingsXcframework } from './xcframework-envelope.mts';

const OWNER = 'src/native/mobile-bindings';
function legalSources(): Record<string, string> {
  const members = [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'Cargo.lock',
    `${OWNER}/dependency-licenses.json`,
  ];
  for (const name of readdirSync(`${OWNER}/dependency-license-blobs`))
    members.push(`${OWNER}/dependency-license-blobs/${name}`);
  return Object.fromEntries(members.map((member) => [member, path.resolve(member)]));
}

test('canonical FFI envelope reuses strict target license bytes and deterministic archives', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-swift-envelope-'));
  try {
    const framework = path.join(scratch, 'OliphauntNativeBindingsFFI.xcframework');
    mkdirSync(framework);
    const slices = [
      ['macos-arm64', 'macos', ''],
      ['ios-arm64', 'ios', ''],
      ['ios-arm64-simulator', 'ios', 'simulator'],
    ] as const;
    writeFileSync(
      path.join(framework, 'Info.plist'),
      `<plist version="1.0"><dict><key>AvailableLibraries</key><array>${slices.map(([identifier, platform, variant]) => `<dict><key>LibraryIdentifier</key><string>${identifier}</string><key>LibraryPath</key><string>fixture.a</string><key>SupportedArchitectures</key><array><string>arm64</string></array><key>SupportedPlatform</key><string>${platform}</string>${variant ? `<key>SupportedPlatformVariant</key><string>${variant}</string>` : ''}</dict>`).join('')}</array></dict></plist>`,
    );
    for (const [identifier] of slices) {
      mkdirSync(path.join(framework, identifier));
      writeFileSync(path.join(framework, identifier, 'fixture.a'), 'fixture construction only\n');
    }
    const intermediate = path.join(scratch, 'intermediate.zip');
    writeFileSync(intermediate, await createDeterministicZip(framework, { keepParent: true }));
    const first = path.join(scratch, 'first.zip');
    const second = path.join(scratch, 'second.zip');
    await packageBindingsXcframework(
      intermediate,
      path.relative(process.cwd(), first),
      legalSources(),
    );
    await packageBindingsXcframework(intermediate, second, legalSources());
    expect(readFileSync(first).equals(readFileSync(second))).toBeTrue();
    const entries = readPortableArchiveEntries(first, { format: 'zip' });
    // Runfiles inputs may be links; independent contract verification uses a
    // physical source tree just as the declared packaging action does.
    const sourceRoot = path.join(scratch, 'expected-sources');
    for (const [member, source] of Object.entries(legalSources())) {
      const destination = path.join(sourceRoot, member);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(realpathSync(source), destination);
    }
    const contract = createMobileDependencyLicenseContract(sourceRoot);
    for (const target of ['ios-arm64', 'ios-simulator-arm64', 'macos-arm64'])
      expect(
        contract.assertRustDependencyLicensesInEntries(entries, {
          target,
          prefix: `OliphauntNativeBindingsFFI.xcframework/licenses/${target}`,
        }).length,
      ).toBeGreaterThan(0);
    const unexpected = { ...legalSources(), '../outside': path.resolve('LICENSE') };
    await expect(
      packageBindingsXcframework(intermediate, path.join(scratch, 'bad.zip'), unexpected),
    ).rejects.toThrow('Unexpected legal source');
    const missing = legalSources();
    delete missing[`${OWNER}/dependency-licenses.json`];
    await expect(
      packageBindingsXcframework(intermediate, path.join(scratch, 'missing.zip'), missing),
    ).rejects.toThrow('Missing');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
