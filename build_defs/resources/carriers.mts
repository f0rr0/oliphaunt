import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { packageIcuCargo } from '../../src/database-resources/icu/tools/package-cargo.mts';
import { resourceNpmTarballs } from '../../src/database-resources/icu/tools/package-npm.mts';
import { packageSeedCarriers } from '../../src/database-resources/seeds/package-carriers.mts';
import { packageMobileSeedCarriers } from '../../src/database-resources/seeds/package-mobile-carriers.mts';
import { buildMavenArtifactManifest } from '../../tools/packaging/build-maven-artifact-manifest.mts';
import { stageMavenArtifactManifest } from '../../tools/packaging/maven-artifact-staging.mts';
import { materializeInputs, privateWork, readSpecification } from './shared.mts';

const specification = readSpecification();
const work = privateWork(path.resolve(specification.npmOutput));
try {
  const legalRoot = materializeInputs(specification.notices, path.join(work, 'legal'));
  const assets = path.join(work, 'assets');
  mkdirSync(assets);
  for (const input of specification.assets) {
    const destination = path.join(assets, path.basename(input));
    copyFileSync(input, destination);
    // The conventional formatter rewrites its private manifest copies.
    chmodSync(destination, 0o644);
  }
  const output = path.join(work, 'packages');
  mkdirSync(output);
  let npm: string;
  let cargo: string;
  if (specification.kind === 'icu') {
    const sourceArchive = path.join(assets, path.basename(specification.assets[0]));
    const templateRoot = materializeInputs(specification.templates, path.join(work, 'templates'));
    npm = resourceNpmTarballs(specification.version, {
      sourceArchive,
      packageRoot: path.join(templateRoot, 'npm'),
      stageDir: path.join(work, 'npm-stage'),
      outputDir: path.join(output, 'npm'),
      noticeSourceRoot: legalRoot,
    })[0][1];
    cargo = packageIcuCargo(
      [
        '--asset',
        sourceArchive,
        '--output-dir',
        path.join(output, 'cargo'),
        '--work-dir',
        path.join(work, 'cargo'),
      ],
      {
        version: specification.version,
        root: work,
        templateDir: path.join(templateRoot, 'cargo'),
        noticeSourceRoot: legalRoot,
      },
    ).cratePath;
    const registryPackages = specification.carriers
      .filter((row) => row.ecosystem === 'maven')
      .map((row) => row.name);
    const manifest = await buildMavenArtifactManifest(path.join(work, 'maven.tsv'), {
      artifactProduct: 'database-resources',
      artifactIds: ['oliphaunt-icu'],
      runtimeAssetRoot: assets,
      context: {
        version: specification.version,
        artifactTargets: specification.artifactRows,
        registryPackages,
        noticeSourceRoot: legalRoot,
      },
    });
    await stageMavenArtifactManifest(manifest, specification.mavenOutput, {
      noticeSourceRoot: legalRoot,
    });
  } else {
    assert.equal(specification.kind, 'seed');
    const [result] = packageSeedCarriers(
      [
        '--family',
        specification.family,
        '--target',
        specification.target,
        '--profile',
        specification.profile,
      ],
      {
        version: specification.version,
        assetDir: assets,
        outputDir: output,
        sourceDir: path.join(work, 'seed-sources'),
        contract: specification.contract,
        noticeSourceRoot: legalRoot,
      },
    );
    assert.equal(result.npm, specification.carriers.find((row) => row.ecosystem === 'npm').name);
    assert.equal(
      result.cargo,
      specification.carriers.find((row) => row.ecosystem === 'cargo').name,
    );
    npm = result.npmArchive;
    cargo = result.crate;
    if (specification.mavenOutput) {
      assert.equal(specification.target, 'android-datum64');
      const canonical = specification.carriers.find((row) => row.ecosystem === 'maven');
      assert.ok(canonical, 'the Android resource has one canonical Maven carrier');
      await packageMobileSeedCarriers({
        targets: [specification.target],
        profiles: [specification.profile],
        assetDir: assets,
        workDir: path.join(work, 'mobile'),
        mavenDir: specification.mavenOutput,
        version: specification.version,
        noticeSourceRoot: legalRoot,
        contract: specification.contract,
      });
      const [group, artifact] = canonical.name.split(':');
      assert.ok(group && artifact);
      assert.deepEqual(
        readdirSync(
          path.join(
            specification.mavenOutput,
            ...group.split('.'),
            artifact,
            specification.version,
          ),
        ).sort(),
        ['-javadoc.jar', '-sources.jar', '.pom', '.tar.gz']
          .map((suffix) => `${artifact}-${specification.version}${suffix}`)
          .sort(),
        'the existing Maven writer must emit the exact canonical carrier',
      );
    }
  }
  copyFileSync(npm, specification.npmOutput);
  copyFileSync(cargo, specification.cargoOutput);
} finally {
  rmSync(work, { recursive: true, force: true });
}
