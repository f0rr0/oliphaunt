import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../packaging/portable-archive.mts';
import { boundedResponseBytes } from './github-read.mts';
import { publicCargoEnvironment, sanitizedPublicEnvironment } from './public-consumer-smoke.mts';
import { consumerConfigurationDigest, consumerDigest } from './publication-consumer-proof.mts';
import {
  loadPublicationLock,
  lockedCarrierFile,
  lockedPublicationFiles,
} from './publication-lock.mts';
import { DESKTOP_TARGETS } from './release-artifact-targets.mts';
import { ROOT } from './release-graph.mts';

const TARGETS = Object.entries(DESKTOP_TARGETS).filter(([, platform]) => platform.npmOs);
const JSON_LIMIT = 16 * 1024 * 1024;

export function consumerHostTarget(target) {
  if (!target || ['portable', 'wasix-portable'].includes(target)) return null;
  if (target.startsWith('android-')) return 'linux-x64-gnu';
  const match = TARGETS.find(([id, platform]) =>
    [
      id,
      platform.triple,
      id.replace('macos-', 'darwin-'),
      id.replace('windows-', 'win32-'),
    ].includes(target),
  );
  if (!match) throw new Error(`no consumer host for carrier target ${target}`);
  return match[0];
}

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function frozenConsumerPlan(
  lock,
  { configurationDigest = consumerConfigurationDigest() } = {},
) {
  const cases = [];
  for (const carrier of lock.carriers) {
    if (!['cargo', 'npm', 'maven'].includes(carrier.ecosystem))
      throw new Error(`no frozen consumer adapter for ${carrier.ecosystem}`);
    for (const [target] of TARGETS) {
      if (carrier.ecosystem === 'maven' && target !== 'linux-x64-gnu') continue;
      const host = consumerHostTarget(carrier.target);
      if (host && host !== target) continue;
      if (
        carrier.product === 'oliphaunt-react-native' &&
        !['linux-x64-gnu', 'macos-arm64'].includes(target)
      )
        continue;
      const integrations = ['oliphaunt-js', 'oliphaunt-wasix-ts'].includes(carrier.product)
        ? [
            'node',
            'bun',
            'deno',
            ...(carrier.product === 'oliphaunt-wasix-ts' && target === 'linux-x64-gnu'
              ? ['browser']
              : []),
          ]
        : [null];
      for (const integration of integrations)
        cases.push({
          id: `${carrier.id}@${carrier.version}/${target}${integration ? `/${integration}` : ''}`,
          ...(integration ? { integration } : {}),
          carrierId: carrier.id,
          product: carrier.product,
          target,
          transportMode: {
            cargo: 'frozen-crate-path-patch',
            npm: 'frozen-npm-registry',
            maven: 'frozen-maven-repository',
          }[carrier.ecosystem],
          executionLevel:
            carrier.ecosystem === 'cargo'
              ? ['oliphaunt', 'oliphaunt-wasix'].includes(carrier.name)
                ? 'execute'
                : 'compile-and-link'
              : carrier.ecosystem === 'maven'
                ? carrier.product === 'oliphaunt-kotlin'
                  ? 'android-compile-and-link'
                  : 'resolve-and-validate'
                : ['oliphaunt-js', 'oliphaunt-wasix-ts', 'oliphaunt-query-ts'].includes(
                      carrier.product,
                    )
                  ? 'execute'
                  : carrier.product === 'oliphaunt-react-native'
                    ? `${target === 'macos-arm64' ? 'ios' : 'android'}-compile-and-link`
                    : 'install-and-validate',
        });
    }
  }
  for (const artifact of lock.productArtifacts ?? []) {
    if (
      artifact.product === 'liboliphaunt-wasix-postmaster' &&
      artifact.name.endsWith('.tar.zst')
    ) {
      const target = consumerHostTarget(artifact.target);
      if (!target) throw new Error('postmaster archives require a declared host');
      cases.push({
        id: `${artifact.product}/${artifact.name}`,
        artifactId: artifact.id,
        product: artifact.product,
        target,
        transportMode: 'frozen-postmaster-archive',
        executionLevel: 'initialize-cluster',
      });
      continue;
    }
    if (
      artifact.product !== 'liboliphaunt-native' ||
      !DESKTOP_TARGETS[artifact.target] ||
      !/\.(?:tar\.gz|zip)$/u.test(artifact.name)
    )
      continue;
    cases.push({
      id: `${artifact.product}/${artifact.name}`,
      artifactId: artifact.id,
      product: artifact.product,
      target: artifact.target === 'macos-x64' ? 'macos-arm64' : artifact.target,
      archiveTarget: artifact.target,
      transportMode: 'frozen-native-c-archive',
      executionLevel: artifact.target === 'macos-x64' ? 'cross-compile-and-link' : 'execute',
    });
  }
  // Swift's source tag is a product artifact rather than a registry carrier.
  for (const product of lock.products.filter((product) =>
    product.publishTargets.includes('swift-package-source-tag'),
  )) {
    for (const integration of ['macos', 'ios'])
      cases.push({
        id: `${product.id}@${product.version}/swift-${integration}`,
        product: product.id,
        target: 'macos-arm64',
        integration,
        transportMode: 'frozen-swift-localization',
        executionLevel: integration === 'macos' ? 'execute' : 'ios-compile-and-link',
      });
  }
  for (const product of lock.products) {
    if (!cases.some((test) => test.product === product.id))
      throw new Error(`selected product ${product.id} has no frozen consumption contract`);
  }
  return {
    schema: 'oliphaunt-frozen-consumer-plan-v1',
    lockDigest: lock.lockDigest,
    testConfigurationDigest: configurationDigest,
    cases: cases.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function frozenConsumerMatrix(plan) {
  return {
    include: [...new Set(plan.cases.map((test) => test.target))].sort().map((target) => {
      const tests = plan.cases.filter((test) => test.target === target);
      const npm = tests.some((test) => test.transportMode === 'frozen-npm-registry');
      const cargo = tests.some((test) => test.transportMode === 'frozen-crate-path-patch');
      const maven = tests.some((test) => test.transportMode === 'frozen-maven-repository');
      const android = tests.some((test) => test.executionLevel === 'android-compile-and-link');
      const expo = android && tests.some((test) => test.product === 'oliphaunt-react-native');
      const native =
        cargo ||
        tests.some(
          (test) =>
            test.transportMode === 'frozen-native-c-archive' ||
            (test.transportMode === 'frozen-npm-registry' &&
              /^(?:liboliphaunt-native|oliphaunt-extension-)/u.test(test.product)),
        );
      return {
        target,
        runner: DESKTOP_TARGETS[target].runner,
        npm,
        cargo,
        maven,
        android,
        expo,
        deno: tests.some((test) => test.integration === 'deno'),
        native,
        apple:
          target.startsWith('macos-') &&
          (native ||
            tests.some(
              (test) =>
                test.transportMode === 'frozen-swift-localization' ||
                test.executionLevel === 'ios-compile-and-link',
            )),
      };
    }),
  };
}

export function consumerInstallationKey(test) {
  // Kotlin's AAR, plugin and marker use the same app build within one frozen lock.
  if (test.transportMode === 'frozen-maven-repository' && test.product === 'oliphaunt-kotlin')
    return `${test.product}/${test.target}`;
  // Node, Bun and Deno execute the same ordinary installation with distinct exports.
  return test.transportMode === 'frozen-npm-registry' &&
    ['node', 'bun', 'deno'].includes(test.integration)
    ? `${test.carrierId}/${test.target}`
    : test.id;
}

export function frozenNpmPackage(file) {
  const entries = readPortableArchiveEntries(file);
  const member = entries.get('package/package.json');
  if (!member) throw new Error(`${file} has no packaged npm manifest`);
  const manifest = JSON.parse(Buffer.from(member.data()).toString('utf8'));
  if (
    Object.hasOwn(manifest.oliphaunt ?? {}, 'qualificationOnly') ||
    Object.hasOwn(manifest, 'qualificationOnly')
  )
    throw new Error('qualification-only npm packages cannot prove publication');
  return {
    manifest,
    file,
    get bytes() {
      return readFileSync(file);
    },
  };
}

export async function frozenNpmRegistry(packages, { fetchImpl = fetch } = {}) {
  const byName = new Map();
  const integrity = new Map();
  for (const pkg of packages) {
    const { name, version } = pkg.manifest;
    if (!name?.startsWith('@oliphaunt/') || !version)
      throw new Error('invalid frozen npm identity');
    if (!byName.has(name)) byName.set(name, new Map());
    if (byName.get(name).has(version)) throw new Error(`duplicate frozen npm ${name}@${version}`);
    byName.get(name).set(version, pkg);
    const hash = createHash('sha512');
    if (pkg.file) for await (const chunk of createReadStream(pkg.file)) hash.update(chunk);
    else hash.update(pkg.bytes);
    integrity.set(pkg, `sha512-${hash.digest('base64')}`);
  }
  const observed = new Map();
  const historical = new Map();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'GET') return new Response('read-only registry', { status: 405 });
      const location = new URL(request.url);
      const parts = location.pathname.split('/');
      if (parts[1] === 'tarballs') {
        const name = decodeURIComponent(parts[2] ?? '');
        const version = decodeURIComponent(parts[3] ?? '').replace(/\.tgz$/u, '');
        const pkg = byName.get(name)?.get(version);
        if (!pkg) return new Response('unknown frozen identity', { status: 404 });
        observed.set(`${name}@${version}`, consumerDigest(pkg.manifest));
        return new Response(pkg.file ? Bun.file(pkg.file) : pkg.bytes, {
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      const name = decodeURIComponent(location.pathname.slice(1));
      if (!name.startsWith('@oliphaunt/')) return new Response('unknown scope', { status: 404 });
      try {
        if (!historical.has(name))
          historical.set(
            name,
            (async () => {
              const response = await fetchImpl(
                `https://registry.npmjs.org/${encodeURIComponent(name)}`,
                {
                  signal: AbortSignal.timeout(30_000),
                },
              );
              if (response.status === 404) return { name, versions: {}, 'dist-tags': {} };
              if (!response.ok)
                throw new Error(`historical npm metadata returned ${response.status}`);
              const bytes = await boundedResponseBytes(
                response,
                JSON_LIMIT,
                'historical npm metadata',
              );
              const metadata = JSON.parse(Buffer.from(bytes).toString('utf8'));
              if (metadata.name !== name || !metadata.versions)
                throw new Error('invalid historical npm identity');
              return metadata;
            })(),
          );
        const metadata = structuredClone(await historical.get(name));
        for (const [version, pkg] of byName.get(name) ?? []) {
          metadata.versions[version] = {
            ...pkg.manifest,
            dist: {
              tarball: `${server.url}tarballs/${encodeURIComponent(name)}/${encodeURIComponent(version)}.tgz`,
              integrity: integrity.get(pkg),
            },
          };
        }
        return Response.json(metadata);
      } catch (cause) {
        return new Response(String(cause), { status: 502 });
      }
    },
  });
  return {
    url: server.url.toString(),
    observed,
    integrityFor: (name, version) => integrity.get(byName.get(name)?.get(version)),
    close: () => server.stop(true),
  };
}

async function command(argv, directory, environment, log, timeout = 30 * 60_000) {
  if (argv[0] === 'npm' && environment.FROZEN_CONSUMER_NPM_CLI)
    argv = ['node', environment.FROZEN_CONSUMER_NPM_CLI, ...argv.slice(1)];
  else if (argv[0] === 'npm' && process.platform === 'win32')
    throw new Error('Windows consumers require the pinned npm CLI entrypoint');
  const descriptor = openSync(log, 'w');
  const child = spawn(argv[0], argv.slice(1), {
    cwd: directory,
    env: environment,
    stdio: ['ignore', descriptor, descriptor],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32')
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).once(
        'error',
        () => child.kill(),
      );
    else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }, timeout);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const reader = openSync(log, 'r');
    let output;
    try {
      const size = fstatSync(reader).size;
      const tail = Buffer.alloc(Math.min(size, 64 * 1024));
      readSync(reader, tail, 0, tail.length, size - tail.length);
      output = tail.toString('utf8');
    } finally {
      closeSync(reader);
    }
    if (status !== 0 || timedOut)
      throw new Error(
        `${argv[0]} ${timedOut ? 'timed out' : `failed (${status})`}: ${output.slice(-8192)}`,
      );
    return output;
  } finally {
    clearTimeout(timer);
    closeSync(descriptor);
  }
}

async function nativePackageConsumer(test, installed, lock, directory, environment) {
  const metadata = installed.oliphaunt ?? {};
  if (!metadata.product?.startsWith('oliphaunt-extension-') || !metadata.liboliphauntVersion)
    return;
  const target = test.target;
  // A facade chooses its ordinary optional dependency for this host.
  const leafName = metadata.targetPackageNames?.[target] ?? installed.name;
  const leafRoot = path.join(directory, 'node_modules', leafName);
  const leaf = json(path.join(leafRoot, 'package.json'));
  if (leaf.oliphaunt?.liboliphauntVersion !== metadata.liboliphauntVersion)
    throw new Error('extension facade selected a different host contract');
  const contract = json(path.join(leafRoot, leaf.oliphaunt.extensionContract));
  if (
    contract.product !== metadata.product ||
    contract.version !== installed.version ||
    contract.target !== target ||
    !contract.members?.length
  )
    throw new Error('installed extension contract differs from the requested package');
  for (const member of contract.members) {
    if (
      member.nativeRuntimeProduct !== 'liboliphaunt-native' ||
      member.nativeRuntimeVersion !== metadata.liboliphauntVersion
    )
      throw new Error('extension member targets a different public host');
  }
  const version = metadata.liboliphauntVersion;
  const suffix = target === 'windows-x64-msvc' ? 'zip' : 'tar.gz';
  const name = `liboliphaunt-${version}-${target}.${suffix}`;
  const archive = path.join(directory, name);
  const frozen = lock.productArtifacts.find((artifact) => artifact.name === name);
  const url = `https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v${version}/${name}`;
  if (frozen) copyFileSync(path.join(ROOT, frozen.path), archive);
  else {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`exact public host returned ${response.status}`);
    writeFileSync(
      archive,
      await boundedResponseBytes(response, 2 * 1024 * 1024 * 1024, 'native host archive'),
    );
  }
  const entries = readPortableArchiveEntries(archive);
  const headers = [...entries.keys()].filter((name) => name.endsWith('include/oliphaunt.h'));
  if (headers.length !== 1) throw new Error('public native host must ship one public C header');
  const prefix = headers[0].slice(0, -'include/oliphaunt.h'.length).replace(/\/$/u, '');
  const host = path.join(directory, 'native-host');
  extractPortableArchiveTree(archive, host, prefix || undefined);
  for (const member of contract.members) {
    const runtime =
      leaf.oliphaunt.memberRuntimeRelativePaths?.[member.sqlName] ??
      leaf.oliphaunt.runtimeRelativePath;
    const modules =
      leaf.oliphaunt.memberModuleRelativePaths?.[member.sqlName] ??
      leaf.oliphaunt.moduleRelativePath;
    if (!runtime) throw new Error(`extension ${member.sqlName} has no installed runtime resources`);
    cpSync(path.join(leafRoot, runtime), path.join(host, 'runtime'), { recursive: true });
    if (modules)
      cpSync(path.join(leafRoot, modules), path.join(host, 'lib/modules'), { recursive: true });
  }
  const sql =
    contract.members
      .filter((member) => member.createsExtension)
      .map((member) => `CREATE EXTENSION "${member.sqlName.replaceAll('"', '""')}" CASCADE;`)
      .join('\n') + '\nSELECT 42;';
  const preloads = [
    ...new Set(contract.members.flatMap((member) => member.sharedPreloadLibraries ?? [])),
  ];
  await executeNativeArchive(test, host, directory, environment, sql, preloads);
  writeJson(path.join(directory, 'native-resolution.json'), {
    requested: `${installed.name}@${installed.version}`,
    leaf: `${leaf.name}@${leaf.version}`,
    contract,
    host: { url, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') },
  });
}

async function executeNativeArchive(
  test,
  host,
  directory,
  environment,
  sql = 'SELECT 42;',
  preloads = [],
) {
  const target = test.archiveTarget ?? test.target;
  const executable = path.join(directory, process.platform === 'win32' ? 'consume.exe' : 'consume');
  const fixture = path.join(ROOT, 'src/native/runtime/smoke/frozen-consumer.c');
  const libraryNames =
    process.platform === 'win32'
      ? ['oliphaunt.lib', 'liboliphaunt.lib']
      : [target.startsWith('macos-') ? 'liboliphaunt.dylib' : 'liboliphaunt.so'];
  const libraries = readdirSync(path.join(host, 'lib')).filter((name) =>
    libraryNames.includes(name),
  );
  if (libraries.length !== 1)
    throw new Error('packaged native host has no unique public linker library');
  const library = path.join(host, 'lib', libraries[0]);
  const compiler =
    process.platform === 'win32'
      ? [
          'cl',
          '/nologo',
          '/std:c11',
          '/MD',
          `/I${path.join(host, 'include')}`,
          fixture,
          library,
          `/Fe:${executable}`,
        ]
      : [
          'cc',
          ...(target === 'macos-x64' ? ['-arch', 'x86_64'] : []),
          '-I',
          path.join(host, 'include'),
          fixture,
          library,
          `-Wl,-rpath,${path.dirname(library)}`,
          '-o',
          executable,
        ];
  await command(compiler, directory, environment, path.join(directory, 'compile-c.log'));
  if (target === 'macos-x64') return;
  const runtime = path.join(host, 'runtime');
  const pgdata = path.join(directory, 'pgdata');
  const runEnvironment = {
    ...environment,
    PATH: [path.join(host, 'bin'), path.join(runtime, 'bin'), environment.PATH].join(
      path.delimiter,
    ),
    OLIPHAUNT_EMBEDDED_MODULE_DIR: path.join(host, 'lib/modules'),
    ...(process.platform === 'linux'
      ? {
          LD_LIBRARY_PATH: [path.join(host, 'lib'), path.join(runtime, 'lib')].join(path.delimiter),
        }
      : {}),
    ...(process.platform === 'darwin'
      ? {
          DYLD_LIBRARY_PATH: [path.join(host, 'lib'), path.join(runtime, 'lib')].join(
            path.delimiter,
          ),
        }
      : {}),
  };
  await command(
    [
      path.join(runtime, 'bin', process.platform === 'win32' ? 'initdb.exe' : 'initdb'),
      '-D',
      pgdata,
      '-U',
      'postgres',
      '--no-locale',
      '--encoding=UTF8',
    ],
    directory,
    runEnvironment,
    path.join(directory, 'initdb.log'),
  );
  await command(
    [executable, pgdata, runtime, sql, `shared_preload_libraries=${preloads.join(',')}`],
    directory,
    runEnvironment,
    path.join(directory, 'execute-c.log'),
  );
}

async function nativeArchiveConsumer(test, lock, directory, environment) {
  const artifact = lock.productArtifacts.find(
    (artifact) => artifact.id === test.artifactId && artifact.product === test.product,
  );
  const archive = path.join(ROOT, artifact.path);
  const entries = readPortableArchiveEntries(archive);
  const header = [...entries.keys()].filter((name) => name.endsWith('include/oliphaunt.h'));
  if (header.length !== 1) throw new Error('native C consumer requires the frozen public header');
  const host = path.join(directory, 'native-host');
  extractPortableArchiveTree(
    archive,
    host,
    header[0].slice(0, -'include/oliphaunt.h'.length).replace(/\/$/u, ''),
  );
  await executeNativeArchive(test, host, directory, environment);
  const resolution = {
    artifact: artifact.name,
    sha256: artifact.sha256,
    archiveTarget: artifact.target,
  };
  writeJson(path.join(directory, 'resolution.json'), resolution);
  return {
    resolutionDigest: consumerDigest(resolution),
    resolvedInputs: [
      {
        identity: artifact.name,
        source: 'frozen-native-c-archive',
        integrity: `sha256:${artifact.sha256}`,
      },
    ],
    toolchain: await command(
      process.platform === 'win32' ? ['cmd', '/c', 'cl /? 2>&1'] : ['cc', '--version'],
      directory,
      environment,
      path.join(directory, 'toolchain.log'),
    ),
  };
}

async function postmasterArchiveConsumer(test, lock, directory, environment) {
  const artifact = lock.productArtifacts.find((input) => input.id === test.artifactId);
  const packageRoot = path.join(directory, artifact.name.replace(/\.tar\.zst$/u, ''));
  extractPortableArchiveTree(path.join(ROOT, artifact.path), directory);
  const launcher = path.join(packageRoot, 'bin/oliphaunt-wasix-postmaster');
  const manifest = json(path.join(packageRoot, 'carrier/manifest.json'));
  const data = path.join(directory, 'pgdata');
  await command(
    ['bash', launcher, 'init', '--data-dir', data],
    directory,
    environment,
    path.join(directory, 'initialize.log'),
  );
  const postgresVersion = readFileSync(path.join(data, 'PG_VERSION'), 'utf8').trim();
  if (
    postgresVersion !== String(manifest['postgres-version']).split('.')[0] ||
    !existsSync(path.join(data, 'global/pg_control'))
  )
    throw new Error(
      'the shipped postmaster launcher did not initialize its declared PostgreSQL cluster',
    );
  const uri = await command(
    ['bash', launcher, 'uri', '--data-dir', data],
    directory,
    environment,
    path.join(directory, 'uri.log'),
  );
  if (uri.trim() !== 'postgresql://postgres@127.0.0.1:5432/postgres')
    throw new Error('the shipped postmaster launcher reported an unexpected connection URI');
  const resolution = {
    archive: artifact.name,
    sha256: artifact.sha256,
    postgresVersion,
    uri: uri.trim(),
    manifestDigest: consumerDigest(manifest),
  };
  writeJson(path.join(directory, 'resolution.json'), resolution);
  return {
    resolutionDigest: consumerDigest(resolution),
    resolvedInputs: [
      {
        identity: artifact.name,
        source: 'frozen-postmaster-archive',
        integrity: `sha256:${artifact.sha256}`,
      },
    ],
    toolchain: `sealed Wasmer ${manifest['wasmer-version']}, executor sha256:${manifest['executor-sha256']}`,
  };
}

function verifyFrozenFiles(lock) {
  lockedPublicationFiles(lock);
}

export function stageFrozenCargo(lock, directory) {
  const patches = [];
  for (const carrier of lock.carriers.filter((carrier) => carrier.ecosystem === 'cargo')) {
    const { file: archive } = lockedCarrierFile(lock, 'cargo', carrier.name);
    const destination = path.join(directory, 'crates', `${carrier.name}-${carrier.version}`);
    extractPortableArchiveTree(archive, destination, `${carrier.name}-${carrier.version}`);
    const manifest = Bun.TOML.parse(readFileSync(path.join(destination, 'Cargo.toml'), 'utf8'));
    if (
      manifest.package?.name !== carrier.name ||
      manifest.package?.version !== carrier.version ||
      Object.hasOwn(manifest.package?.metadata?.oliphaunt ?? {}, 'qualificationOnly')
    )
      throw new Error(`frozen Cargo identity differs: ${carrier.id}`);
    patches.push(`${JSON.stringify(carrier.name)} = { path = ${JSON.stringify(destination)} }`);
  }
  const config = path.join(directory, 'cargo-config.toml');
  writeFileSync(config, `[patch.crates-io]\n${patches.join('\n')}\n`);
  return config;
}

async function npmConsumer(
  test,
  carrier,
  lock,
  directory,
  registry,
  environment,
  { installed = false, repository } = {},
) {
  const mobile = carrier.product === 'oliphaunt-react-native';
  const peers = mobile
    ? json(path.join(ROOT, 'src/examples/native/react-native-expo/package.json')).dependencies
    : {};
  if (!installed) {
    writeJson(path.join(directory, 'package.json'), {
      name: 'frozen-consumer',
      private: true,
      ...(mobile ? { main: 'index.js' } : { type: 'module' }),
      dependencies: {
        ...(test.integration === 'browser'
          ? { vite: json(path.join(ROOT, 'src/wasix/sdks/ts/package.json')).devDependencies.vite }
          : {}),
        ...(mobile
          ? Object.fromEntries(['expo', 'react', 'react-native'].map((name) => [name, peers[name]]))
          : {}),
        [carrier.name]: carrier.version,
      },
    });
    writeFileSync(
      path.join(directory, '.npmrc'),
      `registry=https://registry.npmjs.org/\n@oliphaunt:registry=${registry.url}\n`,
    );
    await command(
      ['npm', 'install', '--no-audit', '--no-fund', '--cache', environment.NPM_CONFIG_CACHE],
      directory,
      environment,
      path.join(directory, 'install.log'),
    );
  }
  const manifest = json(path.join(directory, 'node_modules', carrier.name, 'package.json'));
  if (
    manifest.name !== carrier.name ||
    manifest.version !== carrier.version ||
    manifest.oliphaunt?.qualificationOnly
  )
    throw new Error(`npm installed the wrong ${carrier.id}`);
  const fixture = {
    'oliphaunt-js': 'src/native/sdks/ts/tools/frozen-consumer.mts',
    'oliphaunt-wasix-ts': 'src/wasix/sdks/ts/tools/frozen-consumer.mts',
    'oliphaunt-query-ts': 'src/query/ts/tools/frozen-consumer.mts',
  }[test.product];
  if (fixture) {
    const script =
      test.integration === 'browser'
        ? 'src/wasix/sdks/ts/tools/frozen-browser-consumer.mts'
        : fixture;
    copyFileSync(path.join(ROOT, script), path.join(directory, 'consume.mts'));
    if (test.integration === 'browser')
      copyFileSync(
        path.join(ROOT, 'src/wasix/sdks/ts/tools/browser-cdp.mts'),
        path.join(directory, 'browser-cdp.mts'),
      );
    const runtime = test.integration === 'browser' ? 'node' : (test.integration ?? 'node');
    const args =
      runtime === 'deno'
        ? ['deno', 'run', '--no-config', '--node-modules-dir=manual', '--allow-all']
        : [runtime];
    const data =
      test.integration && test.integration !== 'browser'
        ? path.join(directory, `runtime-${test.integration}`)
        : directory;
    mkdirSync(data, { recursive: true });
    await command(
      [...args, 'consume.mts', data],
      directory,
      environment,
      path.join(directory, 'execute.log'),
    );
  } else if (carrier.product === 'oliphaunt-react-native') {
    await reactNativeConsumer(test, manifest, lock, directory, environment, repository);
  } else if (manifest.exports?.['.'] || manifest.main) {
    writeFileSync(
      path.join(directory, 'consume.mts'),
      manifest.main?.endsWith('.node')
        ? `import { createRequire } from 'node:module'; createRequire(import.meta.url)(${JSON.stringify(carrier.name)});\n`
        : `await import(${JSON.stringify(carrier.name)});\n`,
    );
    await command(
      ['node', 'consume.mts'],
      directory,
      environment,
      path.join(directory, 'execute.log'),
    );
  }
  if (
    manifest.oliphaunt?.liboliphauntVersion &&
    (manifest.oliphaunt.targetPackageNames || manifest.oliphaunt.extensionContract)
  )
    await nativePackageConsumer(test, manifest, lock, directory, environment);
  const resolution = json(path.join(directory, 'package-lock.json'));
  if (
    resolution.packages?.[`node_modules/${carrier.name}`]?.integrity !==
    registry.integrityFor(carrier.name, carrier.version)
  )
    throw new Error(`npm did not consume the frozen ${carrier.id} archive`);
  const native = existsSync(path.join(directory, 'native-resolution.json'))
    ? json(path.join(directory, 'native-resolution.json'))
    : null;
  const mobileResolution = existsSync(path.join(directory, 'resolution.json'))
    ? json(path.join(directory, 'resolution.json'))
    : null;
  return {
    resolutionDigest: consumerDigest({ npm: resolution, native, mobile: mobileResolution }),
    resolvedInputs: [
      ...Object.entries(resolution.packages ?? {})
        .filter(([location, pkg]) => location && pkg.version && pkg.integrity)
        .map(([location, pkg]) => ({
          identity: `${pkg.name ?? location.split('node_modules/').at(-1)}@${pkg.version}`,
          source: pkg.resolved,
          integrity: pkg.integrity,
        })),
      ...(native
        ? [
            {
              identity: native.host.url,
              source: native.host.url,
              integrity: `sha256:${native.host.sha256}`,
            },
          ]
        : []),
      ...(mobileResolution ?? []),
    ],
    toolchain:
      (await command(
        ['npm', '--version'],
        directory,
        environment,
        path.join(directory, 'toolchain.log'),
      )) +
      (test.integration
        ? await command(
            [test.integration === 'browser' ? 'google-chrome' : test.integration, '--version'],
            directory,
            environment,
            path.join(directory, 'runtime-toolchain.log'),
          )
        : ''),
  };
}

async function cargoConsumer(test, carrier, lock, directory, config, environment) {
  mkdirSync(path.join(directory, 'src'), { recursive: true });
  let manifest = `[package]\nname = "frozen-consumer"\nversion = "0.0.0"\nedition = "2024"\n[workspace]\n[dependencies]\n${JSON.stringify(carrier.name)} = ${JSON.stringify(`=${carrier.version}`)}\n`;
  let fixture = `extern crate ${carrier.name.replaceAll('-', '_')};\nfn main() {}\n`;
  if (['oliphaunt', 'oliphaunt-wasix'].includes(carrier.name)) {
    const archive = lockedCarrierFile(lock, 'cargo', carrier.name).file;
    const entries = readPortableArchiveEntries(archive);
    const source = Bun.TOML.parse(
      Buffer.from(entries.get(`${carrier.name}-${carrier.version}/Cargo.toml`).data()).toString(
        'utf8',
      ),
    );
    const version =
      source.package.metadata.oliphaunt[
        carrier.name === 'oliphaunt' ? 'native-version' : 'runtime-version'
      ];
    if (!version) throw new Error('SDK has no packaged runtime requirement');
    if (carrier.name === 'oliphaunt') {
      manifest += `liboliphaunt-native-${test.target} = "=${version}"\n[build-dependencies]\noliphaunt-build = "=${carrier.version}"\n[package.metadata.oliphaunt]\nruntime = "liboliphaunt-native"\nruntime-version = "${version}"\n`;
      writeFileSync(
        path.join(directory, 'build.rs'),
        'fn main() { oliphaunt_build::configure(); }\n',
      );
    }
    fixture = `use ${carrier.name.replaceAll('-', '_')}::Oliphaunt;\nfn main() -> Result<(), Box<dyn std::error::Error>> { ${carrier.name === 'oliphaunt' ? 'oliphaunt::register_build_resources!();' : ''} let mut db = Oliphaunt::open()?; let result = db.sql("SELECT 42::int4 AS answer").query()?; assert_eq!(result.rows()[0].try_get::<i32>("answer")?, 42); db.close()?; Ok(()) }\n`;
  }
  writeFileSync(path.join(directory, 'Cargo.toml'), manifest);
  writeFileSync(path.join(directory, 'src/main.rs'), fixture);
  await command(
    ['cargo', '--config', config, 'run', '--manifest-path', path.join(directory, 'Cargo.toml')],
    directory,
    environment,
    path.join(directory, 'execute.log'),
  );
  const resolution = Bun.TOML.parse(readFileSync(path.join(directory, 'Cargo.lock'), 'utf8'));
  if (
    !resolution.package.some(
      (pkg) => pkg.name === carrier.name && pkg.version === carrier.version && !pkg.source,
    )
  )
    throw new Error(`Cargo did not consume the frozen ${carrier.id}`);
  return {
    resolutionDigest: consumerDigest(resolution),
    resolvedInputs: resolution.package
      .filter((pkg) => pkg.name !== 'frozen-consumer')
      .map((pkg) => {
        const frozen = lock.carriers.find(
          (input) =>
            input.ecosystem === 'cargo' && input.name === pkg.name && input.version === pkg.version,
        );
        const artifact = frozen && lockedCarrierFile(lock, 'cargo', pkg.name).carrier.artifacts[0];
        if (!pkg.source && !artifact)
          throw new Error(`Cargo resolved an undeclared local input ${pkg.name}@${pkg.version}`);
        return {
          identity: `${pkg.name}@${pkg.version}`,
          source: pkg.source ?? 'frozen-crate-path-patch',
          integrity: `sha256:${pkg.checksum ?? artifact.sha256}`,
        };
      }),
    toolchain: await command(
      ['cargo', '--version'],
      directory,
      environment,
      path.join(directory, 'toolchain.log'),
    ),
  };
}

export function stageFrozenMaven(lock, directory) {
  const repository = path.join(directory, 'repository');
  for (const candidate of lock.carriers.filter((carrier) => carrier.ecosystem === 'maven')) {
    const [group, artifact] = candidate.name.split(':');
    if (!group || !artifact) throw new Error(`invalid Maven coordinate: ${candidate.name}`);
    for (const input of candidate.artifacts) {
      const name = path.basename(input.path);
      if (
        !name.startsWith(`${artifact}-${candidate.version}.`) &&
        !name.startsWith(`${artifact}-${candidate.version}-`)
      )
        throw new Error(`Maven artifact differs from its coordinates: ${input.path}`);
      const destination = path.join(
        repository,
        group.replaceAll('.', '/'),
        artifact,
        candidate.version,
        name,
      );
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(ROOT, input.path), destination);
    }
  }
  return repository;
}

async function reactNativeConsumer(test, installed, lock, directory, environment, repository) {
  const platform = test.target === 'macos-arm64' ? 'ios' : 'android';
  const buildEnvironment = { ...environment, CI: '1', EXPO_NO_TELEMETRY: '1' };
  const resolvedInputs = [];
  writeJson(path.join(directory, 'app.json'), {
    expo: {
      name: 'FrozenConsumer',
      slug: 'frozen-consumer',
      ios: { bundleIdentifier: 'dev.oliphaunt.frozenconsumer' },
      android: { package: 'dev.oliphaunt.frozenconsumer' },
      plugins: [['@oliphaunt/react-native', { extensions: [], topology: 'direct' }]],
    },
  });
  writeFileSync(
    path.join(directory, 'index.js'),
    "import { registerRootComponent } from 'expo';\nimport React from 'react';\nimport { Text } from 'react-native';\nimport Oliphaunt from '@oliphaunt/react-native';\nregisterRootComponent(() => React.createElement(Text, {}, typeof Oliphaunt));\n",
  );
  if (platform === 'ios') {
    const packageRoot = path.join(directory, 'node_modules', installed.name);
    const pointer = installed.oliphaunt?.iosCarrierManifest;
    if (!pointer) throw new Error('React Native package has no installed iOS carrier manifest');
    const original = json(path.join(packageRoot, pointer));
    const localized = structuredClone(original);
    for (const carrier of [...localized.base.assets, ...localized.carriers]) {
      const location = new URL(carrier.url);
      if (
        location.origin !== 'https://github.com' ||
        !location.pathname.startsWith('/f0rr0/oliphaunt/releases/download/') ||
        path.basename(location.pathname) !== carrier.name
      )
        throw new Error('iOS carrier does not name a canonical public provider');
      resolvedInputs.push({
        identity: carrier.name,
        source: carrier.url,
        integrity: `sha256:${carrier.sha256}`,
      });
      const frozen = lock.productArtifacts.find((input) => input.name === carrier.name);
      if (!frozen) continue;
      const bytes = readFileSync(path.join(ROOT, frozen.path));
      if (
        bytes.length !== carrier.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== carrier.sha256
      )
        throw new Error('iOS provider differs from the frozen package contract');
      carrier.url = (await import('node:url')).pathToFileURL(path.join(ROOT, frozen.path)).href;
    }
    const local = path.join(directory, 'ios-carriers.json');
    writeJson(local, localized);
    buildEnvironment.OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER = local;
    buildEnvironment.OLIPHAUNT_REACT_NATIVE_IOS_ALLOW_FILE_URLS = '1';
    buildEnvironment.OLIPHAUNT_REACT_NATIVE_IOS_CACHE_DIR = path.join(directory, 'ios-cache');
    const swift = lock.products.find(
      (product) =>
        product.id === 'oliphaunt-swift' && product.version === installed.oliphaunt.swiftSdkVersion,
    );
    if (swift) {
      const tree = lock.productArtifacts.find(
        (artifact) => artifact.product === swift.id && artifact.kind === 'swiftpm-release-tree',
      );
      const manifest = lock.productArtifacts.find(
        (artifact) => artifact.product === swift.id && artifact.kind === 'swiftpm-release-manifest',
      );
      const bindings = lock.productArtifacts.find(
        (artifact) =>
          artifact.product === swift.id &&
          artifact.name === `oliphaunt-swift-${swift.version}-bindings.xcframework.zip`,
      );
      if (!tree || !manifest || !bindings)
        throw new Error('React Native requires the exact frozen Swift source and bindings');
      const sdk = path.join(directory, 'swift-source');
      cpSync(path.join(ROOT, tree.path), sdk, { recursive: true });
      copyFileSync(path.join(ROOT, manifest.path), path.join(sdk, 'Package.swift'));
      mkdirSync(path.join(sdk, 'Artifacts'), { recursive: true });
      copyFileSync(path.join(ROOT, bindings.path), path.join(sdk, 'Artifacts', bindings.name));
      for (const argv of [
        ['git', 'init'],
        ['git', 'add', '.'],
        [
          'git',
          '-c',
          'user.name=Frozen consumer',
          '-c',
          'user.email=consumer@localhost',
          'commit',
          '-m',
          'Frozen Swift consumer input',
        ],
        ['git', 'tag', swift.version],
      ])
        await command(
          argv,
          sdk,
          buildEnvironment,
          path.join(directory, `swift-git-${argv[1]}.log`),
        );
      buildEnvironment.OLIPHAUNT_SWIFT_SDK_GIT_URL = (await import('node:url')).pathToFileURL(
        sdk,
      ).href;
      buildEnvironment.OLIPHAUNT_SWIFT_SDK_TAG = swift.version;
      resolvedInputs.push(
        ...[tree, manifest, bindings].map((input) => ({
          identity: input.name,
          source: 'frozen-swift-source',
          integrity: `sha256:${input.sha256}`,
        })),
      );
    }
  }
  await command(
    [
      path.join(directory, 'node_modules/.bin/expo'),
      'prebuild',
      '--platform',
      platform,
      '--no-install',
    ],
    directory,
    buildEnvironment,
    path.join(directory, 'prebuild.log'),
  );
  if (platform === 'android') {
    const init = path.join(directory, 'repositories.gradle');
    writeFileSync(
      init,
      `settingsEvaluated { settings -> settings.pluginManagement.repositories { ${frozenMavenRepositoryDeclaration(lock, repository)} } }\nallprojects { repositories { ${frozenMavenRepositoryDeclaration(lock, repository)} } }\ngradle.projectsEvaluated { gradle.rootProject.tasks.register('frozenConsumerResolution') { doLast { def rows = gradle.rootProject.allprojects.collectMany { p -> p.configurations.findAll { it.canBeResolved && (it.name in ['debugCompileClasspath', 'debugRuntimeClasspath'] || it.name.startsWith('oliphauntAndroid')) }.collectMany { c -> c.resolvedConfiguration.resolvedArtifacts.collect { a -> [identity: a.moduleVersion.id.toString(), path: a.file.absolutePath] } } }; new File(${JSON.stringify(path.join(directory, 'android-resolution.json'))}).text = groovy.json.JsonOutput.toJson(rows) } } }\n`,
    );
    await command(
      [
        'bash',
        path.join(directory, 'android/gradlew'),
        '--no-daemon',
        '--init-script',
        init,
        'assembleDebug',
        'frozenConsumerResolution',
        '-PreactNativeArchitectures=arm64-v8a,x86_64',
      ],
      path.join(directory, 'android'),
      buildEnvironment,
      path.join(directory, 'android-build.log'),
    );
    for (const row of json(path.join(directory, 'android-resolution.json'))) {
      const integrity = `sha256:${createHash('sha256').update(readFileSync(row.path)).digest('hex')}`;
      const candidate = lock.carriers.find(
        (carrier) =>
          carrier.ecosystem === 'maven' && `${carrier.name}:${carrier.version}` === row.identity,
      );
      if (
        candidate &&
        !candidate.artifacts.some((artifact) => integrity === `sha256:${artifact.sha256}`)
      )
        throw new Error(`Android substituted frozen Maven input ${row.identity}`);
      resolvedInputs.push({ identity: row.identity, source: row.path, integrity });
    }
  } else {
    await command(
      ['pod', 'install', '--project-directory=ios'],
      directory,
      buildEnvironment,
      path.join(directory, 'pods.log'),
    );
    const workspace = readdirSync(path.join(directory, 'ios')).find((name) =>
      name.endsWith('.xcworkspace'),
    );
    if (!workspace) throw new Error('CocoaPods did not produce a consumer workspace');
    await command(
      [
        'xcodebuild',
        '-workspace',
        path.join(directory, 'ios', workspace),
        '-scheme',
        'FrozenConsumer',
        '-configuration',
        'Debug',
        '-sdk',
        'iphonesimulator',
        '-destination',
        'generic/platform=iOS Simulator',
        '-derivedDataPath',
        path.join(directory, 'derived-data'),
        'CODE_SIGNING_ALLOWED=NO',
        'build',
      ],
      directory,
      buildEnvironment,
      path.join(directory, 'ios-build.log'),
    );
  }
  writeJson(path.join(directory, 'resolution.json'), resolvedInputs);
}

export function frozenMavenRepositoryDeclaration(lock, repository) {
  const versions = lock.carriers
    .filter((carrier) => carrier.ecosystem === 'maven')
    .map((carrier) => {
      const [group, artifact] = carrier.name.split(':');
      return `includeVersion(${[group, artifact, carrier.version].map((value) => JSON.stringify(value)).join(', ')})`;
    });
  return `exclusiveContent { forRepository { maven { url = uri(${JSON.stringify(repository)}) } }; filter { ${versions.join('; ')} } }`;
}

async function mavenConsumer(carrier, lock, directory, environment, repository) {
  const repositories = `${frozenMavenRepositoryDeclaration(lock, repository)}; google(); mavenCentral(); gradlePluginPortal()`;
  writeFileSync(
    path.join(directory, 'settings.gradle.kts'),
    `pluginManagement { repositories { ${repositories} } }\nrootProject.name = "frozen-consumer"\n`,
  );
  const android = carrier.product === 'oliphaunt-kotlin';
  let build;
  if (android) {
    const pins = Bun.TOML.parse(
      readFileSync(path.join(ROOT, 'src/native/sdks/kotlin/gradle/libs.versions.toml'), 'utf8'),
    ).versions;
    build = `plugins { id("com.android.library") version "${pins['android-gradle-plugin']}"; id("org.jetbrains.kotlin.android") version "${pins.kotlin}"; id("dev.oliphaunt.android") version "${carrier.version}" }\nrepositories { ${repositories} }\nandroid { namespace = "dev.oliphaunt.consumer"; compileSdk = 36; defaultConfig { minSdk = 24 } }\nkotlin { jvmToolchain(17) }\ndependencies { implementation("dev.oliphaunt:oliphaunt-android:${carrier.version}") }\n`;
    cpSync(
      path.join(ROOT, 'src/native/sdks/kotlin/tests/public-api-consumer/src'),
      path.join(directory, 'src'),
      { recursive: true },
    );
    mkdirSync(path.join(directory, 'src/main'), { recursive: true });
    writeFileSync(path.join(directory, 'src/main/AndroidManifest.xml'), '<manifest/>\n');
  } else {
    const suffix = carrier.artifacts.some((input) => input.path.endsWith('.tar.gz'))
      ? '@tar.gz'
      : '';
    build = `repositories { ${repositories} }\nval candidate by configurations.creating\ndependencies { candidate(${JSON.stringify(`${carrier.name}:${carrier.version}${suffix}`)}) }\n`;
  }
  const names = android
    ? [
        'debugCompileClasspath',
        'oliphauntAndroidRuntimeArtifacts',
        'oliphauntAndroidExtensionArtifacts',
        'oliphauntAndroidIcuArtifacts',
        'oliphauntAndroidSeedArtifacts',
      ]
    : ['candidate'];
  build += `tasks.register("consume") { doLast { val rows = listOf(${names.map((name) => JSON.stringify(name)).join(',')}).flatMap { name -> configurations.getByName(name).resolvedConfiguration.resolvedArtifacts.map { mapOf("identity" to it.moduleVersion.id.toString(), "configuration" to name, "path" to it.file.absolutePath) } }${android ? ' + buildscript.configurations.getByName("classpath").resolvedConfiguration.resolvedArtifacts.map { mapOf("identity" to it.moduleVersion.id.toString(), "configuration" to "plugin-classpath", "path" to it.file.absolutePath) }' : ''}; check(rows.isNotEmpty()); file("resolution.json").writeText(groovy.json.JsonOutput.toJson(rows)) } }\n`;
  writeFileSync(path.join(directory, 'build.gradle.kts'), build);
  await command(
    [
      'bash',
      path.join(ROOT, 'src/native/sdks/kotlin/gradlew'),
      '--no-daemon',
      '--project-dir',
      directory,
      ...(android ? ['assembleDebug'] : []),
      'consume',
    ],
    directory,
    environment,
    path.join(directory, 'execute.log'),
  );
  const resolution = json(path.join(directory, 'resolution.json')).map((row) => ({
    ...row,
    sha256: createHash('sha256').update(readFileSync(row.path)).digest('hex'),
  }));
  const resolvedInputs = resolution.map((row) => ({
    identity: row.identity,
    source: row.path,
    integrity: `sha256:${row.sha256}`,
  }));
  assertFrozenMavenConsumerInputs(carrier, resolvedInputs);
  writeJson(path.join(directory, 'resolution.json'), resolution);
  return {
    resolutionDigest: consumerDigest(resolution),
    resolvedInputs,
    toolchain: await command(
      ['bash', path.join(ROOT, 'src/native/sdks/kotlin/gradlew'), '--version'],
      directory,
      environment,
      path.join(directory, 'toolchain.log'),
    ),
  };
}

export function assertFrozenMavenConsumerInputs(carrier, resolution) {
  const inputs = carrier.artifacts.filter(
    (input) =>
      /\.(?:jar|aar|tar\.gz)$/u.test(input.path) &&
      !/-sources\.jar$|-javadoc\.jar$/u.test(input.path),
  );
  for (const input of inputs) {
    if (
      !resolution.some(
        (row) =>
          row.identity === `${carrier.name}:${carrier.version}` &&
          row.integrity === `sha256:${input.sha256}`,
      )
    )
      throw new Error(`Gradle did not consume frozen input ${input.path}`);
  }
}

async function swiftConsumer(test, lock, directory, environment) {
  const { localizeSwiftReleaseManifest } = await import(
    '../../src/native/sdks/swift/tools/prepare-swift-release-consumer.mts'
  );
  const manifests = lock.productArtifacts.filter(
    (artifact) => artifact.product === test.product && artifact.kind === 'swiftpm-release-manifest',
  );
  if (manifests.length !== 1)
    throw new Error('Swift consumer requires its frozen release manifest');
  const manifest = readFileSync(path.join(ROOT, manifests[0].path), 'utf8');
  const binaries = [
    ...manifest.matchAll(
      /url:\s*"(https:\/\/github\.com\/f0rr0\/oliphaunt\/releases\/download\/[^"]+)"\s*,\s*checksum:\s*"([0-9a-f]{64})"/gu,
    ),
  ];
  const assets = [];
  mkdirSync(path.join(directory, 'Artifacts'), { recursive: true });
  for (const [, url, checksum] of binaries) {
    const name = path.basename(new URL(url).pathname);
    const frozen = lock.productArtifacts.find((artifact) => artifact.name === name);
    let bytes;
    if (frozen) bytes = readFileSync(path.join(ROOT, frozen.path));
    else {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Swift provider returned ${response.status}`);
      bytes = await boundedResponseBytes(response, 2 * 1024 * 1024 * 1024, 'Swift provider');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== checksum)
      throw new Error(`Swift provider checksum differs: ${name}`);
    const archive = path.join(directory, name);
    writeFileSync(archive, bytes);
    const framework = name.startsWith('liboliphaunt-')
      ? 'liboliphaunt.xcframework'
      : 'OliphauntNativeBindingsFFI.xcframework';
    extractPortableArchiveTree(archive, path.join(directory, 'Artifacts', framework), framework);
    assets.push(archive);
  }
  const tree = lock.productArtifacts.find(
    (artifact) => artifact.product === test.product && artifact.kind === 'swiftpm-release-tree',
  );
  if (!tree) throw new Error('Swift consumer requires its frozen source tree');
  cpSync(path.join(ROOT, tree.path), directory, { recursive: true });
  localizeSwiftReleaseManifest({
    manifestFile: path.join(ROOT, manifests[0].path),
    assetFile: assets.find((file) => path.basename(file).startsWith('liboliphaunt-')),
    bindingsAssetFile: assets.find((file) => path.basename(file).startsWith('oliphaunt-swift-')),
    outputFile: path.join(directory, 'Package.swift'),
  });
  const app = path.join(directory, 'app');
  mkdirSync(path.join(app, 'Sources/FrozenConsumer'), { recursive: true });
  writeFileSync(
    path.join(app, 'Package.swift'),
    '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "FrozenConsumer", platforms: [.macOS(.v14), .iOS(.v17)], dependencies: [.package(path: "..")], targets: [.executableTarget(name: "FrozenConsumer", dependencies: [.product(name: "Oliphaunt", package: "case-' +
      path.basename(directory).replace('case-', '') +
      '")])])\n',
  );
  // SwiftPM's local identity is the directory basename, independently of the package display name.
  writeFileSync(
    path.join(app, 'Sources/FrozenConsumer/Consumer.swift'),
    'import Oliphaunt\n@main struct Consumer { static func main() async throws { let db = try await OliphauntDatabase.open(); let result = try await db.query("SELECT 42::int4 AS answer"); let answer: Int32? = try result.rows[0].value(named: "answer"); precondition(answer == 42); try await db.close() } }\n',
  );
  if (test.integration === 'ios') {
    const sdk = (
      await command(
        ['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'],
        directory,
        environment,
        path.join(directory, 'sdk.log'),
      )
    ).trim();
    await command(
      [
        'swift',
        'build',
        '--package-path',
        app,
        '--triple',
        'arm64-apple-ios17.0-simulator',
        '--sdk',
        sdk,
      ],
      directory,
      environment,
      path.join(directory, 'execute.log'),
    );
  } else
    await command(
      ['swift', 'run', '--package-path', app, 'FrozenConsumer'],
      directory,
      environment,
      path.join(directory, 'execute.log'),
    );
  const resolution = {
    manifest,
    providers: binaries.map(([, url, checksum]) => ({ url, checksum })),
  };
  writeJson(path.join(directory, 'resolution.json'), resolution);
  return {
    resolutionDigest: consumerDigest(resolution),
    resolvedInputs: [
      {
        identity: manifests[0].name,
        source: 'frozen-swift-localization',
        integrity: `sha256:${manifests[0].sha256}`,
      },
      ...resolution.providers.map((provider) => ({
        identity: path.basename(new URL(provider.url).pathname),
        source: provider.url,
        integrity: `sha256:${provider.checksum}`,
      })),
    ],
    toolchain: await command(
      ['swift', '--version'],
      directory,
      environment,
      path.join(directory, 'toolchain.log'),
    ),
  };
}

export async function runFrozenConsumers(lock, target, output) {
  const plan = frozenConsumerPlan(lock);
  const tests = plan.cases.filter((test) => test.target === target);
  if (!tests.length) throw new Error(`no required consumer cases for ${target}`);
  const platform = DESKTOP_TARGETS[target];
  if (process.platform !== platform.npmOs || process.arch !== platform.npmCpu)
    throw new Error(`consumer host does not match ${target}`);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-frozen-consumers-'));
  const result = {
    producer: {
      controllerSHA: process.env.GITHUB_SHA,
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      jobName: `Frozen consumers (${target})`,
    },
    lockDigest: lock.lockDigest,
    casePlanDigest: consumerDigest(plan),
    testConfigurationDigest: plan.testConfigurationDigest,
    cases: [],
  };
  let registry;
  try {
    verifyFrozenFiles(lock);
    const capabilities = frozenConsumerMatrix(plan).include.find((row) => row.target === target);
    const packages = lock.carriers.filter((carrier) => carrier.ecosystem === 'npm');
    if (capabilities.npm)
      registry = await frozenNpmRegistry(
        packages.map((carrier) =>
          frozenNpmPackage(lockedCarrierFile(lock, 'npm', carrier.name).file),
        ),
      );
    // Cargo resolves dependencies for every target when creating its lockfile.
    const config = capabilities.cargo ? stageFrozenCargo(lock, scratch) : null;
    const repository =
      capabilities.maven || capabilities.expo ? stageFrozenMaven(lock, scratch) : null;
    const installations = new Map();
    for (const [index, test] of tests.entries()) {
      const key = consumerInstallationKey(test);
      const previous = installations.get(key);
      const directory = previous?.directory ?? path.join(scratch, `case-${index}`);
      mkdirSync(directory, { recursive: true });
      const environment = sanitizedPublicEnvironment({
        NPM_CONFIG_USERCONFIG: path.join(directory, '.npmrc'),
        NPM_CONFIG_CACHE: path.join(scratch, 'npm-cache'),
        GRADLE_USER_HOME: path.join(scratch, 'gradle-home'),
      });
      const carrier = lock.carriers.find((carrier) => carrier.id === test.carrierId);
      const consume =
        carrier?.ecosystem === 'npm'
          ? () =>
              npmConsumer(test, carrier, lock, directory, registry, environment, {
                installed: Boolean(previous),
                repository,
              })
          : carrier?.ecosystem === 'cargo'
            ? () =>
                cargoConsumer(test, carrier, lock, directory, config, {
                  ...publicCargoEnvironment(scratch),
                  CARGO_TARGET_DIR: path.join(scratch, 'cargo-target'),
                })
            : carrier?.ecosystem === 'maven'
              ? () => {
                  if (!previous)
                    return mavenConsumer(carrier, lock, directory, environment, repository);
                  assertFrozenMavenConsumerInputs(carrier, previous.evidence.resolvedInputs);
                  return previous.evidence;
                }
              : test.transportMode === 'frozen-native-c-archive'
                ? () => nativeArchiveConsumer(test, lock, directory, environment)
                : test.transportMode === 'frozen-postmaster-archive'
                  ? () => postmasterArchiveConsumer(test, lock, directory, environment)
                  : () => swiftConsumer(test, lock, directory, environment);
      try {
        const evidence = await consume();
        result.cases.push({
          ...test,
          producer: result.producer,
          logReference: `${path.basename(output)}.logs/case-${index}`,
          ...(carrier?.ecosystem === 'npm'
            ? {
                installationReference:
                  previous?.reference ?? `${path.basename(output)}.logs/case-${index}/install.log`,
              }
            : {}),
          status: 'success',
          ...evidence,
          ...(previous && carrier?.ecosystem === 'maven'
            ? { executionReference: previous.reference }
            : {}),
        });
        if (carrier?.ecosystem === 'npm' || carrier?.product === 'oliphaunt-kotlin')
          installations.set(key, {
            directory,
            evidence,
            reference:
              previous?.reference ??
              `${path.basename(output)}.logs/case-${index}/${carrier.ecosystem === 'npm' ? 'install' : 'execute'}.log`,
          });
      } catch (cause) {
        result.cases.push({ ...test, status: 'failure', error: String(cause) });
        throw cause;
      } finally {
        writeJson(output, result);
        const logs = `${output}.logs/case-${index}`;
        mkdirSync(logs, { recursive: true });
        for (const name of readdirSync(directory).filter((name) =>
          /\.log$|^(?:package-lock\.json|Cargo\.lock|resolution\.json|native-resolution\.json)$/u.test(
            name,
          ),
        ))
          copyFileSync(path.join(directory, name), path.join(logs, name));
      }
    }
    verifyFrozenFiles(lock);
    return result;
  } finally {
    registry?.close();
    // Sealed packages retain read-only directories during execution.
    const writable = (directory) => {
      chmodSync(directory, 0o700);
      for (const child of readdirSync(directory, { withFileTypes: true }))
        if (child.isDirectory()) writable(path.join(directory, child.name));
    };
    writable(scratch);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [operation, lockFile, ...args] = process.argv.slice(2);
  const lock = loadPublicationLock(lockFile);
  if (operation === 'plan') {
    const plan = frozenConsumerPlan(lock);
    writeJson(args[0], plan);
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `matrix=${JSON.stringify(frozenConsumerMatrix(plan))}\n`,
      );
    }
  } else if (operation === 'run') await runFrozenConsumers(lock, args[0], args[1]);
  else throw new Error('usage: frozen-consumer.mts <plan LOCK OUTPUT|run LOCK TARGET OUTPUT>');
}
