import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { artifactTargets, ROOT } from '../../../tools/release/release-artifact-targets.mts';
import {
  extractPortableArchiveTree,
  canonicalGzipSync,
} from '../../../tools/packaging/portable-archive.mts';
import { createDeterministicTar } from '../../../tools/packaging/cargo-source-package.mts';
import {
  stageReleaseNotices,
  assertReleaseNoticesInArchive,
  releaseProfilePackageLicense,
} from '../../../tools/packaging/release-notices.mts';
import {
  NPM_TRUSTED_PUBLISHING_REPOSITORY,
  validateNpmTrustedPublishingManifest,
} from '../../../tools/packaging/npm-trusted-publishing.mts';
import { validateToolsAotPayload } from './package-assets.mts';

export function packWasixToolsAotNpmCarriers(
  version,
  assetDir,
  { targetIds, workRoot = path.join(ROOT, 'target/release') } = {},
) {
  return artifactTargets('postgres-tools-wasix', 'wasix-tools-aot', 'wasix-tools-aot-npm.mts')
    .filter((target) => targetIds === undefined || targetIds.includes(target.target))
    .map((target) => {
      const packageName = target.npmPackage;
      const stage = path.join(
        workRoot,
        'npm-package-sources',
        packageName.replace('@oliphaunt/', ''),
      );
      rmSync(stage, { recursive: true, force: true });
      mkdirSync(stage, { recursive: true });
      extractPortableArchiveTree(
        path.join(assetDir, target.asset.replaceAll('{version}', version)),
        path.join(stage, 'assets'),
      );
      validateToolsAotPayload(path.join(stage, 'assets'), target.triple);
      const manifest = {
        name: packageName,
        version,
        type: 'module',
        description: 'Target AOT PostgreSQL tools for the Oliphaunt WASIX tools package.',
        license: releaseProfilePackageLicense('wasix-runtime').spdx,
        os: [target.npmOs],
        cpu: [target.npmCpu],
        ...(target.npmLibc ? { libc: [target.npmLibc] } : {}),
        repository: { type: 'git', url: NPM_TRUSTED_PUBLISHING_REPOSITORY },
        publishConfig: { access: 'public', provenance: true },
        exports: { './package.json': './package.json' },
        files: ['assets', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'third-party-licenses'],
      };
      validateNpmTrustedPublishingManifest(manifest, packageName);
      writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
      stageReleaseNotices(stage, { profile: 'wasix-runtime' });
      const output = path.join(workRoot, 'npm-packages', packageName.replace('@oliphaunt/', ''));
      mkdirSync(output, { recursive: true });
      const tarball = path.join(
        output,
        `${packageName.replace('@', '').replace('/', '-')}-${version}.tgz`,
      );
      writeFileSync(
        tarball,
        canonicalGzipSync(
          createDeterministicTar(stage, 'package', {
            fail: (message) => {
              throw new Error(message);
            },
            fixedFileMode: 0o644,
          }),
        ),
      );
      assertReleaseNoticesInArchive(tarball, { profile: 'wasix-runtime', prefix: 'package' });
      return tarball;
    });
}
