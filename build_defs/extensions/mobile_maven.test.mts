import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  nativeExtensionConstructionLicenseInventory,
  stageExtensionUpstreamLicenses,
} from '../../src/extensions/tools/extension-upstream-licenses.mts';
import { archiveDirectory } from '../../tools/packaging/archive-directory.mts';
import {
  buildMavenArtifactManifest,
  extensionMavenDependencies,
} from '../../tools/packaging/build-maven-artifact-manifest.mts';
import { parseMavenArtifactManifest } from '../../tools/packaging/maven-artifact-manifest.mts';
import { renderMavenArtifactPom } from '../../tools/packaging/maven-artifact-staging.mts';
import { stageReleaseNotices } from '../../tools/packaging/release-notices.mts';
import { declaredExtensionMetadata } from '../../tools/release/extension-release-metadata.mts';

function compilerRuntimeLicenseFixture() {
  if (process.env.OLIPHAUNT_TEST_COMPILER_RT_LICENSE)
    return process.env.OLIPHAUNT_TEST_COMPILER_RT_LICENSE;
  const runfiles = process.env.RUNFILES_DIR ?? process.env.TEST_SRCDIR;
  if (!runfiles) return undefined;
  const mapping = readFileSync(path.join(runfiles, '_repo_mapping'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  const roots = new Set(
    mapping.filter((row) => row[1] === 'pgvector_compiler_rt').map((row) => row[2]),
  );
  expect(roots.size, 'Bazel Maven regression requires its declared compiler-runtime license').toBe(
    1,
  );
  return path.join(runfiles, [...roots][0], 'LICENSE.TXT');
}

const compilerRuntimeLicense = compilerRuntimeLicenseFixture();

test('Maven acquisition edges come only from frozen same-ABI member dependencies', () => {
  const contrib = {
    product: 'oliphaunt-extension-contrib-pg18',
    versioning: 'runtime-bound',
    native: 'liboliphaunt-native',
    wasix: 'liboliphaunt-wasix',
  };
  const ownerMetadata = {
    cube: contrib,
    fuzzystrmatch: contrib,
    vector: {
      product: 'oliphaunt-extension-vector',
      versioning: 'upstream-bound',
      native: 'oliphaunt-extension-vector',
      wasix: 'oliphaunt-extension-vector',
    },
  };
  for (const target of ['android-arm64-v8a', 'android-x86_64']) {
    const owner = {
      product: 'oliphaunt-extension-postgis',
      releaseProduct: 'oliphaunt-extension-postgis',
      runtimeVersion: '1.2.3',
      target,
      ownerMetadata,
    };
    // The current catalog adds fuzzystrmatch; an old frozen release did not.
    expect(
      extensionMavenDependencies({ ...owner, members: [{ sqlName: 'postgis', dependencies: [] }] }),
    ).toEqual([]);
    const dependencies = extensionMavenDependencies({
      ...owner,
      members: [
        { sqlName: 'postgis', dependencies: [] },
        { sqlName: 'postgis_tiger_geocoder', dependencies: ['postgis', 'fuzzystrmatch'] },
        { sqlName: 'postgis_raster', dependencies: ['fuzzystrmatch'] },
      ],
    });
    expect(dependencies).toEqual([
      {
        groupId: 'dev.oliphaunt.extensions',
        artifactId: `oliphaunt-extension-contrib-pg18-${target}`,
        version: '1.2.3',
        type: 'tar.gz',
        scope: 'runtime',
      },
    ]);
    expect(
      extensionMavenDependencies({
        ...owner,
        product: 'oliphaunt-extension-contrib-pg18',
        releaseProduct: 'liboliphaunt-native',
        members: [{ sqlName: 'earthdistance', dependencies: ['cube'] }],
      }),
    ).toEqual([]);
    expect(
      extensionMavenDependencies({
        ...owner,
        product: 'oliphaunt-extension-pgtap',
        releaseProduct: 'oliphaunt-extension-pgtap',
        members: [{ sqlName: 'pgtap', dependencies: ['plpgsql'] }],
      }),
    ).toEqual([]);
    expect(() =>
      extensionMavenDependencies({
        ...owner,
        members: [{ sqlName: 'postgis', dependencies: ['vector'] }],
      }),
    ).toThrow(/explicit frozen version for independent release owner oliphaunt-extension-vector/u);
    expect(() =>
      extensionMavenDependencies({
        ...owner,
        members: [{ sqlName: 'postgis', dependencies: ['pgtap'] }],
      }),
    ).toThrow('has no declared release owner');
  }
});

test.skipIf(!compilerRuntimeLicense)(
  'declared vector Maven inputs require exact construction receipts for both Android targets',
  async () => {
    // Payloads exercise legal validation only. The acquired license is bound to
    // its canonical source pin; these archives are not target binary evidence.
    if (!compilerRuntimeLicense) throw new Error('compiler-runtime license fixture is required');
    const repository = path.resolve(import.meta.dir, '../..');
    const release = Bun.TOML.parse(
      readFileSync(path.join(repository, 'src/extensions/external/vector/release.toml'), 'utf8'),
    );
    const extensionSource = Bun.TOML.parse(
      readFileSync(path.join(repository, release.extension.source.path), 'utf8'),
    );
    const product = release.id;
    const version = extensionSource['extension-control']['default-version'];
    const metadata = declaredExtensionMetadata(product, release.extension);
    const targets = ['android-arm64-v8a', 'android-x86_64'];
    const source = JSON.parse(
      readFileSync(path.join(import.meta.dir, 'compiler_rt/source.json'), 'utf8'),
    );
    const sourceBytes = Buffer.from(
      JSON.stringify(source, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value,
      ),
    );
    const licenseBytes = readFileSync(compilerRuntimeLicense);
    const licensePath = 'share/licenses/llvm-compiler-rt/LICENSE.TXT';
    const sourcePath = 'share/licenses/llvm-compiler-rt/SOURCE.json';
    const constructionFiles = new Map([
      [licensePath, licenseBytes],
      [sourcePath, sourceBytes],
    ]);
    const memberContracts = Object.fromEntries(
      targets.map((target) => {
        const files = nativeExtensionConstructionLicenseInventory('vector', target);
        for (const file of files) {
          expect(createHash('sha256').update(constructionFiles.get(file.path)).digest('hex')).toBe(
            file.sha256,
          );
        }
        return [
          target,
          [{ sqlName: 'vector', dependencies: [], nativeConstructionLicenseFiles: files }],
        ];
      }),
    );
    const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-mobile-maven-legal-'));
    try {
      const productRoot = path.join(root, 'product');
      const assets = path.join(productRoot, 'release-assets');
      mkdirSync(assets, { recursive: true });
      async function payload(target, files = constructionFiles) {
        const stage = path.join(root, target);
        rmSync(stage, { recursive: true, force: true });
        mkdirSync(stage, { recursive: true });
        stageReleaseNotices(stage, { profile: 'external-native' });
        stageExtensionUpstreamLicenses('vector', path.join(stage, 'files'));
        for (const [name, bytes] of files) {
          const destination = path.join(stage, 'files', name);
          mkdirSync(path.dirname(destination), { recursive: true });
          writeFileSync(destination, bytes, { mode: 0o644 });
        }
        await archiveDirectory(
          stage,
          path.join(assets, `${product}-${version}-native-${target}-runtime.tar.gz`),
        );
      }
      for (const target of targets) await payload(target);
      const row = {
        productRoot,
        releaseProduct: product,
        version,
        sqlNames: metadata.sqlNames,
        compatibility: metadata.compatibility,
        runtimeSourceVersion: metadata.compatibility.nativeRuntimeVersion,
        targets: targets.map((target) => ({
          target,
          family: 'native',
          kind: 'native-static-registry',
        })),
        registryPackages: release.registry_packages
          .filter((coordinate) => coordinate.startsWith('maven:'))
          .map((coordinate) => coordinate.slice('maven:'.length)),
        memberContracts,
      };
      const manifest = path.join(root, 'vector.tsv');
      const build = (contracts = memberContracts) =>
        buildMavenArtifactManifest(manifest, {
          extensions: true,
          extensionProducts: [product],
          context: { extensions: { [product]: { ...row, memberContracts: contracts } } },
        });
      await build();
      const records = parseMavenArtifactManifest(manifest);
      expect(records.map((record) => record.artifactId)).toEqual(
        targets.map((target) => `${product}-${target}`),
      );
      for (const record of records) {
        expect(record.licenseSpdx).toContain('Apache-2.0 WITH LLVM-exception');
        expect(renderMavenArtifactPom(record)).toContain(
          `https://github.com/llvm/llvm-project/blob/${source.commit}/${source.files.find((file) => file.destination === 'LICENSE.TXT').path}`,
        );
      }
      for (const target of targets) {
        for (const [files, pattern] of [
          [new Map([[licensePath, licenseBytes]]), /packed upstream license members differ/u],
          [
            new Map([
              [licensePath, Buffer.from('changed license')],
              [sourcePath, sourceBytes],
            ]),
            /packed upstream license bytes changed/u,
          ],
          [
            new Map([
              ...constructionFiles,
              ['share/licenses/foreign/LICENSE', Buffer.from('extra license')],
            ]),
            /unexpected (?:file|directory) member/u,
          ],
        ] as const) {
          await payload(target, files);
          await expect(build()).rejects.toThrow(pattern);
        }
        await payload(target);
        const files = memberContracts[target][0].nativeConstructionLicenseFiles;
        for (const invalid of [
          [],
          [{ ...files[0], sha256: '0'.repeat(64) }, files[1]],
          [...files, { ...files[0], path: 'share/licenses/foreign/LICENSE' }],
        ]) {
          await expect(
            build({
              ...memberContracts,
              [target]: [{ sqlName: 'vector', nativeConstructionLicenseFiles: invalid }],
            }),
          ).rejects.toThrow(
            invalid.length === 0
              ? /unexpected (?:file|directory) member/u
              : /immutable construction source/u,
          );
        }
        await expect(
          build({ ...memberContracts, [target]: [], 'linux-x64-gnu': memberContracts[target] }),
        ).rejects.toThrow(/unexpected (?:file|directory) member/u);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
