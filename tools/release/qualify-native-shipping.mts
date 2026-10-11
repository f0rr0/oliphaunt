#!/usr/bin/env bun
/** Build shipping roots once and retain configured construction evidence. */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import { canonicalShippingLabel } from './bazel-shipping-inputs.mts';
import { type NativeBuildGithub, nativeBuildMetadata } from './native-build-qualification.mts';

export type NativeShippingRequest = {
  github: NativeBuildGithub;
  startup?: string[];
  configuration: string[];
  shipping: { export: string } | { roots: string[] };
  targets: string[];
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
    if (git('status', '--porcelain', '--untracked-files=all'))
      throw new Error('shipping qualification requires a clean checkout');
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
        /^--(?:build_metadata|build_event_json_file|output|starlark:file|starlark:expr|proto:include_configurations)(?:=|$)/u.test(
          item,
        ),
    )
  )
    throw new Error('configuration cannot override qualification metadata or query output');
  const targets = argv(request.targets, 'additional targets').map(label);
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
  ]);
  assertSource();
  const expression = `set(${roots.join(' ')})`;
  bazel(
    [
      'cquery',
      expression,
      ...configuration,
      '--output=starlark',
      '--starlark:file=tools/bazel/shipping.cquery.bzl',
    ],
    file('roots.jsonl'),
  );
  bazel(
    [
      'cquery',
      expression,
      ...configuration,
      '--output=jsonproto',
      '--proto:include_configurations',
    ],
    file('cquery.json'),
  );
  bazel(
    [
      'aquery',
      `deps(${expression})`,
      ...configuration,
      '--include_artifacts',
      '--include_commandline',
      '--output=jsonproto',
    ],
    file('aquery.json'),
  );
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
    '--cohort',
    file('roots.jsonl'),
    file('cquery.json'),
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
  } catch (error) {
    // The collector completed, so this file belongs to this invocation. Keep
    // raw diagnostics, but remove a packet captured across a source change.
    rmSync(evidence);
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
      'usage: qualify-native-shipping.mts --github-json FILE --configuration-json FILE [--startup-json FILE] (--shipping-export LABEL | --shipping-roots-json FILE) --targets-json FILE --output-directory DIR',
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
