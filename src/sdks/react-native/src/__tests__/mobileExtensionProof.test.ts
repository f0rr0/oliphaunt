import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { PackageSizeReport } from '../client';
import { GENERATED_EXTENSION_METADATA } from '../generated/extensions';
import {
  MOBILE_RELEASE_EXTENSION_PROOF_COUNT,
  mobileReleaseExtensionProofPlan,
} from '../mobileExtensionProof';

function completeReport(): PackageSizeReport {
  const rows = GENERATED_EXTENSION_METADATA.filter((row) => row.mobileReleaseReady);
  return {
    packageBytes: 2_000,
    runtimeBytes: 1_000,
    templatePgdataBytes: 100,
    staticRegistryBytes: 100,
    selectedExtensionBytes: rows.length * 10,
    mobileStaticRegistryState: 'complete',
    mobileStaticRegistryRegistered: rows
      .filter((row) => row.nativeModuleStem !== null)
      .map((row) => row.sqlName),
    mobileStaticRegistryPending: [],
    nativeModuleStems: rows.flatMap((row) =>
      row.nativeModuleStem === null ? [] : [row.nativeModuleStem],
    ),
    runtimeFeatures: [],
    extensions: rows.map((row) => ({ name: row.sqlName, fileCount: 1, bytes: 10 })),
  };
}

function extensionSize(report: PackageSizeReport, sqlName: string) {
  const extension = report.extensions.find((row) => row.name === sqlName);
  assert(extension, `fixture is missing extension size row ${sqlName}`);
  return extension;
}

test('installed mobile proof covers all release-ready extensions and keeps dependencies ordered', () => {
  const inheritedPlatformSupport = GENERATED_EXTENSION_METADATA.find(
    (row) => row.mobileReleaseReady && !('mobile' in row.support),
  );
  assert(
    inheritedPlatformSupport,
    'fixture must prove that absent per-platform support inherits mobile release readiness',
  );
  for (const platform of ['android', 'ios'] as const) {
    const plan = mobileReleaseExtensionProofPlan(completeReport(), platform);
    assert.equal(plan.length, MOBILE_RELEASE_EXTENSION_PROOF_COUNT);
    assert.equal(new Set(plan.map((row) => row.sqlName)).size, plan.length);
    assert(plan.some((row) => row.sqlName === inheritedPlatformSupport.sqlName));
    assert(plan.some((row) => row.sqlName === 'pgtap' && row.nativeModuleStem === null));
    const cube = plan.findIndex((row) => row.sqlName === 'cube');
    const earthdistance = plan.findIndex((row) => row.sqlName === 'earthdistance');
    assert(cube >= 0 && earthdistance > cube);
    const autoExplain = plan.find((row) => row.sqlName === 'auto_explain');
    assert(autoExplain);
    assert.equal(autoExplain.createsExtension, false);
    assert.match(autoExplain.activationSql[0] ?? '', /^LOAD 'auto_explain'$/u);
  }
});

test('installed mobile proof fails closed on omissions, artifact drift, pending registration, and extras', () => {
  const cases: Array<(report: PackageSizeReport) => void> = [
    (report) => {
      report.extensions.pop();
    },
    (report) => {
      report.mobileStaticRegistryRegistered.pop();
    },
    (report) => {
      report.nativeModuleStems[0] = 'drifted_stem';
    },
    (report) => {
      report.mobileStaticRegistryPending.push('vector');
    },
    (report) => {
      report.extensions.push({ name: 'unexpected', fileCount: 1, bytes: 1 });
    },
  ];
  for (const mutate of cases) {
    const report = completeReport();
    mutate(report);
    assert.throws(() => mobileReleaseExtensionProofPlan(report, 'android'));
  }
});

test('SQL-only extension resources are required even though no native module is registered', () => {
  const report = completeReport();
  assert(!report.mobileStaticRegistryRegistered.includes('pgtap'));
  assert(report.extensions.some((extension) => extension.name === 'pgtap'));
  report.extensions = report.extensions.filter((extension) => extension.name !== 'pgtap');
  assert.throws(
    () => mobileReleaseExtensionProofPlan(report, 'ios'),
    /packaged extension resources/u,
  );
});

test('fully registered static module-only extensions may have no standalone resource files', () => {
  const metadata = GENERATED_EXTENSION_METADATA.find((row) => row.sqlName === 'auto_explain');
  assert(metadata);
  assert.equal(metadata.createsExtension, false);
  assert.equal(metadata.nativeModuleStem, 'auto_explain');
  assert.deepEqual(metadata.dataFiles, []);
  assert.deepEqual(metadata.runtimeShareDataFiles, []);
  assert.deepEqual(metadata.extensionSqlFileNames, []);
  assert.deepEqual(metadata.extensionSqlFilePrefixes, []);

  for (const platform of ['android', 'ios'] as const) {
    const report = completeReport();
    Object.assign(extensionSize(report, 'auto_explain'), { fileCount: 0, bytes: 0 });
    assert.doesNotThrow(() => mobileReleaseExtensionProofPlan(report, platform));
  }

  const incompleteRegistry = completeReport();
  Object.assign(extensionSize(incompleteRegistry, 'auto_explain'), { fileCount: 0, bytes: 0 });
  incompleteRegistry.mobileStaticRegistryRegistered =
    incompleteRegistry.mobileStaticRegistryRegistered.filter((name) => name !== 'auto_explain');
  assert.throws(
    () => mobileReleaseExtensionProofPlan(incompleteRegistry, 'android'),
    /registered native extension modules/u,
  );
});

test('CREATE and SQL-only extensions still require positive standalone resource sizes', () => {
  for (const sqlName of ['vector', 'pgtap']) {
    const metadata = GENERATED_EXTENSION_METADATA.find((row) => row.sqlName === sqlName);
    assert(metadata);
    assert.equal(metadata.createsExtension, true);
    if (sqlName === 'pgtap') assert.equal(metadata.nativeModuleStem, null);

    const report = completeReport();
    Object.assign(extensionSize(report, sqlName), { fileCount: 0, bytes: 0 });
    assert.throws(
      () => mobileReleaseExtensionProofPlan(report, 'android'),
      new RegExp(`packaged extension ${sqlName} has invalid resource size`, 'u'),
    );
  }
});
