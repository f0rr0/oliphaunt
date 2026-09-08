#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import releaseBot from '../../tools/release/release-bot.json' with { type: 'json' };

const TOOL = 'normalize-release-please-pr.sh';
const CANONICAL_REPOSITORY = 'f0rr0/oliphaunt';
const MAIN_BRANCH = 'main';
const RELEASE_BRANCH = 'release-please--branches--main';
const FULL_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!new Set(['normalize', 'push']).has(command)) {
    fail(
      'usage: normalize-release-please-pr.sh <normalize|push> --pr-number N --observed-pr-number N --base main --head release-please--branches--main --head-sha SHA --head-repository f0rr0/oliphaunt --cross-repository false --state OPEN --title TITLE --main-sha SHA [--remote origin]',
    );
  }
  const values = { command, remote: 'origin' };
  const known = new Set([
    '--pr-number',
    '--observed-pr-number',
    '--base',
    '--head',
    '--head-sha',
    '--head-repository',
    '--cross-repository',
    '--state',
    '--title',
    '--main-sha',
    '--remote',
  ]);
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!known.has(flag) || value === undefined)
      fail(`unknown or incomplete argument ${flag ?? '<missing>'}`);
    const key = flag.slice(2).replaceAll(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (Object.hasOwn(values, key) && key !== 'remote')
      fail(`${flag} must be supplied exactly once`);
    values[key] = value;
  }
  for (const key of [
    'prNumber',
    'observedPrNumber',
    'base',
    'head',
    'headSha',
    'headRepository',
    'crossRepository',
    'state',
    'title',
    'mainSha',
  ]) {
    if (typeof values[key] !== 'string' || values[key].length === 0)
      fail(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return values;
}

function expectedTitle(repo, base) {
  let config;
  try {
    config = JSON.parse(readFileSync(`${repo}/release-please-config.json`, 'utf8'));
  } catch (cause) {
    fail(`release-please-config.json is unreadable: ${cause.message}`);
  }
  const pattern = config?.['group-pull-request-title-pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) {
    fail('release-please-config.json must define group-pull-request-title-pattern');
  }
  const title = pattern.replaceAll('${branch}', base);
  if (title.includes('${') || !/^chore\(release\): .+/u.test(title) || /[\r\n]/u.test(title)) {
    fail(
      'group-pull-request-title-pattern must render one conventional release title using only ${branch}',
    );
  }
  return title;
}

function validateIdentity(args, repo) {
  if (!POSITIVE_INTEGER.test(args.prNumber) || !POSITIVE_INTEGER.test(args.observedPrNumber)) {
    fail('release PR numbers must be positive integers');
  }
  if (args.prNumber !== args.observedPrNumber) {
    fail(
      `release PR identity changed: requested #${args.prNumber}, observed #${args.observedPrNumber}`,
    );
  }
  if (args.base !== MAIN_BRANCH) fail(`release PR base must be ${MAIN_BRANCH}, got ${args.base}`);
  if (args.head !== RELEASE_BRANCH)
    fail(`release PR head must be ${RELEASE_BRANCH}, got ${args.head}`);
  if (args.headRepository !== CANONICAL_REPOSITORY) {
    fail(`release PR head repository must be ${CANONICAL_REPOSITORY}, got ${args.headRepository}`);
  }
  if (args.crossRepository !== 'false') fail('release PR must not be cross-repository');
  if (args.state !== 'OPEN') fail(`release PR must be OPEN, got ${args.state}`);
  if (!FULL_SHA.test(args.headSha) || !FULL_SHA.test(args.mainSha)) {
    fail('release PR head and main identities must be lowercase full commit SHAs');
  }
  if (!SAFE_REMOTE.test(args.remote)) fail(`unsafe Git remote name ${JSON.stringify(args.remote)}`);
  const title = expectedTitle(repo, args.base);
  if (args.title !== title)
    fail(`release PR title must be ${JSON.stringify(title)}, got ${JSON.stringify(args.title)}`);
  return title;
}

const args = parseArgs(process.argv.slice(2));
validateIdentity(args, process.cwd());
for (const key of ['command', 'remote', 'mainSha', 'headSha', 'prNumber', 'title']) {
  if (args[key].includes('\0')) fail('release PR identity must not contain NUL');
  process.stdout.write(args[key] + '\0');
}

for (const value of [releaseBot.name, releaseBot.email]) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/u.test(value))
    fail('invalid release bot identity');
  process.stdout.write(value + '\0');
}
