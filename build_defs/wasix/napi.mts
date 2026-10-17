import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertWasixNapiCarrierManifest,
  WASIX_NAPI_SOURCE_PATCH_MEMBER,
} from '../../src/wasix/node-addon/tools/carrier-contract.mts';
import {
  packageWasixNapiCarrier,
  WASIX_NAPI_BINARY,
  type WasixNapiStage,
} from '../../src/wasix/node-addon/tools/package-platform.mts';
import { releaseProfilePackageLicense } from '../../tools/packaging/release-notices.mts';
import {
  renderWindowsVcRuntimeSourceReceipt,
  WINDOWS_VC_RUNTIME_RECEIPT,
} from '../../tools/packaging/windows-vc-runtime-closure.mts';
import { copyNativeInputFile } from '../../tools/release/native-file-identity.mts';

export type WasixNapiCarrierSpec = {
  target: WasixNapiStage['target'];
  version: string;
  sdkVersion: string;
  sqlNames: string[];
  sourcePatch: string;
  targetContract: Record<string, any>;
  binary: string;
  inputs: string;
  manifest: string;
  productManifest: string;
  readme: string;
  notices: Record<string, string>;
  windowsRuntime: Record<string, string>;
  outputs: { npm: string; github: string; provenance: string };
};

/** Render canonical bytes; source/run authentication and admission belong to outer evidence. */
export async function packageNativeWasixNapi(spec: WasixNapiCarrierSpec) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-napi-'));
  const copy = (input: string, output: string) => {
    const absolute = path.resolve(input),
      root = path.parse(absolute).root;
    return copyNativeInputFile(
      root,
      path.relative(root, absolute).split(path.sep).join('/'),
      output,
    );
  };
  try {
    const binary = path.join(scratch, WASIX_NAPI_BINARY);
    const subject = copy(spec.binary, binary);
    const buildInputs = JSON.parse(
      readFileSync(path.join(spec.inputs, 'build-inputs.json'), 'utf8'),
    );
    const layout = JSON.parse(readFileSync(path.join(spec.inputs, 'layout.json'), 'utf8'));
    const product = JSON.parse(readFileSync(spec.productManifest, 'utf8'));
    assert.equal(
      product.version,
      spec.version,
      'addon owner version differs from conventional package',
    );
    assert.equal(
      product.oliphaunt.runtimeVersion,
      layout.runtimeVersion,
      'addon runtime pin differs from compiled held SDK',
    );
    const sourceRoot = path.join(scratch, 'source');
    for (const [member, input] of Object.entries(spec.notices))
      copy(input, path.join(sourceRoot, member));
    const manifest = JSON.parse(readFileSync(spec.manifest, 'utf8'));
    manifest.oliphaunt = {
      ...manifest.oliphaunt,
      runtimeVersion: layout.runtimeVersion,
    };
    assert(
      !Object.hasOwn(manifest.oliphaunt, 'qualificationOnly'),
      'native carrier template is a qualification package',
    );
    const row = spec.targetContract;
    assertWasixNapiCarrierManifest(
      manifest,
      {
        target: spec.target,
        npmPackage: row.npm_package,
        npmOs: row.npm_os,
        npmCpu: row.npm_cpu,
        npmLibc: row.npm_libc ?? undefined,
      },
      spec.version,
      'native addon carrier',
      {
        ...product.oliphaunt,
        runtimeVersion: layout.runtimeVersion,
        packageLicense: releaseProfilePackageLicense('wasix-napi-addon', { sourceRoot }).spdx,
      },
    );
    const provenance = {
      schema: 'oliphaunt-wasix-napi-construction-data-v2',
      product: 'oliphaunt-wasix-napi',
      target: spec.target,
      build: {
        cargoProfile: 'release',
        incremental: false,
        codegenUnits: 1,
        lto: 'thin',
        strip: 'symbols',
        features: ['release'],
        targetTriple: buildInputs.targetTriple,
      },
      buildInputs,
      binary: { filename: WASIX_NAPI_BINARY, sha256: subject.sha256 },
    };
    let windowsRuntimeSourceDirectory: string | undefined;
    if (spec.target === 'windows-x64-msvc') {
      assert(
        Object.keys(spec.windowsRuntime).length > 0,
        'Windows addon requires its declared SDK runtime closure',
      );
      windowsRuntimeSourceDirectory = path.join(scratch, 'redist');
      for (const [member, input] of Object.entries(spec.windowsRuntime)) {
        assert.equal(path.basename(member), member, 'Windows runtime must be a flat declared File');
        copy(input, path.join(windowsRuntimeSourceDirectory, member));
      }
      writeFileSync(
        path.join(windowsRuntimeSourceDirectory, WINDOWS_VC_RUNTIME_RECEIPT),
        renderWindowsVcRuntimeSourceReceipt({
          sourceDirectory: windowsRuntimeSourceDirectory,
          profile: 'provider',
        }),
      );
    } else
      assert.equal(
        Object.keys(spec.windowsRuntime).length,
        0,
        'foreign VC runtime in addon envelope',
      );
    const readme = path.join(scratch, 'README.md');
    copy(spec.readme, readme);
    const patchIdentity = copy(spec.sourcePatch, path.join(scratch, 'source.patch'));
    const outputs = await packageWasixNapiCarrier({
      target: spec.target,
      manifest,
      binary,
      provenance,
      constructionContract: {
        targetTriple: row.triple,
        sdkVersion: spec.sdkVersion,
        runtimeVersion: layout.runtimeVersion,
        sqlNames: spec.sqlNames,
        sourcePatch: {
          path: WASIX_NAPI_SOURCE_PATCH_MEMBER,
          sha256: patchIdentity.sha256,
          size: patchIdentity.size,
        },
      },
      sourceRoot,
      readme,
      windowsRuntimeSourceDirectory,
      packageStage: path.join(scratch, 'npm'),
      releaseStage: path.join(scratch, 'github'),
      tarballRoot: path.join(scratch, 'packages'),
      releaseArchive: spec.outputs.github,
    });
    mkdirSync(path.dirname(spec.outputs.npm), { recursive: true });
    copyFileSync(outputs.npm, spec.outputs.npm);
    mkdirSync(path.dirname(spec.outputs.provenance), { recursive: true });
    writeFileSync(spec.outputs.provenance, `${JSON.stringify(provenance, null, 2)}\n`);
    return spec.outputs;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main)
  await packageNativeWasixNapi(JSON.parse(readFileSync(process.argv[2], 'utf8')));
