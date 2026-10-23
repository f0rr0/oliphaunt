import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDirectory } from '../packaging/archive-directory.mts';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import {
  captureNativePreEnvelopePayloads,
  compareNativePreEnvelopeDelivery,
  nativePayloadDigest,
  type NativeCompletedPayloadOrigin,
  type NativeDeliveryVerification,
  type NativePayloadCohort,
  type NativePayloadProduct,
  type NativePayloads,
} from './native-publication-payloads.mts';

const initial = { commit: '1'.repeat(40), tree: '2'.repeat(40) };
const updated = { commit: '3'.repeat(40), tree: '4'.repeat(40) };

async function fixture(run, ids = ['runtime', 'tools', 'sdk']) {
  const executionRoot = mkdtempSync(path.join(os.tmpdir(), 'native-payload-facts-'));
  const products = ids.map((id) => ({ id, version: '1.0.0' }));
  const roots = products.map(({ id, version }) => {
    const output = `bazel-out/fixture/bin/${id}/public_payload`;
    const directory = path.join(executionRoot, output);
    mkdirSync(path.join(directory, 'lib'), { recursive: true });
    writeFileSync(path.join(directory, 'lib/module.bin'), `${id} public bytes`);
    writeFileSync(path.join(directory, 'LICENSE'), 'exact legal bytes');
    chmodSync(path.join(directory, 'lib/module.bin'), 0o644);
    chmodSync(path.join(directory, 'LICENSE'), 0o644);
    return {
      label: `//fixture/${id}:shipping_payload`,
      package: {
        product: id,
        version,
        ecosystem: 'internal',
        name: `${id}-public-payload`,
        configuration: 'linux-x64-gnu',
        role: 'construction',
        outputs: [{ path: output, owner: `//fixture/${id}:payload` }],
      },
    };
  });
  const cohort: NativePayloadCohort = {
    source: initial,
    executionRoot,
    roots,
    // There is deliberately no graph mirror or action-success surrogate.
    get aquery() {
      throw new Error('payload capture must not infer execution from aquery');
    },
  };
  const directory = (id) => path.join(executionRoot, `bazel-out/fixture/bin/${id}/public_payload`);
  const capture = (source = initial, selected = products, cohorts = [cohort]) =>
    captureNativePreEnvelopePayloads(
      cohorts.map((cohort) =>
        Object.defineProperties(
          {},
          {
            ...Object.getOwnPropertyDescriptors(cohort),
            source: { value: source, enumerable: true, configurable: true },
          },
        ),
      ) as NativePayloadCohort[],
      { source, products: selected },
    );
  try {
    // No checkout, source package path, conventional manifest or history exists here.
    expect(readdirSync(executionRoot)).toEqual(['bazel-out']);
    await run({ capture, cohort, products, directory, executionRoot });
  } finally {
    rmSync(executionRoot, { recursive: true, force: true });
  }
}

function origins(payloads: NativePayloads): Record<string, NativeCompletedPayloadOrigin> {
  return Object.fromEntries(
    payloads.products.map((product) => [
      product.id,
      {
        publication: {
          product: product.id,
          version: product.version,
          tagName: `${product.id}-v${product.version}`,
          publicationSha: payloads.source.commit,
          publicationTree: payloads.source.tree,
          releaseSha: payloads.source.commit,
        },
        payloads: structuredClone(payloads),
      },
    ]),
  );
}

// These synthetic adapters exercise only the conditional comparison contract.
// They are not an authenticated completed origin or real qualification adapter.
function verification(payloads: NativePayloads, product: NativePayloadProduct) {
  return {
    source: payloads.source,
    product: product.id,
    version: product.version,
    payloadDigest: nativePayloadDigest(product),
    deliveredPayloads: product.roots.map(({ name, role, configuration, outputs }) => ({
      name,
      role,
      configuration,
      outputs: outputs.map(({ path: output, members }) => ({
        name: path.posix.basename(output),
        members: structuredClone(members),
      })),
    })),
  } satisfies NativeDeliveryVerification;
}
const syntheticVerifiers = {
  verifyOrigin: async (origin, product) => ({
    ...verification(origin.payloads, product),
    publication: origin.publication,
  }),
  verifyQualifiedCoverage: async (current, product) => verification(current, product),
};

test('captures only declared internal roots and binds their physical bytes to the exact source', async () => {
  await fixture(({ capture, cohort, directory }) => {
    const value = capture();
    expect(value.payloads.scope).toBe('construction');
    expect(value.payloads.source).toEqual(initial);
    expect(value.payloads.products).toHaveLength(3);
    const root = value.payloads.products.find(({ id }) => id === 'tools')!.roots[0];
    expect(root.outputs[0].members.find(({ path }) => path === 'LICENSE')).toMatchObject({
      type: 'file',
      mode: 0o644,
      size: 17,
    });
    const foreign = Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(cohort),
        source: { value: updated, enumerable: true },
      },
    ) as NativePayloadCohort;
    expect(() =>
      captureNativePreEnvelopePayloads([foreign], {
        source: initial,
        products: [{ id: 'tools', version: '1.0.0' }],
      }),
    ).toThrow('frozen source');
    expect(() => capture({ ...initial, commit: 'main' })).toThrow('exact source');
    writeFileSync(path.join(directory('tools'), 'LICENSE'), 'changed legal bytes');
    expect(() => value.assertUnchanged()).toThrow('changed after capture');
  });
});

test('compiler and ABI evidence stays outside payloads while final input roles remain captured', async () => {
  await fixture(async ({ capture, cohort, executionRoot }) => {
    const original = capture().payloads;
    const payload = cohort.roots[0];
    const outputs = ['android-arm64', 'android-x86_64'].map((target) => {
      const file = `bazel-out/${target}/bin/runtime/liboliphaunt.so`;
      mkdirSync(path.dirname(path.join(executionRoot, file)), { recursive: true });
      writeFileSync(path.join(executionRoot, file), `${target} compiler evidence`);
      return { path: file, owner: '//fixture/runtime:library' };
    });
    for (const role of ['compiled-source', 'abi-contract'])
      cohort.roots.push({
        label: `//fixture/runtime:${role}`,
        package: { ...payload.package, name: `runtime-${role}`, role, outputs },
      });
    expect(capture().payloads).toEqual(original);

    cohort.roots.push({
      label: '//fixture/runtime:frozen',
      package: {
        ...payload.package,
        name: 'runtime-frozen',
        role: 'extension-release-frozen-input',
        outputs: [outputs[0]],
      },
    });
    const captured = capture().payloads.products.find(({ id }) => id === payload.package.product);
    expect(captured?.roots.map(({ name }) => name)).toEqual([
      'runtime-frozen',
      'runtime-public-payload',
    ]);
    payload.package.outputs = outputs;
    expect(() => capture()).toThrow('ambiguous native payload output');
  });
});

test('missing origin, qualification or complete shipping-mode contract stays unknown', async () => {
  await fixture(async ({ capture }) => {
    const current = capture().payloads;
    const previous = origins(current);
    expect(
      (await compareNativePreEnvelopeDelivery(current, {})).products.every(
        ({ necessaryDelivery }) => necessaryDelivery === 'unknown',
      ),
    ).toBe(true);
    const unchecked = await compareNativePreEnvelopeDelivery(current, previous);
    expect(unchecked.products.map(({ reason }) => reason)).toEqual([
      'completed-origin-unverified',
      'completed-origin-unverified',
      'completed-origin-unverified',
    ]);
    const noQualification = await compareNativePreEnvelopeDelivery(current, previous, {
      verifyOrigin: syntheticVerifiers.verifyOrigin,
    });
    expect(
      noQualification.products.every(({ necessaryDelivery }) => necessaryDelivery === 'unknown'),
    ).toBe(true);
    await expect(
      compareNativePreEnvelopeDelivery(current, previous, {
        verifyOrigin: async () => true as any,
      }),
    ).rejects.toThrow('publication');
    await expect(
      compareNativePreEnvelopeDelivery(current, previous, {
        ...syntheticVerifiers,
        verifyQualifiedCoverage: async () => ({ label: '//fixture:qualified' }) as any,
      }),
    ).rejects.toThrow('captured product/source/payload');
  });
});

test('input and toolchain checks do not require delivery when qualified members are identical', async () => {
  await fixture(async ({ capture }) => {
    const baseline = origins(capture().payloads);
    const current = capture(updated).payloads;
    const result = await compareNativePreEnvelopeDelivery(current, baseline, {
      ...syntheticVerifiers,
      affectedProducts: ['runtime', 'tools', 'sdk'],
    });
    expect(result.scope).toBe('construction');
    expect(result.products.every(({ affectedBuild }) => affectedBuild === 'required')).toBe(true);
    expect(
      result.products.every(({ necessaryDelivery }) => necessaryDelivery === 'not-needed'),
    ).toBe(true);
  });
});

test('own envelope versions and undeclared metadata do not erase or introduce payload differences', async () => {
  await fixture(async ({ capture, cohort, products }) => {
    const baseline = origins(capture().payloads);
    const renamedVersions = products.map(({ id }) => ({ id, version: '2.0.0' }));
    const metadataOnly = {
      executionRoot: cohort.executionRoot,
      source: updated,
      roots: cohort.roots.map((root: any) => ({
        ...root,
        package: { ...root.package, version: '2.0.0' },
      })),
      aquery: {},
    };
    metadataOnly.roots.push({
      label: '//fixture:unused_envelope',
      package: {
        product: 'tools',
        version: '2.0.0',
        ecosystem: 'npm',
        name: '@fixture/tools',
        role: 'facade',
        configuration: 'portable',
        outputs: [
          { path: 'bazel-out/missing/version-and-vcs-envelope.tgz', owner: '//fixture:unused' },
        ],
      },
    });
    const current = capture(updated, renamedVersions, [metadataOnly]).payloads;
    const result = await compareNativePreEnvelopeDelivery(current, baseline, syntheticVerifiers);
    expect(
      result.products.every(({ necessaryDelivery }) => necessaryDelivery === 'not-needed'),
    ).toBe(true);
    expect(current.products.every(({ roots }) => roots.length === 1)).toBe(true);
  });
});

test('a singleton TreeArtifact wrapper rename preserves the same declared delivered members', async () => {
  await fixture(async ({ capture, cohort, directory }) => {
    const baseline = origins(capture().payloads);
    const root = cohort.roots[0] as any;
    renameSync(
      directory('runtime'),
      path.join(path.dirname(directory('runtime')), 'renamed_wrapper'),
    );
    root.package.outputs[0].path = 'bazel-out/fixture/bin/runtime/renamed_wrapper';
    const current = capture(updated).payloads;
    const result = await compareNativePreEnvelopeDelivery(current, baseline, syntheticVerifiers);
    expect(
      result.products.every(({ necessaryDelivery }) => necessaryDelivery === 'not-needed'),
    ).toBe(true);
    expect(current.products.find(({ id }) => id === 'runtime')!.roots[0].outputs[0].path).toEndWith(
      '/renamed_wrapper',
    );
  });
});

test('a directly delivered singleton File rename remains a delivery difference', async () => {
  await fixture(
    async ({ capture, cohort, executionRoot }) => {
      const original = 'bazel-out/fixture/bin/tools/delivered.so';
      const renamed = 'bazel-out/fixture/bin/tools/renamed.so';
      writeFileSync(path.join(executionRoot, original), 'exact delivered library bytes');
      chmodSync(path.join(executionRoot, original), 0o644);
      const output = cohort.roots[0].package.outputs[0];
      output.path = original;
      const baseline = origins(capture().payloads);
      renameSync(path.join(executionRoot, original), path.join(executionRoot, renamed));
      output.path = renamed;
      const current = capture(updated).payloads;
      expect(current.products[0].roots[0].outputs[0].members[0]).toMatchObject({
        path: '',
        type: 'file',
      });
      const result = await compareNativePreEnvelopeDelivery(current, baseline, syntheticVerifiers);
      expect(result.products[0].necessaryDelivery).toBe('needed');
    },
    ['tools'],
  );
});

test('raw Bazel modes need the actual complete delivered archive contract rather than guessed chmod', async () => {
  await fixture(
    async ({ capture, directory, executionRoot }) => {
      const before = capture().payloads;
      const baseline = origins(before);
      const product = before.products[0];
      const packed = async (payloads: NativePayloads, destination: string) => {
        // Exercise the existing archive writer/reader with a declared fixture
        // contract. Synthetic trust adapters below still grant no real admission.
        await archiveDirectory(directory('tools'), destination, {
          modes: { LICENSE: 0o644, 'lib/module.bin': 0o644 },
        });
        const entries = [...readPortableArchiveEntries(destination).values()];
        const proof = verification(payloads, payloads.products[0]);
        for (const member of proof.deliveredPayloads[0].outputs[0].members) {
          if (member.path === '') continue; // The portable reader omits the archive's root marker.
          const entry = entries.find(
            ({ name }) => name.replace(/\/$/u, '').replace(/^\.$/u, '') === member.path,
          );
          expect(entry).toBeDefined();
          member.mode = entry!.mode & 0o777;
        }
        return proof;
      };
      const verifiedBefore = await packed(before, path.join(executionRoot, 'before.tar.gz'));
      chmodSync(path.join(directory('tools'), 'LICENSE'), 0o555);
      const current = capture(updated).payloads;
      expect(
        current.products[0].roots[0].outputs[0].members.find(({ path }) => path === 'LICENSE')!
          .mode,
      ).toBe(0o555);
      const unchecked = await compareNativePreEnvelopeDelivery(current, baseline, {
        verifyOrigin: async () => ({
          ...verifiedBefore,
          publication: baseline[product.id].publication,
        }),
      });
      expect(unchecked.products[0].necessaryDelivery).toBe('unknown');
      const verifiedAfter = await packed(current, path.join(executionRoot, 'after.tar.gz'));
      expect(readFileSync(path.join(executionRoot, 'after.tar.gz'))).toEqual(
        readFileSync(path.join(executionRoot, 'before.tar.gz')),
      );
      const result = await compareNativePreEnvelopeDelivery(current, baseline, {
        verifyOrigin: async () => ({
          ...verifiedBefore,
          publication: baseline[product.id].publication,
        }),
        verifyQualifiedCoverage: async () => verifiedAfter,
      });
      expect(result.products[0].necessaryDelivery).toBe('not-needed');
    },
    ['tools'],
  );
});

test('zero, few and many delivered changes select only the corresponding conditional decisions', async () => {
  await fixture(
    async ({ capture, directory, products }) => {
      const baseline = origins(capture().payloads);
      const compare = () =>
        compareNativePreEnvelopeDelivery(capture(updated).payloads, baseline, {
          ...syntheticVerifiers,
          affectedProducts: [],
        });
      expect(
        (await compare()).products.every(
          ({ necessaryDelivery }) => necessaryDelivery === 'not-needed',
        ),
      ).toBe(true);
      for (const id of ['product-2', 'product-5'])
        writeFileSync(path.join(directory(id), 'lib/module.bin'), 'actual changed library');
      expect(
        (await compare()).products
          .filter(({ necessaryDelivery }) => necessaryDelivery === 'needed')
          .map(({ product }) => product),
      ).toEqual(['product-2', 'product-5']);
      for (const { id } of products)
        writeFileSync(path.join(directory(id), 'LICENSE'), 'new shipped legal text');
      expect(
        (await compare()).products.every(({ necessaryDelivery }) => necessaryDelivery === 'needed'),
      ).toBe(true);
    },
    Array.from({ length: 8 }, (_, index) => `product-${index}`),
  );
});

test('held consumed compatibility stays unchanged until its actual declared payload is adopted', async () => {
  await fixture(async ({ capture, directory }) => {
    const manifest = path.join(directory('sdk'), 'consumed-runtime.json');
    writeFileSync(manifest, '{"native_runtime":"0.3.2"}');
    const baseline = origins(capture().payloads);
    writeFileSync(path.join(directory('runtime'), 'lib/module.bin'), 'new runtime construction');
    const compare = () =>
      compareNativePreEnvelopeDelivery(capture(updated).payloads, baseline, syntheticVerifiers);
    expect(
      (await compare()).products.find(({ product }) => product === 'sdk')!.necessaryDelivery,
    ).toBe('not-needed');
    writeFileSync(manifest, '{"native_runtime":"0.3.3"}');
    expect(
      (await compare()).products.find(({ product }) => product === 'sdk')!.necessaryDelivery,
    ).toBe('needed');
  });
});

test('member renames, executable modes and public compiled version bytes remain delivery differences', async () => {
  for (const mutate of [
    (directory) => {
      rmSync(path.join(directory, 'lib/module.bin'));
      writeFileSync(path.join(directory, 'lib/renamed.bin'), 'tools public bytes');
    },
    (directory) => chmodSync(path.join(directory, 'lib/module.bin'), 0o755),
    (directory) =>
      writeFileSync(path.join(directory, 'lib/module.bin'), 'public version API 1.0.1'),
  ])
    await fixture(async ({ capture, directory }) => {
      const baseline = origins(capture().payloads);
      mutate(directory('tools'));
      const result = await compareNativePreEnvelopeDelivery(
        capture(updated).payloads,
        baseline,
        syntheticVerifiers,
      );
      expect(result.products.find(({ product }) => product === 'tools')!.necessaryDelivery).toBe(
        'needed',
      );
      expect(
        result.products
          .filter(({ product }) => product !== 'tools')
          .every(({ necessaryDelivery }) => necessaryDelivery === 'not-needed'),
      ).toBe(true);
    });
});

test('missing a required module is unknown when the actual qualification contract cannot complete', async () => {
  await fixture(async ({ capture, directory }) => {
    const baseline = origins(capture().payloads);
    rmSync(path.join(directory('tools'), 'lib/module.bin'));
    const result = await compareNativePreEnvelopeDelivery(capture(updated).payloads, baseline, {
      ...syntheticVerifiers,
      verifyQualifiedCoverage: async (current, product) =>
        product.id === 'tools' ? undefined : verification(current, product),
    });
    expect(result.products.find(({ product }) => product === 'tools')).toMatchObject({
      necessaryDelivery: 'unknown',
      reason: 'qualified-delivery-contract-unverified',
    });
  });
});

test('bootstrap and source-only products without declared pre-envelope roots are unknown', async () => {
  await fixture(async ({ capture, products, cohort }) => {
    const selected = [
      ...products,
      { id: 'first-native', version: '0.0.0' },
      { id: 'source-only', version: '1.0.0' },
    ];
    const baseline = origins(capture().payloads);
    const current = capture(updated, selected, [cohort]).payloads;
    const result = await compareNativePreEnvelopeDelivery(current, baseline, syntheticVerifiers);
    expect(
      result.products
        .filter(({ product }) => ['first-native', 'source-only'].includes(product))
        .every(
          ({ necessaryDelivery, reason }) =>
            necessaryDelivery === 'unknown' && reason === 'current-pre-envelope-roots-missing',
        ),
    ).toBe(true);
  });
});

test('source, completed publication, snapshot and complete delivered member bindings cannot be substituted', async () => {
  await fixture(async ({ capture }) => {
    const current = capture(updated).payloads;
    const baseline = origins(capture().payloads);
    for (const substitute of [
      (proof) => {
        proof.source = initial;
      },
      (proof) => {
        proof.payloadDigest = '0'.repeat(64);
      },
      (proof) => {
        proof.deliveredPayloads[0].outputs[0].members.pop();
      },
      (proof) => {
        proof.deliveredPayloads[0].outputs[0].members.find(({ type }) => type === 'file').sha256 =
          '0'.repeat(64);
      },
    ])
      await expect(
        compareNativePreEnvelopeDelivery(current, baseline, {
          ...syntheticVerifiers,
          verifyQualifiedCoverage: async (value, product) => {
            const proof = verification(value, product);
            substitute(proof);
            return proof;
          },
        }),
      ).rejects.toThrow();
    baseline.tools.publication.publicationSha = '9'.repeat(40);
    await expect(
      compareNativePreEnvelopeDelivery(current, baseline, syntheticVerifiers),
    ).rejects.toThrow('completed origin');
  });
});

test('declared output boundaries reject traversal, symlinks and missing physical payloads', async () => {
  await fixture(({ capture, cohort, directory }) => {
    const output = cohort.roots[0] as any;
    output.package.outputs[0].path = 'bazel-out/fixture/bin/runtime/../tools/public_payload';
    expect(capture).toThrow('unsafe');
    output.package.outputs[0].path = 'bazel-out/fixture/bin/runtime/public_payload';
    rmSync(path.join(directory('runtime'), 'LICENSE'));
    symlinkSync(
      path.join(directory('tools'), 'LICENSE'),
      path.join(directory('runtime'), 'LICENSE'),
    );
    expect(capture).toThrow('regular file or directory');
    rmSync(directory('runtime'), { recursive: true });
    expect(capture).toThrow();
  });
});
