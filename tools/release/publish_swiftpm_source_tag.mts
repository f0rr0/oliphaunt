import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readSelectedRemoteTagMap } from '../../.github/scripts/manage-release-drafts.mts';
import { currentVersion } from './product-version.mts';
import { reserveGitHubContentWrite } from './github-content-write-pacer.mts';
import { createGitHubOperationBudget } from './github-release-mutations.mts';
import { loadPublicationLock, lockedProductArtifactPaths } from './publication-lock.mts';
import { extractPortableArchiveTree } from '../packaging/portable-archive.mts';

const SEMVER = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA = /^[0-9a-f]{40}$/u;
export const SWIFTPM_PUSH_ATTEMPT_TIMEOUT_MS = 60_000;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function prepare(scratch, argv) {
  const args = {
    target: process.env.GITHUB_SHA || 'HEAD',
    includeTrees: [],
    preflight: false,
    push: false,
    product: 'oliphaunt-swift',
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      console.log(
        'usage: publish-swiftpm-source-tag.sh [--target REF] [--publication-lock FILE | --manifest FILE --include-tree TREE...] [--preflight | --push]',
      );
      return;
    }
    if (flag === '--preflight' || flag === '--push') {
      args[flag.slice(2)] = true;
      continue;
    }
    const key = {
      '--target': 'target',
      '--release-commit': 'target',
      '--publication-lock': 'lock',
      '--manifest': 'manifest',
      '--include-tree': 'includeTrees',
      '--product': 'product',
      '--repository': 'repository',
      '--source-archive': 'sourceArchive',
    }[flag];
    const value = argv[++index];
    if (!key || !value || value.startsWith('--'))
      throw new Error('unknown or incomplete SwiftPM argument: ' + flag);
    if (key === 'includeTrees') args.includeTrees.push(value);
    else {
      if (seen.has(key)) throw new Error('duplicate SwiftPM argument: ' + flag);
      seen.add(key);
      args[key] = value;
    }
  }
  if (args.preflight && args.push) throw new Error('--preflight and --push are mutually exclusive');
  if (!['oliphaunt-swift', 'database-resources'].includes(args.product))
    throw new Error('unsupported SwiftPM product');
  if (args.repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(args.repository))
    throw new Error('SwiftPM repository must be an owner/name');
  const resource = args.product === 'database-resources';
  if (
    resource &&
    (!args.repository || args.repository === (process.env.GITHUB_REPOSITORY ?? 'f0rr0/oliphaunt'))
  )
    throw new Error('SwiftPM resources require a distinct distribution repository identity');
  args.remote = args.repository ? `https://github.com/${args.repository}.git` : 'origin';
  args.projectSourceOnly = resource;
  const version = await currentVersion(args.product);
  const core = SEMVER.exec(version);
  if (!core || (!resource && Number(core[1]) === 0 && Number(core[2]) < 6))
    throw new Error(
      'SwiftPM requires a semantic version at least 0.6.0; older unscoped tags belong to legacy releases',
    );
  if (args.lock) {
    if (args.manifest || args.includeTrees.length || args.sourceArchive)
      throw new Error('locked SwiftPM inputs cannot be overridden');
    const lock = loadPublicationLock(path.resolve(args.lock));
    if (lock.products.find((row) => row.id === args.product)?.version !== version)
      throw new Error('SwiftPM version differs from the frozen lock');
    args.source = lock.source;
    const inputs = lockedProductArtifactPaths(lock, args.product);
    if (resource) {
      const archives = inputs.filter(
        ({ artifact, type }) => artifact.kind === 'swift-source' && type === 'file',
      );
      if (archives.length !== 1)
        throw new Error('resource publication lock must contain exactly one Swift source archive');
      args.sourceArchive = archives[0].path;
    } else {
      const manifests = inputs.filter(
        ({ artifact, type }) => artifact.kind === 'swiftpm-release-manifest' && type === 'file',
      );
      const trees = inputs.filter(
        ({ artifact, type }) => artifact.kind === 'swiftpm-release-tree' && type === 'directory',
      );
      if (manifests.length !== 1 || trees.length !== 1)
        throw new Error(
          'publication lock must contain exactly one SwiftPM release manifest and tree',
        );
      args.manifest = manifests[0].path;
      args.includeTrees = [trees[0].path];
    }
  }
  if (resource) {
    if (!args.sourceArchive || args.manifest || args.includeTrees.length)
      throw new Error('resource SwiftPM publication requires one frozen source archive');
    const tree = path.join(scratch, 'resource-source');
    extractPortableArchiveTree(path.resolve(args.sourceArchive), tree);
    args.manifest = path.join(tree, 'Package.swift');
    args.includeTrees = [tree];
  } else if (args.sourceArchive)
    throw new Error('--source-archive is only for the resource product');
  const files = [];
  if (args.manifest) {
    const manifest = path.resolve(args.manifest);
    const text = readFileSync(manifest, 'utf8');
    if (!resource && (!text.includes('binaryTarget(') || !text.includes('liboliphaunt-native-v')))
      throw new Error(
        'SwiftPM release manifest must contain a checksum-pinned liboliphaunt binaryTarget',
      );
    files.push(manifest, 'Package.swift');
    for (const tree of args.includeTrees) {
      const root = path.resolve(tree);
      if (!lstatSync(root).isDirectory())
        throw new Error('SwiftPM generated release tree must be a directory');
      const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        )) {
          const file = path.join(directory, entry.name);
          const relative = path.relative(root, file).split(path.sep).join('/');
          if (resource && relative === 'Package.swift') continue;
          if (relative === 'Package.swift' || relative.split('/').includes('.git'))
            throw new Error('forbidden SwiftPM generated path: ' + relative);
          if (entry.isDirectory()) visit(file);
          else if (entry.isFile()) files.push(file, relative);
          else throw new Error('unsupported SwiftPM generated file type: ' + relative);
        }
      };
      visit(root);
    }
  } else if (args.includeTrees.length)
    throw new Error('--include-tree requires a release manifest');
  writeFileSync(path.join(scratch, 'files'), files.length ? files.join('\0') + '\0' : '');
  writeFileSync(path.join(scratch, 'context.json'), JSON.stringify({ ...args, version }));
}

export function inspectSwiftpmRemoteTag(text, tag, expected, { allowMissing = false } = {}) {
  if (!SEMVER.test(tag) || !SHA.test(expected))
    throw new Error('SwiftPM requires a semantic tag and full commit SHA');
  if (Buffer.byteLength(text) > 4 * 1024 * 1024)
    throw new Error('oversized SwiftPM remote tag response');
  if (text === '') {
    if (allowMissing) return 'absent';
    throw new Error('SwiftPM source tag is absent after the bounded push attempt');
  }
  if (text !== expected + '\trefs/tags/' + tag + '\n')
    throw new Error('SwiftPM remote tag is conflicting, malformed, or ambiguous');
  return 'exact';
}

async function main([phase, scratch, ...argv]) {
  if (phase === '--prepare') return await prepare(scratch, argv);
  if (phase === '--identity') {
    const text = readFileSync(path.join(scratch, 'identity'), 'utf8');
    const bot =
      text === ''
        ? { name: 'oliphaunt-release-bot', email: 'oliphaunt-release-bot@users.noreply.github.com' }
        : JSON.parse(text);
    if (
      !bot ||
      typeof bot.name !== 'string' ||
      !bot.name ||
      typeof bot.email !== 'string' ||
      !bot.email ||
      /[\r\n\0]/u.test(bot.name + bot.email)
    )
      throw new Error('invalid source-bound release bot identity');
    writeFileSync(path.join(scratch, 'identity.json'), JSON.stringify(bot));
    return;
  }
  const context = readJson(path.join(scratch, 'context.json'));
  if (phase === '--admit') {
    const budget = createGitHubOperationBudget({
      defaultWindowMs: 5 * 60_000,
      environment: process.env,
      now: Date.now,
    });
    if (context.source) {
      const tag = context.product + '-v' + context.version;
      const tags = await readSelectedRemoteTagMap(process.env.GITHUB_REPOSITORY, [{ tag }], {
        environment: process.env,
        budget,
      });
      const remote = tags.get(tag);
      if (remote?.type !== 'commit' || remote.sha !== context.source.commit)
        throw new Error('Swift product tag is not bound to the frozen source commit');
    }
    await reserveGitHubContentWrite({
      environment: process.env,
      label: 'SwiftPM source tag ' + context.version + ' push',
      now: budget.now,
    });
    if (budget.deadlineMs - budget.now() < 2 * (SWIFTPM_PUSH_ATTEMPT_TIMEOUT_MS + 5_000))
      throw new Error(
        'SwiftPM push requires two complete 60000ms transport intervals after pacing',
      );
    writeFileSync(path.join(scratch, 'deadline'), String(budget.deadlineMs));
  } else if (phase === '--reconcile-ready') {
    if (
      Number(readFileSync(path.join(scratch, 'deadline'), 'utf8')) - Date.now() <
      SWIFTPM_PUSH_ATTEMPT_TIMEOUT_MS + 5_000
    )
      throw new Error('SwiftPM push exhausted the deadline before exact remote reconciliation');
  } else if (phase === '--remote') {
    console.log(
      inspectSwiftpmRemoteTag(
        readFileSync(path.join(scratch, 'remote'), 'utf8'),
        context.version,
        argv[0],
        { allowMissing: context.preflight },
      ),
    );
  } else throw new Error('unknown SwiftPM data phase: ' + phase);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
