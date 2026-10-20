import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDirectory } from '../packaging/archive-directory.mts';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import { buildShippingInputView } from './bazel-shipping-inputs.mts';
import { createCompletedPublicationChecker } from './completed-release-publication.mts';
import { validateReleaseConsumerCompatibility } from './consumer-compatibility.mts';
import { defaultExtensionReleasePlan } from './default-extension-release-plan.mts';
import {
  captureCompletedNativePublicArtifacts,
  captureCompletedNativeRegistryCarriers,
  nativeArchiveDeliveryMembers,
} from './native-completed-delivery.mts';
import { captureCompletedNativeArchiveDelivery } from './native-publication-delivery.mts';
import {
  captureNativeInputMembers,
  captureNativeOutputMembers,
} from './native-publication-staging.mts';
import {
  type NativeShippingSupplier,
  projectNativeBuildBoundSuppliers,
} from './native-shipping-suppliers.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { expectedProductArtifactRows } from './publication-lock.mts';
import { ROOT } from './release-graph.mts';

const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const github = {
  repository: 'f0rr0/oliphaunt',
  workflow: 'Native Bazel qualification',
  workflowPath: '.github/workflows/bazel.yml',
  runId: 123,
  runAttempt: 1,
  job: 'Linux runtime',
};
const product = 'liboliphaunt-native';
const consumer = 'fixture-extension';
const version = '0.3.3';
const configuration = 'linux-x64-gnu';
const currentFile = 'bazel-out/cfg/bin/runtime/liboliphaunt.so';
const heldFile = 'external/held/lib/liboliphaunt.so';
const header = 'external/postgres/pg_config.h';
const publication = {
  product,
  version,
  tagName: `${product}-v${version}`,
  publicationSha: 'c'.repeat(40),
  publicationTree: 'd'.repeat(40),
  releaseSha: 'e'.repeat(40),
};
const artifact = `liboliphaunt-${version}-${configuration}.tar.gz`;
const products = {
  [product]: { version },
  [consumer]: { version: '1.0.0' },
  'fixture-source': { version: '2.0.0' },
};
function current(binding: NativeShippingSupplier['binding'] = 'compiled-input') {
  return {
    product,
    version,
    configuration,
    binding,
    origin: { kind: 'current-source' as const },
    files: [{ path: binding === 'abi-contract' ? header : currentFile }],
  };
}
function held() {
  return {
    product,
    version,
    configuration,
    binding: 'compiled-input' as const,
    origin: {
      kind: 'completed-publication' as const,
      publication: structuredClone(publication),
      artifact,
    },
    files: [{ path: heldFile, member: 'lib/liboliphaunt.so' }],
  };
}

async function fixture(run, mode = 'current', targets = [configuration]) {
  const executionRoot = mkdtempSync(path.join(os.tmpdir(), 'native-supplier-files-'));
  try {
    const write = (name, contents) => {
      mkdirSync(path.dirname(path.join(executionRoot, name)), { recursive: true });
      writeFileSync(path.join(executionRoot, name), contents);
    };
    write(currentFile, 'current runtime bytes');
    write(heldFile, 'authentic fixture published runtime bytes');
    write(header, '#define POSTGRES_ABI 18\n');
    write('runtime/source.c', 'current source');
    write('source/README.md', 'public source docs');
    const layouts = [
      { label: '//runtime:library', output: currentFile, inputs: ['runtime/source.c'] },
      {
        label: '//extensions:server',
        output: 'bazel-out/cfg/bin/extensions/server.so',
        inputs: [header],
      },
      {
        label: '//extensions:embedded',
        output: 'bazel-out/cfg/bin/extensions/embedded.so',
        inputs: [mode === 'held' ? heldFile : currentFile, header],
      },
      {
        label: '//source:archive',
        output: 'bazel-out/cfg/bin/source/source.crate',
        inputs: ['source/README.md'],
      },
    ];
    for (const row of layouts.slice(1)) write(row.output, `built ${row.label}`);
    const files = [...new Set(layouts.flatMap((row) => [row.output, ...row.inputs]))];
    const aquery = {
      pathFragments: files.flatMap((name, i) =>
        name.split('/').map((label, segment) => ({
          id: `${i}-${segment}`,
          label,
          ...(segment ? { parentId: `${i}-${segment - 1}` } : {}),
        })),
      ),
      artifacts: files.map((name, i) => ({
        id: i + 1,
        pathFragmentId: `${i}-${name.split('/').length - 1}`,
      })),
      targets: layouts.map(({ label }, i) => ({ id: i + 1, label })),
      configuration: [{ id: 1, checksum: 'f'.repeat(64) }],
      depSetOfFiles: layouts.map(({ inputs }, i) => ({
        id: i + 1,
        directArtifactIds: inputs.map((name) => files.indexOf(name) + 1),
      })),
      actions: layouts.map(({ output }, i) => ({
        targetId: i + 1,
        configurationId: 1,
        actionKey: `fixture-action-${i}`,
        mnemonic: 'FixtureProducer',
        inputDepSetIds: [i + 1],
        outputIds: [files.indexOf(output) + 1],
        primaryOutputId: files.indexOf(output) + 1,
      })),
    };
    const roots = layouts.map(({ label, output }, i) => ({
      label: `${label}_shipping`,
      package: {
        product: i === 0 ? product : i === 3 ? 'fixture-source' : consumer,
        version: i === 0 ? version : i === 3 ? '2.0.0' : '1.0.0',
        ecosystem: 'internal',
        name: label,
        configuration,
        role: 'construction',
        outputs: [{ path: output, owner: label }],
        supplierInputs:
          i === 1
            ? [current('abi-contract')]
            : i === 2
              ? [mode === 'held' ? held() : current()]
              : [],
      },
    }));
    const view = buildShippingInputView(
      {
        schema: 'oliphaunt-bazel-shipping-v1',
        scope: 'construction',
        packages: roots.map((root) => root.package),
      },
      aquery,
    );
    const cohort = {
      executionRoot,
      roots,
      rootConfigurations: roots.map(({ label }) => ({ label, configuration: 'f'.repeat(64) })),
      aquery,
      inputs: view.physicalInputs.map((name) => ({
        path: name,
        members: captureNativeInputMembers(executionRoot, name).members,
      })),
      outputs: [],
      buildEvents: [],
    };
    // This controlled transport fixture supplies the observer's documented
    // precondition. It makes no real GitHub/build qualification assertion.
    const observation = {
      products: Object.entries(products).map(([id, metadata]) => ({
        product: { id, ...metadata },
      })),
      coverage: { completeProductInventory: true },
      authenticated: [
        {
          evidence: { source: structuredClone(source), github, cohorts: [cohort] },
          origin: { github },
          qualification: {
            source: structuredClone(source),
            github,
            shippingAnalysis: 'bound',
            testQualification: 'passed',
            requiredTests: [{ label: '//fixture:test', configuration: 'f'.repeat(64) }],
          },
        },
      ],
    };
    const published = path.join(executionRoot, 'published');
    mkdirSync(path.join(published, 'lib'), { recursive: true });
    writeFileSync(
      path.join(published, 'lib/liboliphaunt.so'),
      readFileSync(path.join(executionRoot, heldFile)),
    );
    const archives = [];
    for (const target of targets) {
      const name = `liboliphaunt-${version}-${target}.tar.gz`;
      const file = path.join(executionRoot, name);
      await archiveDirectory(published, file);
      archives.push({ name, target, file, bytes: readFileSync(file) });
    }
    let reads = 0;
    const authenticateCompleted = (input) =>
      captureCompletedNativeArchiveDelivery(input, {
        assertCompletedPublication: async (expected) => {
          expect(expected).toEqual(publication);
          return publication;
        },
        readJson: async () => ({
          id: 11,
          tag_name: publication.tagName,
          target_commitish: publication.publicationSha,
          draft: false,
          prerelease: false,
        }),
        readPages: async () => {
          reads++;
          return archives.map(({ name, bytes }, index) => ({
            id: 12 + index,
            name,
            size: bytes.length,
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            state: 'uploaded',
            url: `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${12 + index}`,
          }));
        },
      });
    const input = {
      products: structuredClone(products),
      source,
      observation: observation as any,
      completed: [{ publication, files: archives.map(({ target, file }) => ({ target, file })) }],
    };
    const project = () => projectNativeBuildBoundSuppliers(input, { authenticateCompleted });
    await run({
      input,
      project,
      roots,
      cohort,
      observation,
      authenticateCompleted,
      readCount: () => reads,
      executionRoot,
    });
  } finally {
    rmSync(executionRoot, { recursive: true, force: true });
  }
}

test('exact current File adds one edge; server ABI and source-only packages add none', async () => {
  await fixture(async ({ project }) => {
    const result = await project();
    expect(result.unknowns).toEqual([]);
    expect([...result.buildBound!.get(consumer)!]).toEqual([product]);
    expect([...result.buildBound!.get(product)!]).toEqual([]);
    expect([...result.buildBound!.get('fixture-source')!]).toEqual([]);
    expect(result.scope).toBe('construction');
  });
});

test('same-version held member is independently archive-authenticated and stays held', async () => {
  await fixture(async ({ project, readCount }) => {
    const result = await project();
    expect([...result.buildBound!.get(consumer)!]).toEqual([]);
    expect(result.suppliers.find((row) => row.binding === 'compiled-input')!.version).toBe(version);
    expect(readCount()).toBe(1);
  }, 'held');
});

test('one completed publication keeps Cargo and GitHub supplier contexts distinct', async () => {
  await fixture(async ({ input, roots, cohort, executionRoot }) => {
    const carrier = 'cargo:liboliphaunt-native';
    const cargoRoot = path.join(executionRoot, 'cargo-origin');
    mkdirSync(path.join(cargoRoot, 'include'), { recursive: true });
    const bytes = readFileSync(path.join(executionRoot, header));
    writeFileSync(path.join(cargoRoot, 'include/pg_config.h'), bytes);
    const cargo = path.join(executionRoot, 'cargo-origin.tar.gz');
    await archiveDirectory(cargoRoot, cargo);
    roots[1].package.supplierInputs = [
      {
        ...held(),
        configuration: 'portable',
        binding: 'abi-contract',
        origin: { kind: 'completed-publication', publication, artifact: carrier },
        files: [{ path: header, member: 'include/pg_config.h' }],
      },
    ];
    input.completed.push({ publication, carriers: { [carrier]: [cargo] } } as any);
    const seen: string[] = [];
    // Controlled origins exercise selection and caching; no live authentication claim.
    const authenticateCompleted = async (context) => {
      const registry = 'carriers' in context;
      const entry = readPortableArchiveEntries(
        registry ? context.carriers[carrier][0] : context.files[0].file,
      ).get(registry ? 'include/pg_config.h' : 'lib/liboliphaunt.so')!;
      const name = registry ? carrier : artifact;
      seen.push(name);
      return {
        publication,
        archives: [
          {
            name,
            target: registry ? 'portable' : configuration,
            members: [
              {
                path: registry ? 'include/pg_config.h' : 'lib/liboliphaunt.so',
                type: 'file',
                size: entry.size,
                sha256: createHash('sha256').update(entry.data()).digest('hex'),
              },
            ],
          },
        ],
      };
    };
    const project = () => projectNativeBuildBoundSuppliers(input, { authenticateCompleted });
    expect((await project()).unknowns).toEqual([]);
    expect(seen.sort()).toEqual([carrier, artifact].sort());
    input.completed.push(structuredClone(input.completed[1]));
    await expect(project()).rejects.toThrow('ambiguous completed supplier archive input');
    input.completed.pop();
    cohort.inputs.find(({ path }) => path === header)!.members[0].sha256 = '0'.repeat(64);
    await expect(project()).rejects.toThrow('published member bytes');
  }, 'held');
});

test('completed supplier projection preserves the original metadata capability while cloning structural facts', async () => {
  await fixture(async ({ input }) => {
    const metadataBaseline = { originalAuthenticatedObject: true };
    input.completed[0].metadataBaseline = metadataBaseline;
    const original = input.completed[0];
    await expect(
      projectNativeBuildBoundSuppliers(input, {
        authenticateCompleted: (snapshot) => {
          expect(snapshot).not.toBe(original);
          expect(snapshot.metadataBaseline).toBe(metadataBaseline);
          expect(snapshot.publication).not.toBe(original.publication);
          // The existing completed reader still decides authenticity. A clone
          // must never replace the capability it is asked to verify.
          throw new Error('completed metadata authenticity remains mandatory');
        },
      }),
    ).rejects.toThrow('completed metadata authenticity remains mandatory');
  }, 'held');
});

test('genuine completed registry source is bound by raw archive bytes, independent of its File path', async () => {
  await fixture(async ({ input, roots, cohort, executionRoot, observation }) => {
    const root = path.join(import.meta.dir, 'testdata/native-source-carriers');
    const captured = JSON.parse(readFileSync(path.join(root, 'captured-publication.json'), 'utf8'));
    const readJson = async (endpoint) => {
      if (!Object.hasOwn(captured.responses, endpoint))
        throw new Error(`uncaptured source ${endpoint}`);
      return structuredClone(captured.responses[endpoint]);
    };
    const assertCompletedPublication = createCompletedPublicationChecker({
      repository: 'f0rr0/oliphaunt',
      readJson,
      listPullRequests: async () => captured.pullRequests,
      readPages: async () => {
        throw new Error('unexpected history');
      },
    });
    const completed = await assertCompletedPublication({
      product: 'oliphaunt-query',
      version: '0.1.1',
      tagName: 'oliphaunt-query-v0.1.1',
      publicationSha: 'c51052fe8b8ffc7e992266c5ab3d7a63b47441e7',
    });
    const archive = path.join(root, 'oliphaunt-query-0.1.1.crate');
    const bytes = readPortableArchiveEntries(archive)
      .get('oliphaunt-query-0.1.1/Cargo.toml')!
      .data();
    writeFileSync(path.join(executionRoot, heldFile), bytes);
    cohort.inputs.find(({ path: name }) => name === heldFile)!.members = captureNativeInputMembers(
      executionRoot,
      heldFile,
    ).members;
    delete input.products[product];
    input.products[completed.product] = { version: completed.version };
    const metadata = observation.products.find(({ product: row }) => row.id === product)!.product;
    metadata.id = completed.product;
    metadata.version = completed.version;
    roots[0].package.product = completed.product;
    roots[0].package.version = completed.version;
    roots[1].package.supplierInputs = [];
    roots[2].package.supplierInputs = [
      {
        product: completed.product,
        version: completed.version,
        configuration: 'portable',
        binding: 'compiled-input',
        origin: {
          kind: 'completed-publication',
          publication: completed,
          artifact: 'cargo:oliphaunt-query',
        },
        files: [{ path: heldFile, member: 'Cargo.toml' }],
      },
    ];
    input.completed = [
      { publication: completed, carriers: { 'cargo:oliphaunt-query': [archive] } },
    ] as any;
    const authenticateCompleted = (origin) =>
      captureCompletedNativeRegistryCarriers(origin, {
        assertCompletedPublication,
        readJson,
        registryOptions: {
          cratesIoReadGate: null,
          fetchImpl: async () => Response.json(captured.registryMetadata.cargo),
        },
      });
    const result = await projectNativeBuildBoundSuppliers(input, { authenticateCompleted });
    expect(result.unknowns).toEqual([]);
    expect([...result.buildBound!.get(consumer)!]).toEqual([]);
    expect(result.suppliers[0].origin).toEqual(roots[2].package.supplierInputs[0].origin);
    cohort.inputs.find(({ path: name }) => name === heldFile)!.members[0].sha256 = '0'.repeat(64);
    await expect(
      projectNativeBuildBoundSuppliers(input, { authenticateCompleted }),
    ).rejects.toThrow('published member bytes');
  }, 'held');
});

test('held WASIX payload uses canonical completed public archive members, never its Cargo File name', async () => {
  await fixture(async ({ input, roots, cohort, observation, executionRoot }) => {
    const id = 'liboliphaunt-wasix';
    const heldVersion = '0.3.2';
    const completed = {
      ...publication,
      product: id,
      version: heldVersion,
      tagName: `${id}-v${heldVersion}`,
    };
    const descriptor = loadPublicationCatalog('supplier fixture', { products: [id] }).products[0];
    const rows = expectedProductArtifactRows([{ ...descriptor, version: heldVersion }]).filter(
      ({ role }) => role === 'github-release-asset' || role === 'github-release-metadata',
    );
    const row = rows.find(({ kind }) => kind === 'wasix-runtime')!;
    const published = path.join(executionRoot, 'wasix-published');
    mkdirSync(path.join(published, 'bin'), { recursive: true });
    const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    writeFileSync(path.join(published, 'bin/initdb.wasix.wasm'), bytes);
    const archive = path.join(executionRoot, row.name);
    await archiveDirectory(published, archive);
    const archiveBytes = readFileSync(archive);
    const sha256 = createHash('sha256').update(archiveBytes).digest('hex');
    delete input.products[product];
    input.products[id] = { version: heldVersion };
    observation.products = Object.entries(input.products).map(([id, metadata]) => ({
      product: { id, ...metadata },
    }));
    roots[0].package.product = id;
    roots[0].package.version = heldVersion;
    roots[1].package.supplierInputs = [];
    roots[2].package.configuration = 'portable';
    roots[2].package.supplierInputs = [
      {
        product: id,
        version: heldVersion,
        configuration: row.target,
        binding: 'compiled-input',
        origin: { kind: 'completed-publication', publication: completed, artifact: row.id },
        files: [{ path: heldFile, member: 'bin/initdb.wasix.wasm' }],
      },
    ];
    const capture = cohort.inputs.find(({ path }) => path === heldFile)!;
    writeFileSync(path.join(executionRoot, heldFile), bytes);
    capture.members = captureNativeInputMembers(executionRoot, heldFile).members;
    input.completed = [{ publication: completed, files: { [row.id]: archive } }] as any;
    let publicRows = rows;
    const authenticateCompleted = (input) =>
      captureCompletedNativePublicArtifacts(input, {
        assertCompletedPublication: async (requested) => {
          expect(requested).toEqual(completed);
          return completed;
        },
        readJson: async (endpoint) => {
          const prefix = 'repos/f0rr0/oliphaunt/contents/';
          if (!endpoint.startsWith(prefix))
            return {
              id: 11,
              tag_name: completed.tagName,
              target_commitish: completed.publicationSha,
              draft: false,
              prerelease: false,
            };
          expect(endpoint.endsWith(`?ref=${completed.publicationSha}`)).toBe(true);
          const file = endpoint.slice(prefix.length).split('?ref=')[0];
          let text = readFileSync(path.join(ROOT, file), 'utf8');
          if (file === '.release-please-manifest.json') {
            const versions = JSON.parse(text);
            versions[descriptor.path] = completed.version;
            text = JSON.stringify(versions);
          }
          const bytes = Buffer.from(text);
          return {
            type: 'file',
            path: file,
            encoding: 'base64',
            content: bytes.toString('base64'),
            sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
          };
        },
        readPages: async () =>
          publicRows.map((expected, index) => ({
            id: index + 12,
            name: expected.name,
            size: expected.id === row.id ? archiveBytes.length : 1,
            digest: `sha256:${expected.id === row.id ? sha256 : '1'.repeat(64)}`,
            state: 'uploaded',
            url: `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${index + 12}`,
          })),
      });
    const project = () => projectNativeBuildBoundSuppliers(input, { authenticateCompleted });
    const result = await project();
    expect(result.unknowns).toEqual([]);
    expect([...result.buildBound!.get(consumer)!]).toEqual([]);
    capture.members[0].sha256 = '2'.repeat(64);
    await expect(project()).rejects.toThrow(/published member bytes/);
    capture.members = captureNativeInputMembers(executionRoot, heldFile).members;
    publicRows = rows.slice(1);
    expect((await project()).buildBound).toBeUndefined();
  }, 'held');
});

test('portable consumer binds the native supplier delivery slot independently of its own configuration', async () => {
  await fixture(async ({ roots, project }) => {
    roots[2].package.configuration = 'portable';
    const result = await project();
    const supplied = result.suppliers.find((row) => row.binding === 'compiled-input')!;
    expect(supplied.configuration).toBe(configuration);
    expect(supplied.consumerConfiguration).toBe('portable');
    expect(supplied.rootConfiguration).toBe('f'.repeat(64));
    expect([...result.buildBound!.get(consumer)!]).toEqual([product]);
  });
  await fixture(async ({ roots, project }) => {
    roots[2].package.configuration = 'portable';
    expect([...(await project()).buildBound!.get(consumer)!]).toEqual([]);
  }, 'held');
});

test('different held target archives from one completed release retain one conventional supplier pin', async () => {
  await fixture(
    async ({ cohort, roots, observation, project, readCount }) => {
      const other = structuredClone(cohort);
      other.roots = [structuredClone(roots[2])];
      other.roots[0].label = '//extensions:arm_shipping';
      other.roots[0].package.configuration = 'linux-arm64-gnu';
      const supplier = other.roots[0].package.supplierInputs[0];
      supplier.configuration = 'linux-arm64-gnu';
      supplier.origin.artifact = `liboliphaunt-${version}-linux-arm64-gnu.tar.gz`;
      other.rootConfigurations = [{ label: other.roots[0].label, configuration: '2'.repeat(64) }];
      other.aquery.configuration[0].checksum = '2'.repeat(64);
      observation.authenticated[0].evidence.cohorts.push(other);
      const result = await project();
      expect(result.unknowns).toEqual([]);
      expect([...result.buildBound!.get(consumer)!]).toEqual([]);
      expect(result.suppliers.filter(({ binding }) => binding === 'compiled-input')).toHaveLength(
        2,
      );
      expect(readCount()).toBe(1);
    },
    'held',
    [configuration, 'linux-arm64-gnu'],
  );
});

test('a current imported File stays unknown until its original qualified transport is bound', async () => {
  await fixture(async ({ roots, project }) => {
    roots[2].package.supplierInputs = [current()];
    roots[2].package.supplierInputs[0].files[0].path = heldFile;
    const result = await project();
    expect(result.buildBound).toBeUndefined();
    expect(result.unknowns).toContain('unverified current supplier producer transport');
    expect(result.suppliers.find(({ binding }) => binding === 'compiled-input')!.origin.kind).toBe(
      'current-source',
    );
  }, 'held');
});

test('per-package closure cannot borrow the embedded File from a same-product server sibling', async () => {
  await fixture(async ({ roots, project }) => {
    roots[1].package.supplierInputs = [current()];
    await expect(project()).rejects.toThrow(/not consumed/);
  });
});

test('a consumed consumer-owned generated File cannot be relabeled as the current core', async () => {
  await fixture(async ({ roots, cohort, project, executionRoot }) => {
    const output = roots[1].package.outputs[0].path;
    const id = cohort.aquery.actions[1].outputIds[0];
    cohort.aquery.depSetOfFiles[2].directArtifactIds.push(id);
    cohort.inputs.push({
      path: output,
      members: captureNativeInputMembers(executionRoot, output).members,
    });
    roots[2].package.supplierInputs[0].files[0].path = output;
    await expect(project()).rejects.toThrow(/own configured shipping producer/);
  });
});

test('candidate metadata cannot substitute for the configured core delivery producer', async () => {
  await fixture(async ({ roots, project }) => {
    roots[0].package.ecosystem = 'github';
    roots[0].package.role = 'github-release-metadata';
    await expect(project()).rejects.toThrow(/own configured shipping producer/);
  });
});

test('a current consumer cannot borrow its supplier producer from another cohort', async () => {
  await fixture(async ({ roots, cohort, observation, project }) => {
    const other = structuredClone(cohort);
    other.roots = [structuredClone(roots[0])];
    other.rootConfigurations = [other.rootConfigurations[0]];
    cohort.roots = roots.slice(1);
    cohort.rootConfigurations = cohort.rootConfigurations.slice(1);
    observation.authenticated[0].evidence.cohorts.push(other);
    await expect(project()).rejects.toThrow(/own configured shipping producer/);
  });
});

test('explicit empty coverage is distinct from missing/partial producing coverage', async () => {
  await fixture(async ({ roots, project, observation }) => {
    delete (roots[1].package as any).supplierInputs;
    expect((await project()).buildBound).toBeUndefined();
    roots[1].package.supplierInputs = [];
    observation.coverage.completeProductInventory = false;
    expect((await project()).buildBound).toBeUndefined();
    observation.coverage.completeProductInventory = true;
    observation.authenticated[0].qualification.shippingAnalysis = 'unverified';
    expect((await project()).buildBound).toBeUndefined();
  });
});

test('unavailable completed bytes stay unknown instead of falling back to current same-version producer', async () => {
  await fixture(async ({ input, project, readCount }) => {
    input.completed = [];
    const result = await project();
    expect(result.buildBound).toBeUndefined();
    expect(result.unknowns.join(',')).toContain('missing completed supplier bytes');
    expect(readCount()).toBe(0);
  }, 'held');
});

test('a substituted archive cannot borrow another artifact from its completed publication', async () => {
  await fixture(async ({ roots, project, readCount }) => {
    roots[2].package.supplierInputs[0].origin.artifact = 'different.tar.gz';
    const result = await project();
    expect(result.buildBound).toBeUndefined();
    expect(result.unknowns.join(',')).toContain('missing completed supplier bytes');
    expect(readCount()).toBe(0);
  }, 'held');
});

test('held captured bytes and archive member substitutions fail', async () => {
  for (const change of [
    ({ roots }) => {
      roots[2].package.supplierInputs[0].files[0].member = 'lib/missing.so';
    },
    ({ cohort }) => {
      cohort.inputs.find(({ path }) => path === heldFile).members[0].sha256 = '1'.repeat(64);
    },
  ])
    await fixture(async (f) => {
      change(f);
      await expect(f.project()).rejects.toThrow();
    }, 'held');
});

test('a substituted completed source cannot reuse bytes from another immutable origin', async () => {
  await fixture(async ({ roots, project }) => {
    (roots[2].package.supplierInputs[0].origin as any).publication.publicationSha = '1'.repeat(40);
    expect((await project()).buildBound).toBeUndefined();
  }, 'held');
});

test('current source/version/configuration and regular File coverage are exact', async () => {
  for (const change of [
    ({ observation }) => {
      observation.authenticated[0].evidence.source.commit = '1'.repeat(40);
    },
    ({ roots }) => {
      roots[2].package.supplierInputs[0].version = '0.3.2';
    },
    ({ roots }) => {
      roots[2].package.supplierInputs[0].configuration = 'linux-arm64-gnu';
    },
    ({ cohort }) => {
      cohort.inputs.find(({ path }) => path === currentFile).members = [
        { path: '', type: 'directory', mode: 0o755 },
      ];
    },
    ({ roots }) => {
      roots[2].package.supplierInputs[0].files[0].path = 'runtime/source.c';
    },
    ({ roots }) => {
      roots[2].package.supplierInputs[0].files[0].path = '../outside';
    },
  ])
    await fixture(async (f) => {
      change(f);
      await expect(f.project()).rejects.toThrow();
    });
});

test('missing, duplicate and untyped supplier facts cannot create inferred edges', async () => {
  for (const change of [
    ({ roots }) => {
      roots[2].package.supplierInputs = [current(), current()];
    },
    ({ roots }) => {
      roots[2].package.supplierInputs[0].files.push({ path: currentFile });
    },
    ({ roots }) => {
      delete roots[2].package.supplierInputs[0].origin;
    },
    ({ roots }) => {
      roots[2].package.supplierInputs[0].files = [];
    },
    ({ roots }) => {
      roots[2].package.supplierInputs[0].product = 'unowned-product';
    },
    ({ roots }) => {
      roots[2].package.supplierInputs[0].binding = 'owner-path';
    },
    ({ roots }) => {
      roots[2].package.supplierInputs[0].compiled = true;
    },
  ])
    await fixture(async (f) => {
      change(f);
      await expect(f.project()).rejects.toThrow();
    });
});

test('own-product incorporation is checked without creating a contrib version self edge', async () => {
  await fixture(async ({ roots, project }) => {
    roots[2].package.product = product;
    roots[2].package.version = version;
    roots[1].package.supplierInputs = [];
    // Keep the extension's configured server root as its explicit empty input
    // contract; ownership and supplier relationships remain independent.
    expect([...(await project()).buildBound!.get(product)!]).toEqual([]);
  });
});

test('ABI-only current origin does not conflict with held compiled supplier', async () => {
  await fixture(async ({ project }) => {
    const result = await project();
    expect(result.suppliers.map(({ binding }) => binding).sort()).toEqual([
      'abi-contract',
      'compiled-input',
    ]);
    expect([...result.buildBound!.get(consumer)!]).toEqual([]);
  }, 'held');
});

test('a changed dynamically linked core requests checks without inventing extension host adoption', async () => {
  await fixture(async ({ input, roots, cohort, executionRoot, project }) => {
    roots[2].package.supplierInputs = [
      { ...current('abi-contract'), files: [{ path: currentFile }] },
    ];
    const module = readFileSync(path.join(executionRoot, roots[2].package.outputs[0].path));
    const before = await project();
    const core = cohort.inputs.find(({ path: name }) => name === currentFile)!;
    const oldHash = core.members[0].sha256;
    writeFileSync(
      path.join(executionRoot, currentFile),
      'different core implementation; same public ABI',
    );
    core.members = captureNativeInputMembers(executionRoot, currentFile).members;
    const after = await project();
    expect(core.members[0].sha256).not.toBe(oldHash);
    expect(readFileSync(path.join(executionRoot, roots[2].package.outputs[0].path))).toEqual(
      module,
    );
    expect([...after.buildBound!.get(consumer)!]).toEqual([]);
    expect(after.buildBound).toEqual(before.buildBound);

    const metadata = structuredClone(input.products) as any;
    metadata[consumer].extension = { class: 'external' };
    metadata[consumer].compatibility_versions = { host: { source_product: product } };
    metadata['fixture-source'].kind = 'sdk';
    metadata['fixture-source'].exact_extension_runtime = product;
    metadata['fixture-source'].compatibility_versions = { host: { source_product: product } };
    const options = {
      products: metadata,
      buildBound: after.buildBound,
      readCompatibility: () => '0.3.2',
    };
    const runtimeOnly = defaultExtensionReleasePlan(metadata, [product], options);
    expect([...runtimeOnly.required]).toEqual([product]);
    expect(runtimeOnly.requirements.size).toBe(0);
    // A separately changed extension may still ship for its authored held host.
    const extensionOnly = defaultExtensionReleasePlan(metadata, [consumer], options);
    expect([...extensionOnly.required]).toEqual([consumer]);
    expect(extensionOnly.requirements.size).toBe(0);
    expect(() => validateReleaseConsumerCompatibility([consumer], options)).not.toThrow();
    expect(after.scope).toBe('construction');
  });
});

test('mixed compiled origins reject instead of unioning configurations', async () => {
  await fixture(async ({ cohort, roots, project, observation }) => {
    const other = structuredClone(cohort);
    other.roots = [structuredClone(roots[2])];
    other.roots[0].label = '//extensions:other_configuration_shipping';
    other.rootConfigurations = [{ label: other.roots[0].label, configuration: '1'.repeat(64) }];
    other.roots[0].package.supplierInputs = [held()];
    // Both Files really reach this output; do not satisfy the held assertion
    // from another root's inventory.
    const heldId = other.aquery.artifacts.length + 1;
    const index = heldId - 1;
    other.aquery.pathFragments.push(
      ...heldFile.split('/').map((label, segment) => ({
        id: `${index}-${segment}`,
        label,
        ...(segment ? { parentId: `${index}-${segment - 1}` } : {}),
      })),
    );
    other.aquery.artifacts.push({
      id: heldId,
      pathFragmentId: `${index}-${heldFile.split('/').length - 1}`,
    });
    other.aquery.depSetOfFiles[2].directArtifactIds.push(heldId);
    other.inputs.push({
      path: heldFile,
      members: [
        {
          path: '',
          type: 'file',
          mode: 0o644,
          size: 'authentic fixture published runtime bytes'.length,
          sha256: createHash('sha256')
            .update('authentic fixture published runtime bytes')
            .digest('hex'),
        },
      ],
    });
    observation.authenticated[0].evidence.cohorts.push(other);
    await expect(project()).rejects.toThrow(/conflicting current\/held/);
  });
});

async function importedFixture(run, wholeArchive = false) {
  await fixture(async (context) => {
    const { roots, cohort, observation, executionRoot } = context;
    const tree = path.join(executionRoot, 'imported-current-source');
    mkdirSync(path.join(tree, 'modules'), { recursive: true });
    writeFileSync(
      path.join(tree, 'modules/native.so'),
      readFileSync(path.join(executionRoot, heldFile)),
    );
    const output = 'bazel-out/producer/bin/runtime/bound.tar.gz';
    const archive = path.join(executionRoot, output);
    mkdirSync(path.dirname(archive), { recursive: true });
    await archiveDirectory(tree, archive);
    const original = structuredClone(cohort);
    const invocationId = 'original-linux-invocation';
    const root = structuredClone(roots[0]);
    root.label = '//runtime:bound_archive_shipping';
    root.package.ecosystem = 'github';
    root.package.role = 'github-release-asset';
    root.package.outputs = [{ path: output, owner: '//runtime:bound_archive' }];
    original.roots = [root];
    original.rootConfigurations = [{ label: root.label, configuration: '9'.repeat(64) }];
    original.outputs = [
      { path: output, members: captureNativeOutputMembers(executionRoot, output).members },
    ];
    const id = 1000;
    original.aquery.pathFragments.push(
      ...output.split('/').map((label, segment) => ({
        id: `imported-${segment}`,
        label,
        ...(segment ? { parentId: `imported-${segment - 1}` } : {}),
      })),
    );
    original.aquery.artifacts.push({
      id,
      pathFragmentId: `imported-${output.split('/').length - 1}`,
    });
    original.aquery.targets.push({ id, label: '//runtime:bound_archive' });
    original.aquery.actions.push({
      targetId: id,
      configurationId: 1,
      actionKey: 'original-archive',
      mnemonic: 'FixtureArchive',
      inputDepSetIds: [1],
      outputIds: [id],
      primaryOutputId: id,
    });
    const packetArchive = path.join(executionRoot, 'packet/files/0', output);
    mkdirSync(path.dirname(packetArchive), { recursive: true });
    writeFileSync(packetArchive, readFileSync(archive));
    const githubOrigin = { ...github, runId: 124, job: 'Original Linux builder' };
    const build = {
      evidence: { source: structuredClone(source), github: githubOrigin, cohorts: [original] },
      qualification: {
        ...structuredClone(observation.authenticated[0].qualification),
        github: githubOrigin,
        cohorts: [{ invocationId }],
      },
      origin: {
        github: githubOrigin,
        evidenceDigest: `sha256:${'7'.repeat(64)}`,
        finalFiles: {
          files: [
            {
              cohort: 0,
              path: output,
              size: original.outputs[0].members[0].size,
              sha256: original.outputs[0].members[0].sha256,
            },
          ],
          artifactRoots: [packetArchive],
          assertUnchanged() {},
        },
      },
    };
    // The fixture injects the already-authenticated observer boundary; no
    // synthetic workflow is asserted to be an actual release qualification.
    observation.authenticated.push(build);
    roots[2].package.configuration = 'macos-arm64';
    roots[2].package.supplierInputs = [
      {
        product,
        version,
        configuration,
        binding: 'compiled-input',
        origin: {
          kind: 'current-source',
          producer: {
            evidenceDigest: build.origin.evidenceDigest,
            invocationId,
            root: root.label,
            configuration: '9'.repeat(64),
            output,
          },
        },
        files: [{ path: heldFile, member: 'modules/native.so' }],
      },
    ];
    if (wholeArchive) {
      delete roots[2].package.supplierInputs[0].files[0].member;
      writeFileSync(path.join(executionRoot, heldFile), readFileSync(packetArchive));
      cohort.inputs.find(({ path: file }) => file === heldFile).members = captureNativeInputMembers(
        executionRoot,
        heldFile,
      ).members;
    }
    await run({
      ...context,
      original,
      build,
      supplier: roots[2].package.supplierInputs[0],
      packetArchive,
    });
  }, 'held');
}

test('imported current member binds the qualified invocation without inventing a raw cohort field', async () => {
  await importedFixture(async ({ project }) => {
    const result = await project();
    expect(result.unknowns).toEqual([]);
    expect([...result.buildBound!.get(consumer)!]).toEqual([product]);
    expect(
      result.suppliers.find((row) => row.origin.kind === 'current-source' && row.origin.producer)!
        .consumerConfiguration,
    ).toBe('macos-arm64');
  });
});

for (const wholeArchive of [false, true]) {
  const kind = wholeArchive ? 'whole archive' : 'member';
  test(`missing original current ${kind} evidence or transported bytes stays unknown`, async () => {
    await importedFixture(async ({ project, build, supplier }) => {
      supplier.origin.producer.evidenceDigest = `sha256:${'8'.repeat(64)}`;
      expect((await project()).buildBound).toBeUndefined();
      supplier.origin.producer.evidenceDigest = build.origin.evidenceDigest;
      delete build.origin.finalFiles;
      const result = await project();
      expect(result.buildBound).toBeUndefined();
      expect(result.unknowns).toContain(
        'missing authenticated original current supplier transport',
      );
    }, wholeArchive);
  });

  test(`current ${kind} import rejects root/configuration/member/source/run substitution`, async () => {
    for (const mutate of [
      ({ supplier }) => {
        supplier.origin.producer.root = '//runtime:another_shipping';
      },
      ({ supplier }) => {
        supplier.origin.producer.configuration = '8'.repeat(64);
      },
      ({ supplier }) => {
        supplier.origin.producer.invocationId = 'another-invocation';
      },
      ({ supplier }) => {
        supplier.origin.producer.output = 'bazel-out/producer/bin/runtime/other.tar.gz';
      },
      ({ supplier }) => {
        supplier.files[0].member = 'modules/other.so';
      },
      ({ build }) => {
        build.evidence.source.commit = 'c'.repeat(40);
      },
      ({ build }) => {
        build.origin.github = { ...build.origin.github, runAttempt: 2 };
      },
    ])
      await importedFixture(async (context) => {
        mutate(context);
        await expect(context.project()).rejects.toThrow(
          /mismatch|exact original regular|original public final/,
        );
      }, wholeArchive);
  });

  test(`imported current ${kind} transport and consumed File byte substitutions reject`, async () => {
    await importedFixture(async ({ project, packetArchive }) => {
      writeFileSync(packetArchive, 'substituted final archive');
      await expect(project()).rejects.toThrow(/physical archive/);
    }, wholeArchive);
    await importedFixture(async ({ project, cohort, executionRoot }) => {
      writeFileSync(path.join(executionRoot, heldFile), 'substituted consumer input');
      cohort.inputs.find((input) => input.path === heldFile).members = captureNativeInputMembers(
        executionRoot,
        heldFile,
      ).members;
      await expect(project()).rejects.toThrow(
        wholeArchive ? /original current outer archive bytes/ : /original current member bytes/,
      );
    }, wholeArchive);
  });
}

for (const binding of ['abi-contract', 'compiled-input'] as const)
  test(`whole imported current ${binding} archive retains original provenance and adoption semantics`, async () => {
    await importedFixture(async ({ project, supplier }) => {
      supplier.binding = binding;
      const result = await project();
      expect(result.unknowns).toEqual([]);
      expect([...result.buildBound!.get(consumer)!]).toEqual(
        binding === 'compiled-input' ? [product] : [],
      );
      expect(
        result.suppliers.find(({ origin }) => origin.kind === 'current-source' && origin.producer)!
          .origin,
      ).toEqual(supplier.origin);
    }, true);
  });

test('an extracted current member cannot stand in for the whole original archive', async () => {
  await importedFixture(async ({ project, supplier }) => {
    delete supplier.files[0].member;
    await expect(project()).rejects.toThrow(/original current outer archive bytes/);
  });
});

test('a whole compiled current archive must reach its own consumer action', async () => {
  await importedFixture(async ({ project, cohort }) => {
    cohort.aquery.depSetOfFiles[2].directArtifactIds.shift();
    await expect(project()).rejects.toThrow(/supplier File is not consumed/);
  }, true);
});

async function importedAppleFixture(run) {
  await importedFixture(async (context) => {
    const { supplier, original, build, executionRoot, cohort } = context;
    const output = 'bazel-out/producer/bin/src/native/runtime/apple_release_assets/ios.json';
    const bytes = Buffer.from('{"schema":"controlled-private-ios-fixture","version":"0.3.3"}\n');
    mkdirSync(path.dirname(path.join(executionRoot, output)), { recursive: true });
    writeFileSync(path.join(executionRoot, output), bytes);
    original.outputs[0] = {
      path: output,
      members: captureNativeOutputMembers(executionRoot, output).members,
    };
    const root = original.roots[0];
    root.label = '//src/native/runtime:apple_ios_manifest_shipping';
    Object.assign(root.package, {
      ecosystem: 'internal',
      role: 'apple-base-ios-manifest-input',
      configuration: 'ios-xcframework',
      name: 'ios.json',
      outputs: [{ path: output, owner: '//runtime:bound_archive' }],
    });
    original.rootConfigurations[0].label = root.label;
    const artifact = original.aquery.artifacts.find(({ id }) => id === 1000)!;
    original.aquery.pathFragments.push(
      ...output.split('/').map((label, segment) => ({
        id: `apple-${segment}`,
        label,
        ...(segment ? { parentId: `apple-${segment - 1}` } : {}),
      })),
    );
    artifact.pathFragmentId = `apple-${output.split('/').length - 1}`;
    supplier.configuration = 'ios-xcframework';
    supplier.binding = 'abi-contract';
    Object.assign(supplier.origin.producer, { root: root.label, output });
    delete supplier.files[0].member;
    const archive = path.join(executionRoot, 'packet/files/0', output);
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(archive, bytes);
    build.origin.finalFiles.artifactRoots = [archive];
    Object.assign(build.origin.finalFiles.files[0], {
      path: output,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    writeFileSync(path.join(executionRoot, heldFile), bytes);
    cohort.inputs.find(({ path: file }) => file === heldFile).members = captureNativeInputMembers(
      executionRoot,
      heldFile,
    ).members;
    await run({ ...context, archive });
  });
}

test('the canonical private Apple document reuses its exact qualified File without an archive or compiler claim', async () => {
  await importedAppleFixture(async ({ project, archive }) => {
    const result = await project();
    expect(result.unknowns).toEqual([]);
    expect([...result.buildBound!.get(consumer)!]).toEqual([]);
    writeFileSync(archive, 'substituted private input');
    await expect(project()).rejects.toThrow(/physical archive/);
  });
});

test('private Apple reuse cannot bless another role, owner, slot, root or compiled member', async () => {
  for (const mutate of [
    ({ original }) => {
      original.roots[0].package.role = 'construction';
    },
    ({ original }) => {
      original.roots[0].package.product = consumer;
    },
    ({ original }) => {
      original.roots[0].package.configuration = configuration;
    },
    ({ supplier }) => {
      supplier.origin.producer.root = '//other:ios_manifest';
    },
    ({ supplier }) => {
      supplier.binding = 'compiled-input';
      supplier.files[0].member = 'file';
    },
  ])
    await importedAppleFixture(async (context) => {
      mutate(context);
      await expect(context.project()).rejects.toThrow();
    });
});

async function importedTreeFixture(run) {
  await importedFixture(async (context) => {
    const { supplier, original, build, executionRoot, packetArchive, cohort } = context;
    const output = supplier.origin.producer.output;
    const name = 'liboliphaunt-0.3.3-android-arm64-v8a.tar.gz';
    const bytes = readFileSync(packetArchive);
    rmSync(path.join(executionRoot, output));
    mkdirSync(path.join(executionRoot, output));
    writeFileSync(path.join(executionRoot, output, name), bytes);
    original.outputs[0].members = captureNativeOutputMembers(executionRoot, output).members;
    original.roots[0].package.name = name;
    supplier.origin.producer.member = name;
    supplier.binding = 'abi-contract';
    delete supplier.files[0].member;
    const archive = `${packetArchive}/${name}`;
    rmSync(packetArchive);
    mkdirSync(packetArchive);
    writeFileSync(archive, bytes);
    build.origin.finalFiles.artifactRoots = [archive];
    build.origin.finalFiles.files[0].path = `${output}/${name}`;
    writeFileSync(path.join(executionRoot, heldFile), bytes);
    cohort.inputs.find(({ path: file }) => file === heldFile).members = captureNativeInputMembers(
      executionRoot,
      heldFile,
    ).members;
    await run({ ...context, archive });
  });
}

for (const binding of ['abi-contract', 'compiled-input'] as const)
  test(`whole imported Tree ${binding} archive binds the original canonical regular leaf`, async () => {
    await importedTreeFixture(async ({ project, supplier }) => {
      supplier.binding = binding;
      expect(supplier.origin.producer.member).toBe('liboliphaunt-0.3.3-android-arm64-v8a.tar.gz');
      expect(supplier.files).toEqual([{ path: heldFile }]);
      const result = await project();
      expect(result.unknowns).toEqual([]);
      expect([...result.buildBound!.get(consumer)!]).toEqual(
        binding === 'compiled-input' ? [product] : [],
      );
    });
  });

test('imported Tree archive rejects root, member, canonical identity and byte substitutions', async () => {
  for (const mutate of [
    ({ supplier }) => {
      delete supplier.origin.producer.member;
    },
    ({ supplier }) => {
      supplier.origin.producer.member = '../outside.tar.gz';
    },
    ({ supplier }) => {
      supplier.origin.producer.member = 'missing.tar.gz';
    },
    ({ original }) => {
      original.outputs[0].members[0].type = 'file';
    },
    ({ original }) => {
      original.roots[0].package.name = 'another-canonical-asset.tar.gz';
    },
    ({ archive }) => {
      writeFileSync(archive, 'different transported archive');
    },
  ])
    await importedTreeFixture(async (context) => {
      context.supplier.binding = 'compiled-input';
      mutate(context);
      await expect(context.project()).rejects.toThrow();
    });
});

for (const binding of ['abi-contract', 'compiled-input'] as const)
  test(`whole completed ${binding} archive binds authenticated outer bytes and stays held`, async () => {
    await fixture(
      async ({ project, roots, cohort, input, executionRoot, authenticateCompleted }) => {
        const supplier = roots[2].package.supplierInputs[0];
        supplier.binding = binding;
        delete supplier.files[0].member;
        writeFileSync(
          path.join(executionRoot, heldFile),
          readFileSync(input.completed[0].files[0].file),
        );
        cohort.inputs.find((row) => row.path === heldFile).members = captureNativeInputMembers(
          executionRoot,
          heldFile,
        ).members;
        const result = await project();
        expect(result.unknowns).toEqual([]);
        expect([...result.buildBound!.get(consumer)!]).toEqual([]);
        expect(
          result.suppliers.find(({ origin }) => origin.kind === 'completed-publication')!.origin,
        ).toEqual(supplier.origin);
        await expect(
          projectNativeBuildBoundSuppliers(input, {
            authenticateCompleted: async (request) => {
              const origin = await authenticateCompleted(request);
              for (const archive of origin.archives) {
                delete (archive as any).size;
                delete (archive as any).sha256;
              }
              return origin;
            },
          }),
        ).rejects.toThrow(/authenticated outer bytes/);
        writeFileSync(path.join(executionRoot, heldFile), 'different archive bytes');
        cohort.inputs.find((row) => row.path === heldFile).members = captureNativeInputMembers(
          executionRoot,
          heldFile,
        ).members;
        await expect(project()).rejects.toThrow(/published outer archive bytes/);
      },
      'held',
    );
  });

test('an extracted held member cannot stand in for the whole published archive', async () => {
  await fixture(async ({ project, roots }) => {
    delete roots[2].package.supplierInputs[0].files[0].member;
    await expect(project()).rejects.toThrow(/published outer archive bytes/);
  }, 'held');
});

async function importedSwiftDocumentFixture(kind: 'carrier' | 'ownerCatalog' | 'archive', run) {
  await importedAppleFixture(async (context) => {
    const { supplier, original, build, executionRoot, cohort, input, observation } = context;
    const swift = 'oliphaunt-swift';
    input.products[swift] = { version: '0.8.2' };
    observation.products.push({ product: { id: swift, version: '0.8.2' } });
    const isTree = kind === 'carrier';
    const basename =
      kind === 'archive'
        ? 'Oliphaunt-source.zip'
        : isTree
          ? 'oliphaunt-react-native-ios-carriers.json'
          : 'extension-owner-catalog.json';
    const output =
      'bazel-out/producer/bin/src/native/sdks/swift/source_package/' +
      (isTree ? 'release-tree' : kind === 'archive' ? basename : 'extension-generator/' + basename);
    const member = 'src/sdks/swift/Carriers/' + basename;
    const full = isTree ? output + '/' + member : output;
    let bytes = Buffer.from('{"genuine-captured-document":"' + kind + '"}\n');
    mkdirSync(path.dirname(path.join(executionRoot, full)), { recursive: true });
    if (kind === 'archive') {
      const tree = path.join(executionRoot, 'original-swift-source/package/Sources');
      mkdirSync(tree, { recursive: true });
      writeFileSync(path.join(tree, 'Core.swift'), 'public struct OriginalCapturedSource {}\n');
      await archiveDirectory(path.dirname(path.dirname(tree)), path.join(executionRoot, full));
      bytes = readFileSync(path.join(executionRoot, full));
    } else writeFileSync(path.join(executionRoot, full), bytes);
    const root = original.roots[0];
    root.label = '//src/native/sdks/swift:shipping_' + basename.replaceAll('.', '_');
    Object.assign(root.package, {
      product: swift,
      version: '0.8.2',
      ecosystem: 'github',
      configuration: 'portable',
      role: 'release-input',
      name: basename,
      outputs: [{ path: output, owner: '//runtime:bound_archive' }],
    });
    original.rootConfigurations[0].label = root.label;
    original.aquery.pathFragments.push(
      ...output.split('/').map((label, segment) => ({
        id: `swift-${segment}`,
        label,
        ...(segment ? { parentId: `swift-${segment - 1}` } : {}),
      })),
    );
    original.aquery.artifacts.find(({ id }) => id === 1000).pathFragmentId =
      `swift-${output.split('/').length - 1}`;
    original.outputs[0] = {
      path: output,
      members: captureNativeOutputMembers(executionRoot, output).members,
    };
    supplier.product = swift;
    supplier.version = '0.8.2';
    supplier.configuration = 'portable';
    Object.assign(supplier.origin.producer, { root: root.label, output });
    if (isTree) supplier.origin.producer.member = member;
    const archive = path.join(executionRoot, 'packet/files/0', full);
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(archive, bytes);
    build.origin.finalFiles.artifactRoots = [archive];
    Object.assign(build.origin.finalFiles.files[0], {
      path: full,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    writeFileSync(path.join(executionRoot, heldFile), bytes);
    cohort.inputs.find(({ path: name }) => name === heldFile).members = captureNativeInputMembers(
      executionRoot,
      heldFile,
    ).members;
    await run({ ...context, archive });
  });
}

for (const kind of ['carrier', 'ownerCatalog', 'archive'] as const) {
  test(
    'exact original Swift ' + kind + ' File is ABI/data reuse without compiled adoption',
    async () => {
      await importedSwiftDocumentFixture(kind, async ({ project, archive }) => {
        const result = await project();
        expect(result.unknowns).toEqual([]);
        expect([...result.buildBound.get(consumer)]).toEqual([]);
        writeFileSync(archive, 'substituted document');
        await expect(project()).rejects.toThrow(/physical archive/);
      });
    },
  );
  test(
    'Swift ' + kind + ' document cannot bless wrong role, root, slot, member or compiler claim',
    async () => {
      for (const change of [
        ({ original }) => (original.roots[0].package.role = 'github-release-asset'),
        ({ supplier }) => (supplier.origin.producer.root = '//swift:borrowed_document'),
        ({ original }) => (original.roots[0].package.configuration = 'apple-xcframework'),
        ({ supplier }) =>
          (supplier.origin.producer.member =
            'unrelated/' +
            (kind === 'carrier'
              ? 'oliphaunt-react-native-ios-carriers.json'
              : 'extension-owner-catalog.json')),
        ({ supplier }) => {
          supplier.binding = 'compiled-input';
          supplier.files[0].member = 'inside';
        },
        ({ supplier }) => (supplier.files[0].member = 'inside'),
      ])
        await importedSwiftDocumentFixture(kind, async (context) => {
          change(context);
          await expect(context.project()).rejects.toThrow();
        });
    },
  );
}

test('completed Git source context binds exact retained members and never becomes a current compiled adoption', async () => {
  await fixture(async ({ input, roots, cohort, observation, executionRoot }) => {
    const id = 'oliphaunt-swift';
    const version = '0.8.2';
    const completed = { ...publication, product: id, version, tagName: `${id}-v${version}` };
    const artifact = `swift-source-tag:${version}`;
    const member = 'src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift';
    const bytes = Buffer.from('public struct FrozenSwiftSource {}\n');
    const tree = path.join(executionRoot, 'source-tag-tree');
    mkdirSync(path.join(tree, path.dirname(member)), { recursive: true });
    writeFileSync(path.join(tree, member), bytes);
    const archive = path.join(executionRoot, 'source-tag.tar.gz');
    await archiveDirectory(tree, archive);
    const outer = {
      path: archive,
      size: readFileSync(archive).length,
      sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    };
    const row = {
      publication: completed,
      artifact,
      source: {
        commit: '1'.repeat(40),
        tree: '2'.repeat(40),
        member: 'src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json',
        blob: '3'.repeat(40),
      },
      file: outer,
    };
    delete input.products[product];
    input.products[id] = { version: '0.8.3' };
    observation.products = Object.entries(input.products).map(([id, metadata]) => ({
      product: { id, ...metadata },
    }));
    roots[0].package.product = id;
    roots[0].package.version = '0.8.3';
    roots[1].package.supplierInputs = [];
    roots[2].package.supplierInputs = [
      {
        product: id,
        version,
        configuration: 'portable',
        binding: 'abi-contract',
        origin: { kind: 'completed-publication', publication: completed, artifact },
        files: [{ path: heldFile, member }],
      },
    ];
    writeFileSync(path.join(executionRoot, heldFile), bytes);
    const capture = cohort.inputs.find(({ path: name }) => name === heldFile)!;
    capture.members = captureNativeInputMembers(executionRoot, heldFile).members;
    input.completed = [
      { publication: completed, files: {}, carriers: {}, sourceTags: [structuredClone(row)] },
    ] as any;
    let reads = 0;
    const authenticateCompleted = async (context) => {
      reads++;
      expect(context.sourceTags).toEqual([row]);
      return {
        scope: 'construction',
        publication: completed,
        unknowns: [],
        archives: [
          {
            id: artifact,
            name: artifact,
            target: 'portable',
            size: outer.size,
            sha256: outer.sha256,
            members: nativeArchiveDeliveryMembers(archive),
          },
        ],
      };
    };
    const project = () => projectNativeBuildBoundSuppliers(input, { authenticateCompleted });
    const result = await project();
    expect(result.unknowns).toEqual([]);
    expect([...result.buildBound!.get(consumer)!]).toEqual([]);
    expect(reads).toBe(1);
    capture.members[0].sha256 = '0'.repeat(64);
    await expect(project()).rejects.toThrow('published member bytes');
    capture.members = captureNativeInputMembers(executionRoot, heldFile).members;
    delete roots[2].package.supplierInputs[0].files[0].member;
    capture.members = [
      { path: '', type: 'file', mode: 0o644, size: outer.size, sha256: outer.sha256 },
    ];
    expect((await project()).unknowns).toEqual([]);
    input.completed[0].sourceTags[0].publication.publicationSha = '4'.repeat(40);
    expect((await project()).unknowns).toContain(
      'missing completed supplier bytes: oliphaunt-swift@0.8.2',
    );
  }, 'held');
});

test('a current compiled Rust library needs its own configured producer and cannot masquerade as source or completed bytes', async () => {
  await fixture(async ({ input, project, roots, cohort, executionRoot }) => {
    const rlib = roots[3].package.outputs[0].path.replace('source.crate', 'libbindings.rlib');
    writeFileSync(path.join(executionRoot, rlib), 'controlled compiled binding bytes');
    const artifact = cohort.aquery.artifacts.find(
      (row) => row.id === cohort.aquery.actions[3].outputIds[0],
    );
    const fragment = cohort.aquery.pathFragments.find((row) => row.id === artifact.pathFragmentId);
    fragment.label = 'libbindings.rlib';
    roots[3].package.outputs[0].path = rlib;
    roots[2].package.supplierInputs = [
      {
        product: 'fixture-source',
        version: '2.0.0',
        configuration,
        binding: 'compiled-input',
        origin: { kind: 'current-source' },
        files: [{ path: rlib }],
      },
    ];
    // The consumer's actual action now incorporates the same generated library File.
    cohort.aquery.depSetOfFiles[2].directArtifactIds = [
      cohort.aquery.depSetOfFiles[2].directArtifactIds[1],
      artifact.id,
    ];
    cohort.inputs.push({
      path: rlib,
      members: captureNativeInputMembers(executionRoot, rlib).members,
    });
    const result = await project();
    expect([...result.buildBound.get(consumer)]).toEqual(['fixture-source']);
    expect(result.suppliers.find((row) => row.product === 'fixture-source').origin).toEqual({
      kind: 'current-source',
    });
    roots[3].package.configuration = 'wrong-profile';
    await expect(project()).rejects.toThrow('own configured shipping producer');
    roots[3].package.configuration = configuration;
    roots[3].package.product = consumer;
    roots[3].package.version = input.products[consumer].version;
    await expect(project()).rejects.toThrow('own configured shipping producer');
    roots[3].package.product = 'fixture-source';
    roots[3].package.version = input.products['fixture-source'].version;
    roots[2].package.supplierInputs[0].files[0].path = 'source/README.md';
    cohort.aquery.depSetOfFiles[2].directArtifactIds.push(
      cohort.aquery.depSetOfFiles[3].directArtifactIds[0],
    );
    await expect(project()).rejects.toThrow('actual generated File');
    roots[2].package.supplierInputs[0].files[0].path = rlib;
    roots[2].package.supplierInputs[0].version = '9.0.0';
    await expect(project()).rejects.toThrow('current supplier version');
    expect(input.products['fixture-source'].version).toBe('2.0.0');
  });
});
