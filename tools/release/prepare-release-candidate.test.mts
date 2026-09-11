import { test, expect } from 'bun:test';
import { Manifest } from 'release-please';
import { Version } from 'release-please/build/src/version.js';
import { loadGraph } from './release-graph.mts';
import {
  includeOwnedSourceCommits,
  useSourceDate,
  applyCandidate,
} from './prepare-release-candidate.mts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const graph = loadGraph('prepare-release-candidate.test');
const native = 'runtimes/liboliphaunt-native';
const wasix = 'runtimes/liboliphaunt-wasix';
const shared = 'extensions/contrib/postgres18.toml';
const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
const head = 'c'.repeat(40);

async function generate(commits, baselines = { [native]: first, [wasix]: first }) {
  useSourceDate('2026-09-11');
  const config = Object.fromEntries(
    [native, wasix].map((owner) => [
      owner,
      {
        releaseType: 'simple',
        component: owner.split('/').at(-1),
        packageName: owner.split('/').at(-1),
        versionFile: 'VERSION',
        changelogPath: 'CHANGELOG.md',
        includeVInTag: true,
        tagSeparator: '-',
        bumpMinorPreMajor: true,
        bumpPatchForMinorPreMajor: true,
      },
    ]),
  );
  const github = {
    repository: { owner: 'f0rr0', repo: 'oliphaunt', defaultBranch: 'main' },
    async *releaseIterator() {
      for (const owner of [native, wasix])
        yield {
          tagName: `${config[owner].component}-v0.2.0`,
          sha: baselines[owner],
          notes: 'Previous release',
        };
    },
    async *mergeCommitIterator() {
      yield* commits;
    },
    async getFileContentsOnBranch(file) {
      const parsedContent = file.endsWith('/VERSION')
        ? '0.2.0\n'
        : '# Changelog\n\n## 0.2.0\n\nPrevious release\n';
      return { parsedContent, content: Buffer.from(parsedContent).toString('base64') };
    },
    async getFileContents(file) {
      return this.getFileContentsOnBranch(file);
    },
  };
  const manifest = new Manifest(
    github,
    'main',
    config,
    {
      [native]: Version.parse('0.2.0'),
      [wasix]: Version.parse('0.2.0'),
    },
    {
      separatePullRequests: false,
      groupPullRequestTitlePattern: 'chore(release): prepare ${branch} releases',
    },
  );
  includeOwnedSourceCommits(manifest, github, graph);
  return manifest.buildPullRequests();
}

test('Release Please alone versions and describes shared shipped changes exactly once', async () => {
  const commits = [
    {
      sha: head,
      message: 'feat: improve shared extension behavior',
      files: [shared, `${native}/src/liboliphaunt.c`],
    },
    {
      sha: first,
      message: 'chore(release): previous releases',
      files: [`${native}/VERSION`, `${wasix}/VERSION`],
    },
  ];
  const [candidate] = await generate(commits);
  expect(candidate.headRefName).toBe('release-please--branches--main');
  expect(candidate.title.toString()).toBe('chore(release): prepare main releases');
  const versions = candidate.updates.filter((update) => update.path.endsWith('/VERSION'));
  expect(
    versions.map((update) => [update.path, update.updater.updateContent('0.2.0\n').trim()]).sort(),
  ).toEqual([
    [`${native}/VERSION`, '0.2.1'],
    [`${wasix}/VERSION`, '0.2.1'],
  ]);
  for (const update of candidate.updates.filter((update) =>
    update.path.endsWith('/CHANGELOG.md'),
  )) {
    const text = update.updater.updateContent('# Changelog\n');
    expect(text.match(/improve shared extension behavior/gu)).toHaveLength(1);
    expect(text).toContain('2026-09-11');
  }
  const [repeat] = await generate(commits);
  expect(repeat.body.toString()).toBe(candidate.body.toString());
  const render = (update) => [
    update.path,
    update.updater.updateContent(
      update.path === '.release-please-manifest.json'
        ? JSON.stringify({ [native]: '0.2.0', [wasix]: '0.2.0' })
        : update.path.endsWith('/VERSION')
          ? '0.2.0\n'
          : '# Changelog\n',
    ),
  ];
  expect(repeat.updates.map(render)).toEqual(candidate.updates.map(render));
});

test('shared source qualification respects each owner release boundary and ignores nonrelease prose', async () => {
  const candidates = await generate(
    [
      { sha: head, message: 'docs: clarify maintenance instructions', files: [shared] },
      {
        sha: second,
        message: 'chore(release): WASIX already includes this change',
        files: [`${wasix}/VERSION`],
      },
      { sha: 'd'.repeat(40), message: 'fix: repair shared extension behavior', files: [shared] },
      { sha: first, message: 'chore(release): native baseline', files: [`${native}/VERSION`] },
    ],
    { [native]: first, [wasix]: second },
  );
  expect(candidates).toHaveLength(1);
  expect(
    candidates[0].updates
      .filter((update) => update.path.endsWith('/VERSION'))
      .map((update) => update.path),
  ).toEqual([`${native}/VERSION`]);
});

test('actual Rust, npm, Swift and Gradle strategy updates apply to one local candidate', async () => {
  const root = path.resolve(import.meta.dir, '../..');
  const selected = ['sdks/rust/sdk', 'sdks/ts/sdk', 'sdks/swift', 'sdks/kotlin'];
  const config = JSON.parse(readFileSync(path.join(root, 'release-please-config.json'), 'utf8'));
  const versions = JSON.parse(
    readFileSync(path.join(root, '.release-please-manifest.json'), 'utf8'),
  );
  config.packages = Object.fromEntries(selected.map((owner) => [owner, config.packages[owner]]));
  const current = Object.fromEntries(selected.map((owner) => [owner, versions[owner]]));
  const github = {
    repository: { owner: 'f0rr0', repo: 'oliphaunt', defaultBranch: 'main' },
    async *releaseIterator() {
      for (const owner of selected)
        yield {
          tagName: `${config.packages[owner].component}-v${versions[owner]}`,
          sha: first,
          notes: 'Existing release',
        };
    },
    async *mergeCommitIterator() {
      yield {
        sha: head,
        message: 'fix: correct the selected SDK behavior',
        files: selected.map((owner) => `${owner}/src/implementation`),
      };
      yield { sha: first, message: 'chore(release): previous versions', files: [] };
    },
    async getFileContentsOnBranch(file) {
      const local = path.join(root, file);
      const parsedContent =
        file === 'release-please-config.json'
          ? JSON.stringify(config)
          : file === '.release-please-manifest.json'
            ? JSON.stringify(current)
            : existsSync(local)
              ? readFileSync(local, 'utf8')
              : undefined;
      if (parsedContent === undefined)
        throw Object.assign(new Error(`missing ${file}`), { status: 404 });
      return { parsedContent, content: Buffer.from(parsedContent).toString('base64') };
    },
    async getFileContents(file) {
      return this.getFileContentsOnBranch(file);
    },
    async getFileJson(file) {
      return JSON.parse((await this.getFileContentsOnBranch(file)).parsedContent);
    },
  };
  const manifest = await Manifest.fromManifest(github, 'main');
  useSourceDate('2026-09-11');
  includeOwnedSourceCommits(manifest, github, graph);
  const [candidate] = await manifest.buildPullRequests();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'release-please-ecosystems-'));
  try {
    for (const update of candidate.updates) {
      const input = path.join(root, update.path);
      if (existsSync(input)) {
        const destination = path.join(scratch, update.path);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(input));
      }
    }
    applyCandidate(scratch, candidate);
    const after = JSON.parse(
      readFileSync(path.join(scratch, '.release-please-manifest.json'), 'utf8'),
    );
    const read = (file) => readFileSync(path.join(scratch, file), 'utf8');
    expect(Bun.TOML.parse(read('sdks/rust/sdk/Cargo.toml')).package.version).toBe(
      after['sdks/rust/sdk'],
    );
    expect(
      Bun.TOML.parse(read('sdks/rust/sdk/crates/oliphaunt-build/Cargo.toml')).package.version,
    ).toBe(after['sdks/rust/sdk']);
    expect(JSON.parse(read('sdks/ts/sdk/package.json')).version).toBe(after['sdks/ts/sdk']);
    expect(read('sdks/swift/VERSION').trim()).toBe(after['sdks/swift']);
    expect(read('sdks/kotlin/VERSION').trim()).toBe(after['sdks/kotlin']);
    expect(read('sdks/kotlin/gradle.properties')).toContain(`VERSION_NAME=${after['sdks/kotlin']}`);
    expect(existsSync(path.join(scratch, 'sdks/rust/sdk/Cargo.lock'))).toBe(false);
    for (const owner of selected) expect(after[owner]).not.toBe(versions[owner]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
