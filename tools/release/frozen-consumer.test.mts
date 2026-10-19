import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createCdpClient } from '../../src/wasix/sdks/ts/tools/browser-cdp.mts';
import { createDeterministicTar } from '../packaging/cargo-source-package.mts';
import {
  assertFrozenMavenConsumerInputs,
  consumerHostTarget,
  consumerInstallationKey,
  frozenConsumerMatrix,
  frozenConsumerPlan,
  frozenMavenRepositoryDeclaration,
  frozenNpmPackage,
  frozenNpmRegistry,
  stageFrozenCargo,
  stageFrozenMaven,
} from './frozen-consumer.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { allArtifactTargets } from './release-artifact-targets.mts';
import { ROOT } from './release-graph.mts';

test('browser consumer protocol failures reject pending commands and allow clean shutdown', async () => {
  for (const failure of ['close', 'error']) {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, server) =>
        server.upgrade(request) ? undefined : new Response(null, { status: 400 }),
      websocket: {
        message(socket, data) {
          const request = JSON.parse(String(data));
          if (failure === 'close') socket.close();
          else
            socket.send(
              JSON.stringify({ id: request.id, error: { message: 'consumer page failed' } }),
            );
        },
      },
    });
    const socket = new WebSocket(server.url.toString().replace('http:', 'ws:'));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      const client = createCdpClient(socket, () => {}, Date.now() + 60_000);
      await expect(client.send('Runtime.evaluate')).rejects.toThrow(
        failure === 'close' ? 'connection closed' : 'consumer page failed',
      );
    } finally {
      socket.close();
      server.stop(true);
    }
  }
}, 2000);

function packageFixture(root, manifest) {
  const directory = path.join(root, `${manifest.name.split('/').at(-1)}-${manifest.version}`);
  mkdirSync(path.join(directory, 'package'), { recursive: true });
  writeFileSync(path.join(directory, 'package/package.json'), JSON.stringify(manifest));
  writeFileSync(
    path.join(directory, 'package/index.js'),
    `module.exports = ${JSON.stringify(manifest.version)};\n`,
  );
  const file = path.join(directory, 'package.tgz');
  writeFileSync(
    file,
    gzipSync(createDeterministicTar(path.join(directory, 'package'), 'package', {})),
  );
  return frozenNpmPackage(file);
}

test('every current release product and declared registry carrier has a frozen consumer path', () => {
  const catalog = loadPublicationCatalog('frozen-consumer test');
  const lock = {
    ...catalog,
    lockDigest: 'a'.repeat(64),
    productArtifacts: allArtifactTargets({ surface: 'github-release' }).map((row) => ({
      ...row,
      name: row.asset.replaceAll(
        '{version}',
        catalog.products.find((product) => product.id === row.product).version,
      ),
    })),
  };
  const plan = frozenConsumerPlan(lock, { configurationDigest: 'b'.repeat(64) });
  for (const carrier of catalog.carriers)
    expect(plan.cases.some((entry) => entry.carrierId === carrier.id)).toBe(true);
});

test('SDK-only consumers install the independently versioned vector package', () => {
  const catalog = loadPublicationCatalog('SDK extension consumers');
  const lock = {
    ...catalog,
    lockDigest: 'a'.repeat(64),
    products: catalog.products.filter(({ id }) =>
      ['oliphaunt-js', 'oliphaunt-wasix-ts'].includes(id),
    ),
    carriers: catalog.carriers.filter(({ product }) =>
      ['oliphaunt-js', 'oliphaunt-wasix-ts'].includes(product),
    ),
  };
  const plan = frozenConsumerPlan(lock, { configurationDigest: 'b'.repeat(64) });
  for (const test of plan.cases) {
    expect(test.sdk.product).toBe(test.product);
    expect(test.extensions).toEqual([
      {
        product: 'oliphaunt-extension-vector',
        name: `@oliphaunt/extension-vector${test.product === 'oliphaunt-wasix-ts' ? '-wasix' : ''}`,
        version: catalog.products.find(({ id }) => id === 'oliphaunt-extension-vector').version,
        sqlName: 'vector',
      },
    ]);
  }
});

test('extension-only releases reuse one carrier case per host to prove both default SDK installs', () => {
  const catalog = loadPublicationCatalog('extension default consumers');
  const extensionIds = new Set(
    catalog.products.filter(({ kind }) => kind === 'exact-extension-artifact').map(({ id }) => id),
  );
  const lock = {
    lockDigest: 'a'.repeat(64),
    products: catalog.products
      .filter(({ id }) => extensionIds.has(id))
      .map((product) => ({ ...product, version: '9.0.0' })),
    carriers: catalog.carriers
      .filter(({ product }) => extensionIds.has(product))
      .map((carrier) => ({ ...carrier, version: '9.0.0' })),
  };
  const plan = frozenConsumerPlan(lock, { configurationDigest: 'b'.repeat(64) });
  const compositions = plan.cases.filter((test) => test.sdk);
  expect(compositions).toHaveLength(8);
  for (const test of compositions) {
    expect(test.extensions).toHaveLength(extensionIds.size);
    expect(test.extensions.every(({ version }) => version === '9.0.0')).toBe(true);
    expect(test.sdk.version).toBe(
      catalog.products.find(({ id }) => id === test.sdk.product).version,
    );
    expect(test.executionLevel).toBe('execute');
  }
  expect(plan.cases).toHaveLength(
    lock.carriers.flatMap((carrier) =>
      carrier.ecosystem === 'maven' || consumerHostTarget(carrier.target)
        ? [carrier]
        : Array(4).fill(carrier),
    ).length,
  );
});

test('installation reuse binds the SDK and extension requirements while sharing JS runtime checks', () => {
  const test = {
    id: 'sdk/node',
    carrierId: 'npm:sdk',
    target: 'linux-x64-gnu',
    transportMode: 'frozen-npm-registry',
    integration: 'node',
    sdk: { name: 'sdk', version: '1.2.3' },
    extensions: [{ name: 'extension', version: '4.5.6' }],
  };
  expect(consumerInstallationKey(test)).toBe(
    consumerInstallationKey({ ...test, id: 'sdk/bun', integration: 'bun' }),
  );
  expect(consumerInstallationKey(test)).not.toBe(
    consumerInstallationKey({ ...test, extensions: [{ name: 'extension', version: '4.5.7' }] }),
  );
});

test('carrier triples and npm platform names map to the canonical consumer hosts', () => {
  expect(consumerHostTarget('aarch64-apple-darwin')).toBe('macos-arm64');
  expect(consumerHostTarget('darwin-arm64')).toBe('macos-arm64');
  expect(consumerHostTarget('win32-x64-msvc')).toBe('windows-x64-msvc');
  expect(consumerHostTarget('android-arm64-v8a')).toBe('linux-x64-gnu');
  expect(consumerHostTarget('wasix-portable')).toBeNull();
  expect(() => consumerHostTarget('unknown-target')).toThrow('no consumer host');
});

test('plans cover each selected carrier on its declared host and keep mobile lanes separate', () => {
  const lock = {
    lockDigest: 'a'.repeat(64),
    products: [{ id: 'oliphaunt-react-native', version: '1.0.0', publishTargets: ['npm'] }],
    carriers: [
      {
        id: 'npm:@oliphaunt/react-native',
        name: '@oliphaunt/react-native',
        ecosystem: 'npm',
        version: '1.0.0',
        product: 'oliphaunt-react-native',
        target: null,
      },
    ],
  };
  const plan = frozenConsumerPlan(lock, { configurationDigest: 'b'.repeat(64) });
  expect(plan.cases.map(({ target }) => target)).toEqual(['linux-x64-gnu', 'macos-arm64']);
  expect(plan.cases.map(({ executionLevel }) => executionLevel)).toEqual([
    'android-compile-and-link',
    'ios-compile-and-link',
  ]);
  expect(frozenConsumerMatrix(plan).include).toHaveLength(2);
  expect(() => frozenConsumerPlan({ ...lock, carriers: [] })).toThrow(
    'no frozen consumption contract',
  );
});

test('TypeScript execution cases cover actual runtime export conditions and the browser lane', () => {
  const lock = {
    lockDigest: 'a'.repeat(64),
    products: [{ id: 'oliphaunt-wasix-ts', version: '1.0.0', publishTargets: ['npm'] }],
    carriers: [
      {
        id: 'npm:@oliphaunt/wasix-ts',
        name: '@oliphaunt/wasix-ts',
        ecosystem: 'npm',
        version: '1.0.0',
        product: 'oliphaunt-wasix-ts',
        target: null,
      },
    ],
  };
  const plan = frozenConsumerPlan(lock, { configurationDigest: 'b'.repeat(64) });
  expect(
    plan.cases
      .filter((test) => test.target === 'linux-x64-gnu')
      .map((test) => test.integration)
      .sort(),
  ).toEqual(['browser', 'bun', 'deno', 'node']);
  expect(plan.cases.filter((test) => test.integration === 'browser')).toHaveLength(1);
  expect(new Set(plan.cases.map(consumerInstallationKey)).size).toBe(5);
  for (const row of frozenConsumerMatrix(plan).include) {
    expect(row).toMatchObject({ npm: true, deno: true, cargo: false, android: false });
  }
});

test('consumer setup follows selected cases rather than allocating every toolchain', () => {
  const catalog = loadPublicationCatalog('consumer capability test');
  const matrix = (products) =>
    frozenConsumerMatrix(
      frozenConsumerPlan(
        {
          ...catalog,
          lockDigest: 'a'.repeat(64),
          products: catalog.products.filter((product) => products.includes(product.id)),
          carriers: catalog.carriers.filter((carrier) => products.includes(carrier.product)),
        },
        { configurationDigest: 'b'.repeat(64) },
      ),
    ).include;
  for (const row of matrix(['oliphaunt-query-ts']))
    expect(row).toMatchObject({
      npm: true,
      cargo: false,
      maven: false,
      android: false,
      expo: false,
      deno: false,
      native: false,
      apple: false,
    });
  for (const row of matrix(['oliphaunt-query']))
    expect(row).toMatchObject({
      npm: false,
      cargo: true,
      maven: false,
      android: false,
      deno: false,
    });
  expect(matrix(['oliphaunt-kotlin'])).toMatchObject([
    {
      target: 'linux-x64-gnu',
      maven: true,
      android: true,
      expo: false,
    },
  ]);
  expect(matrix(['oliphaunt-react-native'])).toMatchObject([
    { target: 'linux-x64-gnu', npm: true, android: true, expo: true },
    { target: 'macos-arm64', npm: true, android: false, expo: false, apple: true },
  ]);
  const extension = matrix(['oliphaunt-extension-vector']);
  expect(extension.find((row) => row.target === 'linux-x64-gnu')).toMatchObject({
    npm: true,
    cargo: true,
    maven: true,
    native: true,
    android: false,
    expo: false,
  });
  expect(extension.find((row) => row.target === 'windows-x64-msvc').native).toBe(true);
});

test('runtime installation reuse never merges browser, different roots or different hosts', () => {
  const base = {
    id: 'bun',
    transportMode: 'frozen-npm-registry',
    carrierId: 'npm:@oliphaunt/ts',
    target: 'linux-x64-gnu',
    integration: 'bun',
  };
  expect(consumerInstallationKey(base)).toBe(
    consumerInstallationKey({ ...base, id: 'node', integration: 'node' }),
  );
  for (const changed of [
    { id: 'browser', integration: 'browser' },
    { carrierId: 'npm:@oliphaunt/wasix-ts' },
    { target: 'windows-x64-msvc' },
    { transportMode: 'frozen-crate-path-patch' },
  ])
    expect(consumerInstallationKey({ ...base, ...changed })).not.toBe(
      consumerInstallationKey(base),
    );
});

test('one Kotlin build covers its carriers while checking each artifact identity and hash', () => {
  const catalog = loadPublicationCatalog('Kotlin consumer grouping', {
    products: ['oliphaunt-kotlin'],
  });
  const plan = frozenConsumerPlan(
    { ...catalog, lockDigest: 'a'.repeat(64) },
    { configurationDigest: 'b'.repeat(64) },
  );
  expect(plan.cases).toHaveLength(3);
  expect(new Set(plan.cases.map(consumerInstallationKey)).size).toBe(1);
  const carrier = {
    name: 'dev.oliphaunt:oliphaunt-android',
    version: '1.0.0',
    artifacts: [{ path: 'oliphaunt-android-1.0.0.aar', sha256: 'a'.repeat(64) }],
  };
  const input = {
    identity: `${carrier.name}:${carrier.version}`,
    integrity: `sha256:${'a'.repeat(64)}`,
  };
  expect(() => assertFrozenMavenConsumerInputs(carrier, [input])).not.toThrow();
  for (const inputs of [
    [],
    [{ ...input, identity: `${carrier.name}:0.9.0` }],
    [{ ...input, integrity: `sha256:${'b'.repeat(64)}` }],
  ])
    expect(() => assertFrozenMavenConsumerInputs(carrier, inputs)).toThrow(
      'did not consume frozen input',
    );
});

test('an archive-only postmaster release has an installed launcher consumer on every declared host', () => {
  const product = 'liboliphaunt-wasix-postmaster';
  const targets = ['linux-arm64-gnu', 'linux-x64-gnu', 'macos-arm64'];
  const lock = {
    lockDigest: 'a'.repeat(64),
    products: [{ id: product, version: '1.0.0', publishTargets: ['github-release-assets'] }],
    carriers: [],
    productArtifacts: targets.map((target) => ({
      id: `${product}/${target}`,
      product,
      target,
      name: `${product}-1.0.0-${target}.tar.zst`,
    })),
  };
  const plan = frozenConsumerPlan(lock, { configurationDigest: 'b'.repeat(64) });
  expect(plan.cases.map((entry) => entry.target).sort()).toEqual(targets);
  expect(plan.cases.every((entry) => entry.executionLevel === 'initialize-cluster')).toBe(true);
});

test('Cargo and Maven staging preserve frozen bytes and reject qualification-only crates', () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target/frozen-staging-test-'));
  try {
    const source = path.join(root, 'source');
    mkdirSync(source);
    const manifest = '[package]\nname="fixture"\nversion="1.0.0"\n';
    writeFileSync(path.join(source, 'Cargo.toml'), manifest);
    const archive = path.join(root, 'fixture-1.0.0.crate');
    writeFileSync(archive, gzipSync(createDeterministicTar(source, 'fixture-1.0.0', {})));
    const payload = path.join(root, 'fixture-1.0.0.tar.gz');
    writeFileSync(payload, 'unchanged primary artifact');
    const artifact = (file) => ({
      path: path.relative(ROOT, file).split(path.sep).join('/'),
      size: readFileSync(file).length,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    });
    const lock = {
      carriers: [
        {
          id: 'cargo:fixture',
          ecosystem: 'cargo',
          name: 'fixture',
          version: '1.0.0',
          artifacts: [artifact(archive)],
        },
        {
          id: 'maven:dev.example:fixture',
          ecosystem: 'maven',
          name: 'dev.example:fixture',
          version: '1.0.0',
          artifacts: [artifact(payload)],
        },
      ],
    };
    const config = stageFrozenCargo(lock, root);
    expect(readFileSync(config, 'utf8')).toContain('[patch.crates-io]');
    expect(readFileSync(path.join(root, 'crates/fixture-1.0.0/Cargo.toml'), 'utf8')).toBe(manifest);
    const repository = stageFrozenMaven(lock, root);
    expect(
      readFileSync(path.join(repository, 'dev/example/fixture/1.0.0/fixture-1.0.0.tar.gz')),
    ).toEqual(readFileSync(payload));
    expect(frozenMavenRepositoryDeclaration(lock, repository)).toContain(
      'includeVersion("dev.example", "fixture", "1.0.0")',
    );
    writeFileSync(
      path.join(source, 'Cargo.toml'),
      `${manifest}\n[package.metadata.oliphaunt]\nqualificationOnly=false\n`,
    );
    writeFileSync(archive, gzipSync(createDeterministicTar(source, 'fixture-1.0.0', {})));
    lock.carriers[0].artifacts = [artifact(archive)];
    expect(() => stageFrozenCargo(lock, root)).toThrow('frozen Cargo identity differs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry retains the complete package metadata and rejects writes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'frozen-registry-'));
  let registry;
  try {
    const manifest = {
      name: '@oliphaunt/fixture',
      version: '1.0.0',
      main: 'index.js',
      os: ['linux'],
      cpu: ['x64'],
      optionalDependencies: { '@oliphaunt/fixture-leaf': '1.0.0' },
      peerDependencies: { '@oliphaunt/fixture-peer': '^1.0.0' },
      exports: { '.': './index.js' },
    };
    let requests = 0;
    registry = await frozenNpmRegistry([packageFixture(root, manifest)], {
      fetchImpl: async () => {
        requests++;
        return new Response('', { status: 404 });
      },
    });
    const metadata = await (
      await fetch(`${registry.url}${encodeURIComponent(manifest.name)}`)
    ).json();
    expect(metadata.versions['1.0.0']).toMatchObject(manifest);
    expect(metadata.versions['1.0.0'].dist.integrity).toStartWith('sha512-');
    const repeats = await Promise.all(
      Array.from({ length: 6 }, async () =>
        (await fetch(`${registry.url}${encodeURIComponent(manifest.name)}`)).json(),
      ),
    );
    expect(
      repeats.every(
        (value) =>
          value.versions['1.0.0'].dist.integrity === metadata.versions['1.0.0'].dist.integrity,
      ),
    ).toBe(true);
    expect(requests).toBe(1);
    expect((await fetch(registry.url, { method: 'PUT', body: '{}' })).status).toBe(405);
    expect(() =>
      packageFixture(root, {
        name: '@oliphaunt/invalid',
        version: '1.0.0',
        oliphaunt: { qualificationOnly: false },
      }),
    ).toThrow('qualification-only');
  } finally {
    registry?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary npm install consumes the exact candidate while retaining an older authored dependency', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'frozen-install-'));
  let registry;
  let historicalServer;
  try {
    const old = packageFixture(root, {
      name: '@oliphaunt/fixture-dependency',
      version: '1.0.0',
      main: 'index.js',
    });
    historicalServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(old.bytes),
    });
    const candidate = packageFixture(root, {
      name: '@oliphaunt/fixture-root',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { '@oliphaunt/fixture-dependency': '1.0.0' },
    });
    const newer = packageFixture(root, {
      name: old.manifest.name,
      version: '2.0.0',
      main: 'index.js',
    });
    registry = await frozenNpmRegistry([candidate, newer], {
      fetchImpl: async (url) =>
        decodeURIComponent(String(url)).endsWith(old.manifest.name)
          ? Response.json({
              name: old.manifest.name,
              versions: {
                '1.0.0': { ...old.manifest, dist: { tarball: historicalServer.url.toString() } },
              },
              'dist-tags': { latest: '1.0.0' },
            })
          : new Response('', { status: 404 }),
    });
    const app = path.join(root, 'app');
    mkdirSync(app);
    writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({ private: true, dependencies: { [candidate.manifest.name]: '1.0.0' } }),
    );
    writeFileSync(path.join(app, '.npmrc'), `@oliphaunt:registry=${registry.url}\n`);
    const process = Bun.spawn(
      ['npm', 'install', '--no-audit', '--no-fund', '--cache', path.join(root, 'cache')],
      {
        cwd: app,
        env: { PATH: globalThis.process.env.PATH, HOME: root },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [status, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
      new Response(process.stdout).text(),
    ]);
    expect(status, stderr).toBe(0);
    const resolution = JSON.parse(readFileSync(path.join(app, 'package-lock.json'), 'utf8'));
    expect(resolution.packages['node_modules/@oliphaunt/fixture-dependency'].version).toBe('1.0.0');
    expect(registry.observed.has('@oliphaunt/fixture-root@1.0.0')).toBe(true);
    expect(registry.observed.has('@oliphaunt/fixture-dependency@2.0.0')).toBe(false);
  } finally {
    registry?.close();
    historicalServer?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
