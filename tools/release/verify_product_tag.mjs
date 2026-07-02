#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseToolingLagFailureDetail, releaseToolingLagStatus } from './release-graph.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const decoder = new TextDecoder();

function fail(message) {
  console.error(`verify_product_tag.mjs: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let product = null;
  let target = process.env.GITHUB_SHA || 'HEAD';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      target = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      fail(`unknown argument: ${arg}`);
    }
    if (product !== null) {
      fail('usage: tools/release/verify_product_tag.mjs <product> [--target <commitish>]');
    }
    product = arg;
  }
  if (!product || !target) {
    fail('usage: tools/release/verify_product_tag.mjs <product> [--target <commitish>]');
  }
  return { product, target };
}

function git(args, { check = true } = {}) {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (check && result.exitCode !== 0) {
    const stderr = decoder.decode(result.stderr).trim();
    fail(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
}

function commitForRef(ref) {
  return git(['rev-parse', `${ref}^{commit}`]).stdout;
}

function tagCommit(tag) {
  const result = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], {
    check: false,
  });
  return result.exitCode === 0 ? result.stdout : null;
}

function refreshTagFromOrigin(tag) {
  const remote = git(['remote', 'get-url', 'origin'], { check: false });
  if (remote.exitCode !== 0) {
    return;
  }
  const result = git(['fetch', '--force', '--no-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], {
    check: false,
  });
  if (result.exitCode !== 0 && tagCommit(tag) === null) {
    fail(`${tag} does not exist on origin. Run release-please before release publish steps.`);
  }
  if (result.exitCode !== 0) {
    fail(`could not refresh ${tag} from origin before verification${result.stderr ? `: ${result.stderr}` : ''}`);
  }
}

async function releasePleaseProduct(product) {
  const config = JSON.parse(await fs.readFile(path.join(root, 'release-please-config.json'), 'utf8'));
  if (config['include-v-in-tag'] !== true) {
    fail('release-please must include v in product tags');
  }
  if (config['tag-separator'] !== '-') {
    fail("release-please tag-separator must be '-'");
  }
  const packages = config.packages;
  if (typeof packages !== 'object' || packages === null) {
    fail('release-please-config.json must define packages');
  }
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    if (packageConfig?.component === product) {
      return { packagePath, packageConfig };
    }
  }
  fail(`unknown release product '${product}'`);
}

function parseCargoVersion(text) {
  let inPackage = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '[package]') {
      inPackage = true;
      continue;
    }
    if (inPackage && line.startsWith('[')) {
      break;
    }
    if (!inPackage) {
      continue;
    }
    const match = line.match(/^version\s*=\s*"([^"]+)"/u);
    if (match) {
      return match[1];
    }
  }
  return '';
}

async function currentProductVersion(product) {
  const { packagePath, packageConfig } = await releasePleaseProduct(product);
  const releaseType = packageConfig['release-type'];
  const versionFile =
    typeof packageConfig['version-file'] === 'string'
      ? packageConfig['version-file']
      : releaseType === 'rust'
        ? 'Cargo.toml'
        : releaseType === 'node' || releaseType === 'expo'
          ? 'package.json'
          : null;
  if (!versionFile) {
    fail(`${product} release-please config must declare version-file for release type '${releaseType}'`);
  }
  if (path.isAbsolute(versionFile) || versionFile.split(/[\\/]/u).includes('..')) {
    fail(`${product}.version-file must stay inside release package path`);
  }
  const versionPath = path.join(root, packagePath, versionFile);
  const text = await fs.readFile(versionPath, 'utf8');
  const fileName = path.basename(versionFile);
  let version = '';
  if (fileName === 'Cargo.toml') {
    version = parseCargoVersion(text);
  } else if (fileName === 'package.json') {
    version = JSON.parse(text).version ?? '';
  } else if (fileName === 'VERSION' || fileName === 'LIBOLIPHAUNT_VERSION') {
    version = text.trim();
  } else {
    fail(`${product}.version-file has unsupported version file type: ${versionFile}`);
  }
  if (typeof version !== 'string' || version.length === 0) {
    fail(`${path.relative(root, versionPath)} does not define a release version for ${product}`);
  }
  return version;
}

const { product, target } = parseArgs(Bun.argv.slice(2));
const version = await currentProductVersion(product);
const tag = `${product}-v${version}`;
const targetCommit = commitForRef(target);
refreshTagFromOrigin(tag);
const existing = tagCommit(tag);
if (existing === null) {
  fail(`${tag} does not exist. Run release-please before release publish steps.`);
}
if (existing !== targetCommit) {
  const lag = releaseToolingLagStatus(existing, targetCommit, 'verify_product_tag.mjs');
  if (!lag.allowed) {
    fail(`${tag} points at ${existing}, not release commit ${targetCommit}.${releaseToolingLagFailureDetail(lag)}`);
  }
  console.log(`${tag} points at ${existing}; accepting ${targetCommit} because intervening changes are release tooling only`);
} else {
  console.log(`${tag} points at ${targetCommit}`);
}
