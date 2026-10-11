import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  type CanonicalArtifact,
  type CanonicalCarrier,
  type ConfiguredShippingCohort,
  type CoverageAuthority,
  checkShippingCoverage,
} from '../shipping-coverage.mts';

type Package = {
  product: string;
  version: string;
  ecosystem: string;
  name: string;
  configuration: string;
  role: string;
};

const carrier: CanonicalCarrier = {
  id: 'cargo:fixture-linux',
  product: 'fixture',
  version: '1.2.3',
  ecosystem: 'cargo',
  name: 'fixture-linux',
  role: 'platform-leaf',
  target: 'linux',
  declared: true,
};
const artifact: CanonicalArtifact = {
  product: 'fixture',
  version: '1.2.3',
  id: 'github-release:fixture-linux.tar.gz',
  role: 'github-release-asset',
  kind: 'runtime',
  target: 'linux',
  identity: null,
  name: 'fixture-linux.tar.gz',
};
const carrierPackage: Package = {
  product: carrier.product,
  version: carrier.version,
  ecosystem: carrier.ecosystem,
  name: carrier.name,
  configuration: 'linux',
  role: carrier.role,
};
const artifactPackage: Package = {
  product: artifact.product,
  version: artifact.version,
  ecosystem: 'github',
  name: artifact.name,
  configuration: artifact.target,
  role: artifact.role,
};

function authority({
  carriers = [carrier],
  artifacts = [artifact],
  products = ['fixture'],
} = {}): CoverageAuthority {
  return {
    catalog: {
      schema: 'oliphaunt-publication-catalog-v1',
      products: products.map((id) => ({ id, version: '1.2.3' })),
      carriers,
    },
    artifactRows: artifacts,
    resolveCarrier: (_ecosystem, name) => {
      if (name === 'fixture-linux-part-001') {
        return {
          ...carrier,
          id: `cargo:${name}`,
          name,
          declared: false,
          parentCarrier: carrier.id,
          role: 'payload-part',
        };
      }
      throw new Error(`undeclared carrier: ${name}`);
    },
  };
}

// Unit fixtures describe tiny producer graphs. The conformance owner separately
// checks real native archives/graphs; these cases exercise fail-closed boundaries.
function cohort(packages: Package[], prefix = 'fixture'): ConfiguredShippingCohort {
  const pathFragments: { id: number; label: string; parentId?: number }[] = [];
  const paths = new Map<string, number>();
  const fragment = (file: string): number => {
    let parentId: number | undefined;
    let current = '';
    for (const label of file.split('/')) {
      current = current ? `${current}/${label}` : label;
      let id = paths.get(current);
      if (!id) {
        id = pathFragments.length + 1;
        pathFragments.push({ id, label, ...(parentId ? { parentId } : {}) });
        paths.set(current, id);
      }
      parentId = id;
    }
    return parentId as number;
  };
  const roots: unknown[] = [];
  const targets: unknown[] = [];
  const artifacts: unknown[] = [];
  const actions: unknown[] = [];
  const depSetOfFiles: unknown[] = [];
  for (const [index, pkg] of packages.entries()) {
    const owner = `//fixture:${prefix}_archive_${index}`;
    const output = `bazel-out/fixture/bin/${prefix}/output_${index}`;
    const sourceId = index * 2 + 1;
    const outputId = sourceId + 1;
    roots.push({
      label: `//fixture:${prefix}_ship_${index}`,
      package: { ...pkg, outputs: [{ path: output, owner }] },
    });
    targets.push({ id: index + 1, label: owner });
    artifacts.push({ id: sourceId, pathFragmentId: fragment(`fixture/${prefix}/source_${index}`) });
    artifacts.push({ id: outputId, pathFragmentId: fragment(output) });
    depSetOfFiles.push({ id: index + 1, directArtifactIds: [sourceId] });
    actions.push({
      targetId: index + 1,
      configurationId: 1,
      actionKey: `${prefix}_action_${index}`,
      mnemonic: 'FixturePackage',
      inputDepSetIds: [index + 1],
      outputIds: [outputId],
      primaryOutputId: outputId,
      arguments: ['package', `fixture/${prefix}/source_${index}`, output],
    });
  }
  return {
    roots,
    aquery: {
      pathFragments,
      targets,
      artifacts,
      actions,
      depSetOfFiles,
      configuration: [{ id: 1 }],
    },
  };
}

test('complete coverage checks actual producer closures while exposing semantic admission limits', () => {
  const report = checkShippingCoverage(authority(), [cohort([carrierPackage, artifactPackage])]);
  assert.equal(report.completeProductInventory, true);
  assert.equal(report.declaredCarriers, 1);
  assert.equal(report.publicArtifacts, 1);
  assert.equal(report.constructionActionDescriptions, 2);
  assert.equal(report.scope, 'construction');
  assert.ok(report.unverified.some((field) => field.includes('packed manifests')));
});

test('missing product, platform or final carrier cannot disappear from discovered roots', () => {
  assert.throws(() => checkShippingCoverage(authority(), [cohort([])]), /product:fixture/);
  assert.throws(
    () => checkShippingCoverage(authority(), [cohort([artifactPackage])]),
    /cargo:fixture-linux/,
  );
  assert.throws(
    () => checkShippingCoverage(authority(), [cohort([carrierPackage])]),
    /github-release:fixture-linux.tar.gz/,
  );
  const windows = {
    ...carrier,
    id: 'cargo:fixture-windows',
    name: 'fixture-windows',
    target: 'windows',
  };
  assert.throws(
    () =>
      checkShippingCoverage(authority({ carriers: [carrier, windows] }), [
        cohort([carrierPackage, artifactPackage]),
      ]),
    /cargo:fixture-windows/,
  );
});

test('internal member payloads cannot stand in for public envelopes', () => {
  assert.throws(
    () =>
      checkShippingCoverage(authority(), [
        cohort([{ ...artifactPackage, ecosystem: 'internal', role: 'payload' }]),
      ]),
    /incomplete native shipping coverage/,
  );
  const report = checkShippingCoverage(authority(), [
    cohort([
      carrierPackage,
      artifactPackage,
      { ...artifactPackage, name: 'internal-member', ecosystem: 'internal', role: 'payload' },
    ]),
  ]);
  assert.equal(report.rootLabels.length, 2, 'internal members never become shipping build roots');
  assert.equal(report.internalRootLabels.length, 1);
});

test('wrong owner, version, platform, role and undeclared carrier fail closed', () => {
  for (const [change, message] of [
    [{ product: 'unknown' }, /unexpected shipping product/],
    [{ version: '9.0.0' }, /wrong shipping version/],
    [{ configuration: 'windows' }, /wrong carrier target/],
    [{ role: 'github-release-asset' }, /wrong carrier role/],
    [{ name: 'undeclared' }, /undeclared carrier/],
  ] as const) {
    assert.throws(
      () =>
        checkShippingCoverage(authority(), [
          cohort([{ ...carrierPackage, ...change }, artifactPackage]),
        ]),
      message,
    );
  }
  const knownOwnerMismatch = authority({
    products: ['fixture', 'other'],
    carriers: [{ ...carrier, product: 'other' }],
  });
  assert.throws(
    () => checkShippingCoverage(knownOwnerMismatch, [cohort([carrierPackage, artifactPackage])]),
    /wrong carrier ownership/,
  );
  assert.throws(
    () =>
      checkShippingCoverage(authority(), [
        cohort([carrierPackage, { ...artifactPackage, configuration: 'windows' }]),
      ]),
    /wrong artifact target/,
  );
  assert.throws(
    () =>
      checkShippingCoverage(authority(), [
        cohort([carrierPackage, { ...artifactPackage, role: 'github-release-metadata' }]),
      ]),
    /unexpected public artifact/,
  );
});

test('duplicate roots and repeated configured cohorts do not duplicate publication identities', () => {
  const complete = cohort([carrierPackage, artifactPackage]);
  assert.throws(
    () => checkShippingCoverage(authority(), [complete, complete]),
    /duplicate configured shipping identity/,
  );
  assert.throws(
    () =>
      checkShippingCoverage(authority(), [
        cohort([carrierPackage, carrierPackage, artifactPackage]),
      ]),
    /duplicate configured shipping identity/,
  );
});

test('independent configured cohorts collectively cover one complete canonical inventory', () => {
  const report = checkShippingCoverage(authority(), [
    cohort([carrierPackage], 'carrier'),
    cohort([artifactPackage], 'public'),
  ]);
  assert.equal(report.completeProductInventory, true);
  assert.equal(report.rootLabels.length, 2);
  assert.equal(report.constructionActionDescriptions, 2);
});

test('partial action graph and mismatched physical producer ownership fail before coverage', () => {
  const partial = cohort([carrierPackage, artifactPackage]);
  (partial.aquery as { actions: unknown[] }).actions = [];
  assert.throws(
    () => checkShippingCoverage(authority(), [partial]),
    /shipping output owner disagrees/,
  );
  const forged = cohort([carrierPackage, artifactPackage]);
  const root = forged.roots[0] as { package: { outputs: { owner: string }[] } };
  root.package.outputs[0].owner = '//fixture:another_archive';
  assert.throws(
    () => checkShippingCoverage(authority(), [forged]),
    /shipping output owner disagrees/,
  );
  const invalidLabel = cohort([carrierPackage, artifactPackage]);
  (invalidLabel.roots[0] as { label: string }).label = '@invalid';
  assert.throws(() => checkShippingCoverage(authority(), [invalidLabel]), /invalid root label/);
});

test('explicit subset passes only as subset; omitted products cannot certify full migration', () => {
  const canonical = authority({ products: ['fixture', 'other'] });
  const actual = [cohort([carrierPackage, artifactPackage])];
  assert.throws(() => checkShippingCoverage(canonical, actual), /product:other/);
  const report = checkShippingCoverage(canonical, actual, { products: ['fixture'] });
  assert.equal(report.completeProductInventory, false);
  assert.throws(
    () => checkShippingCoverage(canonical, actual, { products: ['fixture', 'fixture'] }),
    /unique product/,
  );
  assert.throws(
    () => checkShippingCoverage(canonical, actual, { products: ['unknown'] }),
    /unknown selected product/,
  );
});

test('dynamic Cargo parts add to declared carrier coverage and never replace their parent', () => {
  const part = { ...carrierPackage, name: 'fixture-linux-part-001', role: 'payload-part' };
  assert.throws(
    () => checkShippingCoverage(authority(), [cohort([part, artifactPackage])]),
    /cannot replace its declared parent/,
  );
  const report = checkShippingCoverage(authority(), [
    cohort([carrierPackage, artifactPackage, part]),
  ]);
  assert.equal(report.dynamicCarriers, 1);
});

test('candidate-only release inputs are reported separately and required only when claimed', () => {
  const input = {
    ...artifact,
    id: 'release-input:release-tree',
    name: 'release-tree',
    role: 'release-input',
    target: 'portable',
  };
  const canonical = authority({ artifacts: [artifact, input] });
  const publicRoots = [carrierPackage, artifactPackage];
  assert.equal(
    checkShippingCoverage(canonical, [cohort(publicRoots)]).releaseInputsRequired,
    false,
  );
  assert.throws(
    () => checkShippingCoverage(canonical, [cohort(publicRoots)], { includeReleaseInputs: true }),
    /release-input:release-tree/,
  );
  const report = checkShippingCoverage(
    canonical,
    [
      cohort([
        ...publicRoots,
        { ...artifactPackage, name: input.name, configuration: input.target, role: input.role },
      ]),
    ],
    { includeReleaseInputs: true },
  );
  assert.equal(report.releaseInputRoots, 1);
  assert.equal(report.publicArtifacts, 1);
});

test('source publication requires its actual manifest and tree while candidate fixtures remain optional', () => {
  const sourceInputs = [
    ['Package.swift.release', 'swiftpm-release-manifest'],
    ['release-tree', 'swiftpm-release-tree'],
    ['swiftpm-extension-consumer-fixture', 'swiftpm-extension-consumer-fixture'],
  ].map(([name, kind]) => ({
    ...artifact,
    id: `release-input:${kind}`,
    name,
    kind,
    role: 'release-input',
    target: 'portable',
  }));
  const canonical = authority({ carriers: [], artifacts: sourceInputs });
  canonical.catalog.products[0].publishTargets = ['swift-package-source-tag', 'github-release'];
  const packages = sourceInputs.map((input) => ({
    ...artifactPackage,
    name: input.name,
    configuration: input.target,
    role: input.role,
  }));
  const report = checkShippingCoverage(canonical, [cohort(packages.slice(0, 2))]);
  assert.equal(report.completeProductInventory, true);
  assert.equal(report.declaredCarriers, 0, 'source publication invents no registry carrier');
  assert.equal(report.publicArtifacts, 0);
  assert.equal(report.sourcePublicationInputs, 2);
  assert.equal(report.releaseInputsRequired, false);
  assert.equal(report.releaseInputRoots, 2);
  for (const missing of [0, 1]) {
    assert.throws(
      () =>
        checkShippingCoverage(canonical, [
          cohort(packages.filter((_, index) => index !== missing)),
        ]),
      new RegExp(sourceInputs[missing].id),
    );
  }
  assert.throws(() => checkShippingCoverage(canonical, [cohort([packages[2]])]), /product:fixture/);
  assert.throws(
    () =>
      checkShippingCoverage(canonical, [cohort(packages.slice(0, 2))], {
        includeReleaseInputs: true,
      }),
    /release-input:swiftpm-extension-consumer-fixture/,
  );
  assert.throws(
    () =>
      checkShippingCoverage({ ...canonical, artifactRows: sourceInputs.slice(1) }, [
        cohort(packages),
      ]),
    /source publication requires one canonical swiftpm-release-manifest/,
  );
});
