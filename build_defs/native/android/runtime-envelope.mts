import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { finalizeNativeRuntimeCarrier } from '../../../src/native/runtime/tools/finalize-native-runtime-carrier.mts';
import {
  compareNativeMobileAbiReceipts,
  parseNativeMobileAbiReceipt,
} from '../../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import {
  requiredRuntimeMemberPaths,
  validatePayload,
} from '../../../src/native/runtime/tools/native-runtime-payload.mts';
import { createDeterministicTar } from '../../../tools/packaging/archive-directory.mts';
import { buildMavenArtifactManifest } from '../../../tools/packaging/build-maven-artifact-manifest.mts';
import { stageMavenArtifactManifest } from '../../../tools/packaging/maven-artifact-staging.mts';
import { inspectPlatformBinaryTree } from '../../../tools/packaging/platform-binary-contract.mts';
import { canonicalGzipSync } from '../../../tools/packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../../tools/packaging/release-notices.mts';
import { materializeInputs, privateWork, readSpecification, run } from '../../resources/shared.mts';
import { copyDeclaredTree } from '../carriers/payload.mts';

/** Envelope declared compiled Files; never invoke a build or discover a checkout. */
export async function packageAndroidRuntime(specification) {
  assert.equal(
    process.platform,
    'linux',
    'Android runtime resources use their admitted Linux producer',
  );
  assert.equal(
    process.arch,
    'x64',
    'Android runtime resources use their admitted Linux x64 producer',
  );
  const work = privateWork(path.resolve(specification.resources));
  try {
    const legal = materializeInputs(specification.notices, path.join(work, 'legal'));
    const payload = path.join(work, 'payload');
    copyDeclaredTree(
      specification.payload,
      payload,
      requiredRuntimeMemberPaths('linux-x64-gnu', 'runtime/bin'),
    );
    const receipts = Object.entries(specification.receipts).map(([target, file]) => {
      const text = readFileSync(file as string, 'utf8');
      assert.equal(
        parseNativeMobileAbiReceipt(text, target).get('target'),
        target,
        'Android runtime receipt must bind its actual producer',
      );
      return { label: target, text };
    });
    compareNativeMobileAbiReceipts('android-datum64', receipts);
    const assets = path.join(work, 'assets');
    mkdirSync(assets);
    const hash = createHash('sha256').update('oliphaunt-android-runtime-resources-v1\n');
    hash.update(await createDeterministicTar(payload));
    for (const receipt of receipts.sort((a, b) => a.label.localeCompare(b.label)))
      hash.update(receipt.text);
    const resourceStage = path.join(work, 'resources');
    run(
      realpathSync(specification.formatter),
      [
        '--output',
        resourceStage,
        '--liboliphaunt-native-version',
        specification.version,
        '--extension-target',
        'android-datum64',
        '--runtime-cache-identity',
        `android-runtime-${hash.digest('hex')}`,
      ],
      {
        HOME: work,
        TMPDIR: work,
        LC_ALL: 'C',
        LANG: 'C',
        OLIPHAUNT_INSTALL_DIR: path.join(payload, 'runtime'),
        OLIPHAUNT_EMBEDDED_MODULE_DIR: path.join(payload, 'lib/modules'),
        OLIPHAUNT_RUNTIME_CACHE_DIR: path.join(work, 'cache'),
      },
      work,
    );
    const closure = path.join(resourceStage, 'oliphaunt');
    const provenance = path.join(closure, 'provenance/native-mobile-abi');
    mkdirSync(provenance, { recursive: true });
    for (const receipt of receipts)
      writeFileSync(path.join(provenance, `${receipt.label}.properties`), receipt.text, {
        mode: 0o644,
      });
    finalizeNativeRuntimeCarrier(closure, 'android-datum64');
    stageReleaseNotices(resourceStage, { profile: 'native-runtime-resources', sourceRoot: legal });
    const resourceAsset = path.join(assets, path.basename(specification.resources));
    writeFileSync(resourceAsset, canonicalGzipSync(await createDeterministicTar(resourceStage)), {
      mode: 0o644,
    });
    copyFileSync(resourceAsset, specification.resources);
    for (const artifact of specification.artifacts.filter((row) => row.kind === 'native-runtime')) {
      const binary = specification.libraries[artifact.target];
      assert(
        binary && artifact.library_relative_path,
        'Android runtime needs its actual canonical library',
      );
      const name = artifact.asset.replaceAll('{version}', specification.version);
      const stage = path.join(work, name.slice(0, -'.tar.gz'.length));
      const destination = path.join(stage, artifact.library_relative_path);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(binary, destination);
      chmodSync(destination, 0o755);
      materializeInputs(specification.headers, path.join(stage, 'include'));
      // NDK llvm-strip is a multicall llvm-objcopy alias; retain its argv[0].
      run(
        path.resolve(specification.strip),
        ['--strip-debug', destination],
        { HOME: work, TMPDIR: work, LC_ALL: 'C', LANG: 'C' },
        work,
      );
      stageReleaseNotices(stage, { profile: 'native-runtime', sourceRoot: legal });
      validatePayload(stage, artifact.target, { requireRuntime: false, toolSet: 'runtime' });
      await inspectPlatformBinaryTree(stage, { target: artifact.target });
      const asset = path.join(assets, name);
      writeFileSync(asset, canonicalGzipSync(await createDeterministicTar(stage)), { mode: 0o644 });
      copyFileSync(asset, specification.outputs[artifact.target]);
    }
    const manifest = await buildMavenArtifactManifest(path.join(work, 'maven.tsv'), {
      runtime: true,
      runtimeAssetRoot: assets,
      context: {
        version: specification.version,
        artifactTargets: specification.artifacts,
        registryPackages: specification.carriers.map((row) => row.name),
        noticeSourceRoot: legal,
      },
    });
    const mavenRoot = path.join(work, 'maven');
    const publications = await stageMavenArtifactManifest(manifest, mavenRoot, {
      noticeSourceRoot: legal,
    });
    assert.equal(
      publications.length,
      specification.carriers.length,
      'Android Maven construction must have exactly the canonical coordinates',
    );
    for (const carrier of specification.carriers) {
      const [group, artifact] = carrier.name.split(':');
      assert(group && artifact, 'Android runtime requires a canonical Maven coordinate');
      const relative = path.join(...group.split('.'), artifact, specification.version);
      copyDeclaredTree(
        path.join(mavenRoot, relative),
        path.join(specification.mavenOutputs[carrier.name], relative),
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) await packageAndroidRuntime(readSpecification());
