import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateNativeIcuDataManifest } from '../../src/database-resources/contracts/icu-data.mts';
import {
  emptyDirectoryPaths,
  logicalTreeSha256,
  parseProperties,
  validateNativeClusterSeedDirectory,
} from '../../src/database-resources/contracts/native-manifest.mts';
import { seedCarrierIdentities } from '../../src/database-resources/seeds/carrier-identities.mts';
import { stageMobileSeed } from '../../src/database-resources/seeds/package-mobile-carriers.mts';
import {
  compareNativeMobileAbiReceipts,
  NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN,
} from '../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { validateMavenCentralPublication } from '../../tools/packaging/maven-central-contract.mts';
import {
  archiveLogicalTreeRows,
  extractPortableArchiveTree,
  readPortableArchiveEntries,
  readPortableTarStream,
} from '../../tools/packaging/portable-archive.mts';

type Entries = ReturnType<typeof readPortableArchiveEntries>;

function regular(entries: Entries, name: string): Buffer {
  const entry = entries.get(name);
  assert(entry?.isFile && !entry.isSymbolicLink, `missing regular archive member ${name}`);
  return entry.data();
}

/** Compare physical files, directories and modes across the final package formats. */
export function assertMatchingArchiveTrees(
  left: Entries,
  leftPrefix: string,
  right: Entries,
  rightPrefix: string,
): void {
  const tree = (entries: Entries, prefix: string) =>
    [...entries]
      .filter(([name]) => name.startsWith(prefix) && name !== prefix.replace(/\/$/u, ''))
      .map(([name, entry]) => {
        assert(entry.isDirectory || (entry.isFile && !entry.isSymbolicLink), name);
        return {
          path: name.slice(prefix.length),
          mode: entry.mode & 0o7777,
          directory: entry.isDirectory,
          sha256: entry.isDirectory
            ? null
            : createHash('sha256').update(entry.data()).digest('hex'),
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  const expected = tree(right, rightPrefix);
  assert(
    expected.some((row) => !row.directory),
    'comparison requires actual resource files',
  );
  assert.deepEqual(
    tree(left, leftPrefix),
    expected,
    'final package changed its frozen resource tree',
  );
}

type SeedFiles = {
  profile: 'standard' | 'icu';
  frozen: string;
  archive: string;
  manifest: string;
  npm: string;
  cargo: string;
  maven?: string;
};

/** Actual package-byte proof; target device execution belongs to its separate installed lane. */
export async function verifyMobileResourceFiles({
  target,
  version,
  runtimeVersion,
  icu,
  swift,
  seeds,
  root,
}: {
  target: 'android-datum64' | 'ios-datum64';
  version: string;
  runtimeVersion: string;
  icu: string;
  swift?: string;
  seeds: SeedFiles[];
  root: string;
}): Promise<void> {
  assert(['android-datum64', 'ios-datum64'].includes(target));
  assert.deepEqual(seeds.map(({ profile }) => profile).sort(), ['icu', 'standard']);
  assert.equal(Boolean(swift), target === 'ios-datum64');
  const icuRoot = path.join(root, 'icu');
  extractPortableArchiveTree(icu, icuRoot);
  const icuData = path.join(icuRoot, 'share/icu');
  validateNativeIcuDataManifest(readFileSync(path.join(icuRoot, 'manifest.properties')), icuData);
  const swiftEntries = swift ? readPortableArchiveEntries(swift) : undefined;
  if (swiftEntries)
    assertMatchingArchiveTrees(
      swiftEntries,
      'Sources/OliphauntICU/share/icu/',
      readPortableArchiveEntries(icu),
      'share/icu/',
    );
  const identities = seedCarrierIdentities();
  for (const seed of seeds) {
    assert.equal(Boolean(seed.maven), target === 'android-datum64');
    const frozenRoot = path.join(root, seed.profile, 'frozen');
    mkdirSync(frozenRoot, { recursive: true });
    const stream = createReadStream(seed.frozen);
    let inventory;
    try {
      inventory = await readPortableTarStream(stream, seed.frozen, {}, { root: frozenRoot });
    } finally {
      stream.destroy();
    }
    const frozenEntries = new Map(
      [...inventory].map(([name, entry]) => [
        name,
        {
          ...entry,
          data: () => readFileSync(path.join(frozenRoot, name)),
        },
      ]),
    );
    const receipts = NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN[target].map((abiTarget) => ({
      text: regular(frozenEntries, `abi-receipts/${abiTarget}.properties`).toString(),
      label: seed.frozen,
    }));
    compareNativeMobileAbiReceipts(target, receipts);
    validateNativeClusterSeedDirectory(frozenRoot, seed.profile, {
      target,
      icuData: seed.profile === 'icu' ? icuData : undefined,
    });
    const archiveEntries = readPortableArchiveEntries(seed.archive);
    assertMatchingArchiveTrees(archiveEntries, '', frozenEntries, 'files/');
    const stage = path.join(root, seed.profile, 'canonical-mobile');
    const manifest = stageMobileSeed({
      archive: seed.archive,
      manifest: seed.manifest,
      destination: stage,
      target,
      profile: seed.profile,
      icuData: seed.profile === 'icu' ? icuData : undefined,
    });
    assert.equal(manifest.runtime.version, runtimeVersion);
    const identity = identities.find(
      (row) => row.family === 'native' && row.target === target && row.profile === seed.profile,
    );
    assert(identity, 'mobile resource requires one canonical carrier identity');
    const npm = readPortableArchiveEntries(seed.npm);
    const packageJson = JSON.parse(regular(npm, 'package/package.json').toString());
    assert.equal(packageJson.name, identity.npm);
    assert.equal(packageJson.version, version);
    assert.deepEqual(
      packageJson.dependencies ?? {},
      seed.profile === 'icu' ? { '@oliphaunt/icu': version } : {},
    );
    const npmManifest = JSON.parse(regular(npm, 'package/manifest.json').toString());
    const { directory, ...npmSeedManifest } = npmManifest;
    assert.deepEqual(npmSeedManifest, manifest, 'npm must preserve the canonical seed manifest');
    assert.equal(
      directory.treeSha256,
      logicalTreeSha256(archiveLogicalTreeRows(archiveEntries, seed.archive, '')),
    );
    assert.deepEqual(directory.emptyDirectories, emptyDirectoryPaths(path.join(stage, 'files')));
    assertMatchingArchiveTrees(npm, `package/${directory.path}/`, archiveEntries, '');
    assert(!npm.has('package/seed.tar.zst'), 'native npm seed must expose installed PGDATA');
    const cargo = readPortableArchiveEntries(seed.cargo);
    const crateRoot = `${identity.cargo}-${version}`;
    const cargoManifest = Bun.TOML.parse(regular(cargo, `${crateRoot}/Cargo.toml`).toString());
    assert.equal(cargoManifest.package.name, identity.cargo);
    assert.equal(cargoManifest.package.version, version);
    assert.deepEqual(
      cargoManifest.dependencies ?? {},
      seed.profile === 'icu' ? { 'oliphaunt-icu': `=${version}` } : {},
    );
    assert(regular(cargo, `${crateRoot}/seed.tar.zst`).equals(readFileSync(seed.archive)));
    assert.deepEqual(JSON.parse(regular(cargo, `${crateRoot}/manifest.json`).toString()), manifest);
    assert(statSync(seed.cargo).size <= 10 * 1024 * 1024);
    const resource = seed.profile === 'icu' ? 'cluster-seed-icu' : 'cluster-seed';
    const validateMobile = (entries: Entries, prefix: string) => {
      assertMatchingArchiveTrees(entries, `${prefix}/files/`, archiveEntries, '');
      const actual = regular(entries, `${prefix}/manifest.properties`);
      assert(actual.equals(readFileSync(path.join(stage, 'manifest.properties'))));
      const fields = parseProperties(actual, prefix);
      assert.equal(fields.get('target'), target);
    };
    if (seed.maven) {
      const coordinate = path.join(seed.maven, 'dev/oliphaunt/runtime', identity.cargo, version);
      validateMavenCentralPublication({
        context: 'actual Android seed carrier',
        files: readdirSync(coordinate).map((name) => ({
          name,
          size: statSync(path.join(coordinate, name)).size,
        })),
        pomText: readFileSync(path.join(coordinate, `${identity.cargo}-${version}.pom`), 'utf8'),
      });
      validateMobile(
        readPortableArchiveEntries(path.join(coordinate, `${identity.cargo}-${version}.tar.gz`)),
        resource,
      );
    } else {
      assert(swiftEntries, 'iOS resource proof requires its final Swift source carrier');
      const module = `OliphauntSeedNativeIOS${seed.profile === 'icu' ? 'ICU' : 'Standard'}`;
      validateMobile(npm, `package/${module}.bundle/${resource}`);
      validateMobile(swiftEntries, `Sources/${module}/${resource}`);
      regular(swiftEntries, `Sources/${module}/Resources.swift`);
    }
  }
}

if (import.meta.main) {
  const [target, version, runtimeVersion, icu, swift, ...inputs] = process.argv.slice(2);
  assert(process.env.TEST_TMPDIR, 'test requires a private Bazel scratch directory');
  const stride = target === 'android-datum64' ? 6 : 5;
  assert.equal(inputs.length, stride * 2, 'test requires both complete actual seed packages');
  const seeds = (['icu', 'standard'] as const).map((profile, index) => {
    const [frozen, archive, manifest, npm, cargo, maven] = inputs.slice(
      index * stride,
      (index + 1) * stride,
    );
    return { profile, frozen, archive, manifest, npm, cargo, maven };
  });
  await verifyMobileResourceFiles({
    target: target as 'android-datum64' | 'ios-datum64',
    version,
    runtimeVersion,
    icu,
    swift: swift === '-' ? undefined : swift,
    seeds,
    root: process.env.TEST_TMPDIR,
  });
  console.log(
    `${target} final GitHub/npm/Cargo/mobile resources preserve the admitted seed bytes and ABI`,
  );
}
