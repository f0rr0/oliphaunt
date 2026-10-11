import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDirectory } from '../packaging/archive-directory.mts';
import { packageEnvelope } from '../../build_defs/native/carriers/envelopes.mts';
import {
  requiredRuntimeMemberPaths,
  requiredToolsMemberPaths,
} from '../../src/native/runtime/tools/native-runtime-payload.mts';
import type { CompletedPublication } from './completed-release-publication.mts';
import {
  bindNativeArchiveDelivery,
  captureCompletedNativeArchiveDelivery,
  compareCompletedNativeArchiveDelivery,
} from './native-publication-delivery.mts';
import {
  captureNativePreEnvelopePayloads,
  type NativePayloadCohort,
} from './native-publication-payloads.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { expectedProductArtifactRows } from './publication-lock.mts';
import { allArtifactTargets } from './release-artifact-targets.mts';

const source = { commit: '1'.repeat(40), tree: '2'.repeat(40) };
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const ids = ['liboliphaunt-native', 'postgres-tools-native'];

async function fixture(run) {
  const executionRoot = mkdtempSync(path.join(os.tmpdir(), 'native-delivered-members-'));
  const catalog = loadPublicationCatalog('native final-member fixture', { products: ids });
  const artifactRows = expectedProductArtifactRows(catalog.products).filter((row) =>
    ['native-runtime', 'native-tools'].includes(row.kind),
  );
  const roots = [];
  const files = [];
  for (const row of artifactRows) {
    const output = `bazel-out/fixture/bin/${row.product}/${row.target}/public_payload`;
    const directory = path.join(executionRoot, output);
    const executable =
      row.kind === 'native-runtime'
        ? requiredRuntimeMemberPaths(row.target, 'runtime/bin')
        : requiredToolsMemberPaths(row.target, 'runtime/bin');
    for (const name of [...executable, 'lib/public-interface.bin', 'THIRD_PARTY_NOTICES.md']) {
      const file = path.join(directory, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${row.product} ${name} exact bytes`);
      // Physical Bazel file permissions deliberately differ from public modes.
      chmodSync(file, 0o555);
    }
    const artifact = allArtifactTargets({ product: row.product, surface: 'github-release' }).find(
      (artifact) => artifact.kind === row.kind && artifact.target === row.target,
    )!;
    const archiveOutput = `bazel-out/fixture/bin/${row.product}/${row.target}/release-assets/${row.name}`;
    const archive = path.join(executionRoot, archiveOutput);
    const pack = () =>
      packageEnvelope({
        phase: 'github',
        artifact,
        version: row.version,
        carriers: [],
        payload: directory,
        sources: {},
        legal: {},
        output: archive,
      });
    await pack();
    roots.push(
      {
        label: `//fixture/${row.product}:payload_${row.target}`,
        package: {
          product: row.product,
          version: row.version,
          ecosystem: 'internal',
          name: `${row.product}-public-payload`,
          configuration: row.target,
          role: 'construction',
          outputs: [{ path: output, owner: `//fixture/${row.product}:payload` }],
        },
      },
      {
        label: `//fixture/${row.product}:github_${row.target}`,
        package: {
          product: row.product,
          version: row.version,
          ecosystem: 'github',
          name: row.name,
          configuration: row.target,
          role: row.role,
          outputs: [{ path: archiveOutput, owner: `//fixture/${row.product}:archive` }],
        },
      },
    );
    files.push({ row, directory, archive, pack });
  }
  const cohort: NativePayloadCohort = {
    source,
    executionRoot,
    roots,
    get aquery() {
      throw new Error('physical archive binding must not infer execution');
    },
  };
  const capture = () =>
    captureNativePreEnvelopePayloads([cohort], { source, products: catalog.products });
  const bind = () => bindNativeArchiveDelivery(capture().payloads, [cohort], artifactRows);
  try {
    await run({ cohort, catalog, files, capture, bind, executionRoot, artifactRows });
  } finally {
    rmSync(executionRoot, { recursive: true, force: true });
  }
}

function completedFixture(product, files) {
  // Synthetic transport responses test the genuine default API contract. They
  // do not authenticate these fixture bytes as a real published release.
  const publication: CompletedPublication = {
    product: product.id,
    version: product.version,
    tagName: `${product.id}-v${product.version}`,
    publicationSha: source.commit,
    publicationTree: source.tree,
    releaseSha: '3'.repeat(40),
  };
  const release = {
    id: 123,
    tag_name: publication.tagName,
    target_commitish: source.commit,
    draft: false,
    prerelease: false,
  };
  const assets = files.map(({ row, archive }, index) => ({
    id: index + 1,
    name: row.name,
    size: readFileSync(archive).length,
    digest: `sha256:${hash(archive)}`,
    state: 'uploaded',
    url: `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${index + 1}`,
  }));
  const requests = [];
  const options = {
    assertCompletedPublication: async (requested) => {
      requests.push(['completion', requested]);
      return publication;
    },
    readJson: async (endpoint) => {
      expect(endpoint).toBe(`repos/f0rr0/oliphaunt/releases/tags/${publication.tagName}`);
      return release;
    },
    readPages: async (endpoint) => {
      expect(endpoint).toBe('repos/f0rr0/oliphaunt/releases/123/assets');
      return assets;
    },
    proveAsset: async () => {
      throw new Error('API asset digest should bind fixture bytes');
    },
  };
  const input = {
    publication,
    files: files.map(({ row, archive }) => ({ target: row.target, file: archive })),
  };
  return { input, options, publication, release, assets, requests };
}

test('actual GitHub envelope writer binds both native family member/mode contracts without granting qualification', async () => {
  await fixture(({ bind, capture }) => {
    const current = bind();
    expect(current.scope).toBe('construction');
    expect(
      current.products.every(
        ({ completeConfiguredArchiveInventory }) => completeConfiguredArchiveInventory,
      ),
    ).toBe(true);
    expect(current.products.every(({ physicalDelivery }) => physicalDelivery)).toBe(true);
    expect(current.unverified).toContain('native qualification workflow proof');
    const raw = capture().payloads.products[0].roots[0].outputs[0].members;
    expect(raw.filter(({ type }) => type === 'file').every(({ mode }) => mode === 0o555)).toBe(
      true,
    );
    const delivered = current.products[0].physicalDelivery!.deliveredPayloads[0].outputs[0].members;
    expect(delivered.find(({ path }) => path === 'THIRD_PARTY_NOTICES.md')!.mode).toBe(0o644);
    expect(delivered.find(({ path }) => path.startsWith('runtime/bin/'))!.mode).toBe(0o755);
  });
});

test('completed public member origin compares exact delivery while release necessity remains unverified', async () => {
  await fixture(async ({ bind, catalog, files }) => {
    const origins = [];
    for (const product of catalog.products) {
      const completed = completedFixture(
        product,
        files.filter(({ row }) => row.product === product.id),
      );
      origins.push(await captureCompletedNativeArchiveDelivery(completed.input, completed.options));
      expect(completed.requests).toEqual([['completion', completed.publication]]);
    }
    const before = compareCompletedNativeArchiveDelivery(bind(), origins);
    expect(before.releaseDecision).toBe('unverified');
    expect(before.products.map(({ deliveryStatus }) => deliveryStatus)).toEqual([
      'identical',
      'identical',
    ]);
    const changed = files.find(({ row }) => row.product === 'postgres-tools-native')!;
    chmodSync(path.join(changed.directory, 'THIRD_PARTY_NOTICES.md'), 0o644);
    writeFileSync(
      path.join(changed.directory, 'THIRD_PARTY_NOTICES.md'),
      'actual changed public legal bytes',
    );
    await changed.pack();
    expect(compareCompletedNativeArchiveDelivery(bind(), origins).products).toEqual([
      { product: 'liboliphaunt-native', deliveryStatus: 'identical' },
      { product: 'postgres-tools-native', deliveryStatus: 'different' },
    ]);
    expect(
      compareCompletedNativeArchiveDelivery(bind(), []).products.every(
        ({ deliveryStatus }) => deliveryStatus === 'unknown',
      ),
    ).toBe(true);
  });
});

test('missing root/final archive or configured coverage remains unknown; substitutions fail', async () => {
  await fixture(({ cohort, capture, artifactRows }) => {
    const payloads = capture().payloads;
    const incomplete = Object.assign(Object.create(cohort), { roots: cohort.roots.slice(2) });
    const report = bindNativeArchiveDelivery(payloads, [incomplete], artifactRows);
    expect(report.products[0].physicalDelivery).toBeUndefined();
    expect(report.products[0].completeConfiguredArchiveInventory).toBe(false);
    expect(() =>
      bindNativeArchiveDelivery(
        payloads,
        [Object.assign(Object.create(cohort), { source: { ...source, tree: '4'.repeat(40) } })],
        artifactRows,
      ),
    ).toThrow('captured payload source');
    const root = cohort.roots.find(({ package: pkg }) => pkg.ecosystem === 'github')!;
    root.package.version = '99.0.0';
    expect(() => bindNativeArchiveDelivery(payloads, [cohort], artifactRows)).toThrow(
      'different version',
    );
  });
});

test('actual extra, missing or changed archive members cannot masquerade as captured payloads', async () => {
  await fixture(async ({ capture, cohort, files, artifactRows }) => {
    const payloads = capture().payloads;
    writeFileSync(path.join(files[0].directory, 'undeclared-member'), 'extra delivery');
    await files[0].pack();
    rmSync(path.join(files[0].directory, 'undeclared-member'));
    expect(() => bindNativeArchiveDelivery(payloads, [cohort], artifactRows)).toThrow(
      'exactly deliver',
    );
  });
});

test('a raw payload changed after capture cannot bind an unchanged final archive', async () => {
  await fixture(({ capture, cohort, files, artifactRows }) => {
    const payloads = capture().payloads;
    const changed = path.join(files[0].directory, 'lib/public-interface.bin');
    chmodSync(changed, 0o644);
    writeFileSync(changed, 'new unbound raw payload bytes');
    expect(() => bindNativeArchiveDelivery(payloads, [cohort], artifactRows)).toThrow(
      'captured physical members',
    );
  });
});

test('same file bytes with an incorrect final executable mode do not satisfy the public contract', async () => {
  await fixture(async ({ capture, cohort, files, artifactRows }) => {
    const payloads = capture().payloads;
    const value = files[0];
    const executable =
      value.row.kind === 'native-runtime'
        ? requiredRuntimeMemberPaths(value.row.target, 'runtime/bin')
        : requiredToolsMemberPaths(value.row.target, 'runtime/bin');
    await archiveDirectory(value.directory, value.archive, {
      modes: {
        ...Object.fromEntries(executable.map((name) => [name, 0o755])),
        'lib/public-interface.bin': 0o755,
        'THIRD_PARTY_NOTICES.md': 0o644,
      },
    });
    expect(() => bindNativeArchiveDelivery(payloads, [cohort], artifactRows)).toThrow(
      'exactly deliver',
    );
  });
});

test('digest-less public assets use the retained streaming proof and partial origins stay unknown', async () => {
  await fixture(async ({ catalog, files, bind }) => {
    const product = catalog.products[0];
    const one = files.filter(({ row }) => row.product === product.id).slice(0, 1);
    const completed = completedFixture(product, one);
    delete completed.assets[0].digest;
    let downloads = 0;
    const proveAsset = async (url, name, size) => {
      expect(url).toBe(completed.assets[0].url);
      expect(name).toBe(one[0].row.name);
      expect(size).toBe(readFileSync(one[0].archive).length);
      downloads++;
      return { bytes: size, sha256: hash(one[0].archive) };
    };
    const origin = await captureCompletedNativeArchiveDelivery(completed.input, {
      ...completed.options,
      proveAsset,
    });
    expect(downloads).toBe(1);
    expect(
      compareCompletedNativeArchiveDelivery(bind(), [origin]).products.every(
        ({ deliveryStatus }) => deliveryStatus === 'unknown',
      ),
    ).toBe(true);
    await expect(
      captureCompletedNativeArchiveDelivery(completed.input, {
        ...completed.options,
        proveAsset: async () => ({ bytes: 1, sha256: hash(one[0].archive) }),
      }),
    ).rejects.toThrow('authenticated public asset');
  });
});

test('completed origin binds actual release/source/asset identity, downloaded bytes and safe physical archive', async () => {
  await fixture(async ({ catalog, files, executionRoot }) => {
    const product = catalog.products[0];
    const completed = completedFixture(
      product,
      files.filter(({ row }) => row.product === product.id),
    );
    const call = () => captureCompletedNativeArchiveDelivery(completed.input, completed.options);
    completed.release.target_commitish = '4'.repeat(40);
    await expect(call()).rejects.toThrow('completed source');
    completed.release.target_commitish = source.commit;
    completed.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    await expect(call()).rejects.toThrow('authenticated public asset');
    completed.assets[0].digest = `sha256:${hash(completed.input.files[0].file)}`;
    const archive = completed.input.files[0].file;
    const backup = path.join(executionRoot, 'backup.tar.gz');
    copyFileSync(archive, backup);
    rmSync(archive);
    symlinkSync(backup, archive);
    await expect(call()).rejects.toThrow();
  });
});
