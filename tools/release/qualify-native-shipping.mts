#!/usr/bin/env bun
import assert from 'node:assert/strict';
/** Build shipping roots once and retain configured construction evidence. */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import { canonicalShippingLabel } from './bazel-shipping-inputs.mts';
import {
  type NativeBuildEvidence,
  type NativeBuildGithub,
  nativeBuildMetadata,
} from './native-build-qualification.mts';
import { readNativePublicationArtifacts } from './native-publication-artifacts.mts';
import {
  captureNativeOutputMembers,
  captureNativePublicationOutputs,
} from './native-publication-staging.mts';
import { loadPublicationCatalog, resolveActualCarrier } from './publication-catalog.mts';
import {
  assertWasixPublicationPackages,
  discoverProductArtifacts,
  discoverPublicationArtifacts,
  expectedProductArtifactRows,
  validateCargoPayloadPartSets,
} from './publication-lock.mts';

export type NativeShippingRequest = {
  github: NativeBuildGithub;
  startup?: string[];
  configuration: string[];
  shipping: { export: string } | { roots: string[] };
  targets: string[];
  completeProducts?: string[];
  outputDirectory: string;
};

function argv(value: unknown, context: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item || /[\u0000-\u001f\u007f]/u.test(item))
  )
    throw new Error(`${context} must be an array of nonempty argv strings`);
  return value;
}

function label(value: string): string {
  value = canonicalShippingLabel(value);
  if (!/^\/\/[A-Za-z0-9_./+-]*:[A-Za-z0-9_./+-]+$/u.test(value))
    throw new Error(`shipping qualification requires an explicit workspace target: ${value}`);
  return value;
}

function json(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** A complete family must survive the conventional readers before and after freezing its outputs. */
function checkCompleteProducts(evidence: NativeBuildEvidence, products: string[]) {
  const catalog = loadPublicationCatalog('native shipping qualification');
  const selected = new Set(products);
  const authority = {
    catalog,
    artifactRows: expectedProductArtifactRows(catalog.products),
    resolveCarrier: (ecosystem: string, name: string) =>
      resolveActualCarrier(catalog, ecosystem, name, 'native shipping qualification'),
  };
  const cohorts = evidence.cohorts
    .map((cohort) => ({
      ...cohort,
      roots: cohort.roots.filter(({ package: pkg }) => selected.has(pkg.product)),
    }))
    .filter((cohort) => cohort.roots.length);
  const outputs = captureNativePublicationOutputs(cohorts, {
    sourceCommit: evidence.source.commit,
  });
  for (const cohort of cohorts) {
    const declared = new Set(
      cohort.roots
        .filter(({ package: pkg }) => pkg.ecosystem !== 'internal')
        .flatMap(({ package: pkg }) => pkg.outputs.map(({ path: file }) => file)),
    );
    for (const file of declared) {
      const expected = cohort.outputs.find(({ path: output }) => output === file);
      if (!expected)
        throw new Error('native complete-family output is missing from build evidence');
      assert.deepStrictEqual(
        captureNativeOutputMembers(cohort.executionRoot, file).members,
        expected.members,
        'native complete-family output differs from build evidence',
      );
    }
  }
  const physical = readNativePublicationArtifacts(authority, cohorts, { products });
  const staged = outputs.stage();
  const registry = discoverPublicationArtifacts(staged);
  assertWasixPublicationPackages(registry);
  validateCargoPayloadPartSets(
    registry.map((record) => ({
      ...authority.resolveCarrier(record.ecosystem, record.name),
      packageDependencies: record.dependencies,
    })),
  );
  const publicFiles = discoverProductArtifacts(
    staged,
    catalog.products.filter(({ id }) => selected.has(id)),
  );
  const registryBytes = (records: typeof registry) =>
    records
      .map((record) => ({
        ecosystem: record.ecosystem,
        name: record.name,
        version: record.version,
        dependencies: record.dependencies,
        qualificationOnly: record.qualificationOnly,
        artifacts: record.artifacts.map(({ size, sha256 }) => ({ size, sha256 })),
      }))
      .sort((left, right) =>
        `${left.ecosystem}:${left.name}`.localeCompare(`${right.ecosystem}:${right.name}`),
      );
  const publicBytes = (records: typeof publicFiles) =>
    records
      .map(({ path: _path, ...record }) => record)
      .sort((left, right) =>
        `${left.product}:${left.id}`.localeCompare(`${right.product}:${right.id}`),
      );
  assert.deepStrictEqual(registryBytes(registry), registryBytes(physical.registryArtifacts));
  assert.deepStrictEqual(publicBytes(publicFiles), publicBytes(physical.productArtifacts));
}

/** The caller keeps this checkout and its producer inputs frozen through capture. */
export function qualifyNativeShipping(request: NativeShippingRequest, directory = process.cwd()) {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  const workspace = git('rev-parse', '--show-toplevel');
  const source = {
    commit: git('rev-parse', 'HEAD^{commit}'),
    tree: git('rev-parse', 'HEAD^{tree}'),
  };
  const assertSource = () => {
    try {
      execFileSync(
        'bash',
        ['tools/release/qualified-release-replay.sh', source.commit, source.commit],
        {
          cwd: workspace,
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
    } catch (cause) {
      throw new Error(
        'shipping qualification requires a clean checkout without index suppression flags',
        { cause },
      );
    }
    if (
      git('rev-parse', 'HEAD^{commit}') !== source.commit ||
      git('rev-parse', 'HEAD^{tree}') !== source.tree
    )
      throw new Error('shipping qualification source changed during construction');
  };
  assertSource();
  const startup = argv(request.startup ?? [], 'startup');
  if (startup.includes('--')) throw new Error('startup cannot contain an argv separator');
  const configuration = argv(request.configuration, 'configuration');
  if (
    configuration.some(
      (item) =>
        item === '--' ||
        /^--(?:build_metadata|build_event_json_file|output|output_groups|starlark:file|starlark:expr|experimental_aquery_dump_after_build_format|experimental_aquery_dump_after_build_output_file)(?:=|$)/u.test(
          item,
        ),
    )
  )
    throw new Error('configuration cannot override qualification metadata or query output');
  const targets = argv(request.targets, 'additional targets').map(label);
  const completeProducts = argv(request.completeProducts ?? [], 'complete products');
  if (new Set(completeProducts).size !== completeProducts.length)
    throw new Error('complete products must be unique');
  const metadata = Object.entries(nativeBuildMetadata(source, request.github)).map(
    ([key, value]) => `--build_metadata=${key}=${value}`,
  );
  const output = requireSafeDirectoryChain(path.resolve(workspace, request.outputDirectory), {
    create: true,
    label: 'shipping qualification',
  });
  const file = (name: string) => path.join(output, name);
  writeFileSync(file('github.json'), `${JSON.stringify(request.github)}\n`, { flag: 'wx' });
  writeFileSync(file('configuration.json'), `${JSON.stringify(configuration)}\n`, { flag: 'wx' });
  writeFileSync(file('startup.json'), `${JSON.stringify(startup)}\n`, { flag: 'wx' });
  const run = (command: string, args: string[], stdout?: string) => {
    const fd = stdout === undefined ? undefined : openSync(stdout, 'wx');
    try {
      const result = spawnSync(command, args, {
        cwd: workspace,
        stdio: ['ignore', fd ?? 'inherit', 'inherit'],
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `shipping qualification ${command} ${args[0] ?? ''} failed (${result.signal ?? result.status})`,
        );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const bazel = (args: string[], stdout?: string) =>
    run('bash', ['tools/dev/bazel.sh', ...startup, ...args], stdout);
  let roots: string[];
  if ('export' in request.shipping) {
    const owner = label(request.shipping.export);
    bazel(
      [
        'cquery',
        `kind("shipping_package", deps(${owner}, 1))`,
        ...configuration,
        '--output=starlark',
        '--starlark:expr=str(target.label)',
      ],
      file('selected-roots.txt'),
    );
    roots = readFileSync(file('selected-roots.txt'), 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(label);
  } else roots = argv(request.shipping.roots, 'shipping roots').map(label);
  if (!roots.length || new Set(roots).size !== roots.length)
    throw new Error('shipping qualification requires nonempty unique shipping roots');
  roots.sort();
  writeFileSync(file('selected-roots.json'), `${JSON.stringify(roots)}\n`, { flag: 'wx' });
  assertSource();
  bazel([
    'test',
    ...new Set([...roots, ...targets]),
    ...configuration,
    ...metadata,
    `--build_event_json_file=${file('build-events.jsonl')}`,
    '--output_groups=+shipping_manifest',
    '--experimental_aquery_dump_after_build_format=jsonproto',
    `--experimental_aquery_dump_after_build_output_file=${file('aquery.json')}`,
  ]);
  assertSource();
  bazel(['info', ...configuration, 'execution_root'], file('execution-root.txt'));
  const executionRoot = readFileSync(file('execution-root.txt'), 'utf8').trim();
  if (!path.isAbsolute(executionRoot) || /[\u0000-\u001f\u007f]/u.test(executionRoot))
    throw new Error('shipping qualification requires one absolute execution root');
  assertSource();
  run('bash', [
    'tools/release/with-source.sh',
    'HEAD',
    'bash',
    'tools/dev/bun.sh',
    'tools/release/capture-native-build-evidence.mts',
    '--github-json',
    file('github.json'),
    '--producer-cohort',
    file('selected-roots.json'),
    file('aquery.json'),
    file('build-events.jsonl'),
    executionRoot,
    '--output-directory',
    file('evidence'),
    '--source-ref',
    'HEAD',
  ]);
  const evidence = file('evidence/native-build-evidence.json');
  try {
    assertSource();
    if (completeProducts.length) {
      checkCompleteProducts(json(evidence) as NativeBuildEvidence, completeProducts);
      assertSource();
    }
  } catch (error) {
    // The collector completed, so this file belongs to this invocation. Keep
    // raw diagnostics, but remove a packet captured across a source change.
    rmSync(path.dirname(evidence), { recursive: true, force: true });
    throw error;
  }
  return evidence;
}

function main() {
  const { values } = parseArgs({
    options: {
      'github-json': { type: 'string' },
      'configuration-json': { type: 'string' },
      'startup-json': { type: 'string' },
      'shipping-export': { type: 'string' },
      'shipping-roots-json': { type: 'string' },
      'targets-json': { type: 'string' },
      'complete-products-json': { type: 'string' },
      'output-directory': { type: 'string' },
    },
    strict: true,
  });
  if (
    !values['github-json'] ||
    !values['configuration-json'] ||
    !values['targets-json'] ||
    !values['output-directory'] ||
    Boolean(values['shipping-export']) === Boolean(values['shipping-roots-json'])
  )
    throw new Error(
      'usage: qualify-native-shipping.mts --github-json FILE --configuration-json FILE [--startup-json FILE] (--shipping-export LABEL | --shipping-roots-json FILE) --targets-json FILE [--complete-products-json FILE] --output-directory DIR',
    );
  let shipping: NativeShippingRequest['shipping'];
  if (values['shipping-export']) shipping = { export: values['shipping-export'] };
  else {
    const rootsFile = values['shipping-roots-json'];
    if (!rootsFile) throw new Error('shipping roots are missing');
    shipping = { roots: argv(json(rootsFile), 'shipping roots') };
  }
  console.log(
    qualifyNativeShipping({
      github: json(values['github-json']) as NativeBuildGithub,
      startup: values['startup-json'] ? argv(json(values['startup-json']), 'startup') : [],
      configuration: argv(json(values['configuration-json']), 'configuration'),
      shipping,
      targets: argv(json(values['targets-json']), 'additional targets'),
      completeProducts: values['complete-products-json']
        ? argv(json(values['complete-products-json']), 'complete products')
        : [],
      outputDirectory: values['output-directory'],
    }),
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
