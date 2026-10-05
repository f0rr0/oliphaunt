import { test, expect } from 'bun:test';
import { Manifest } from 'release-please';
import { Version } from 'release-please/build/src/version.js';
import { buildPlan, declaredSharedSourceImpacts, loadGraph, ROOT } from './release-graph.mts';
import {
  includeOwnedSourceCommits,
  useSourceDate,
  applyCandidate,
} from './prepare-release-candidate.mts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const graph = loadGraph('prepare-release-candidate.test');
const native = 'src/native/runtime';
const wasix = 'src/wasix/runtime';
const shared = 'src/extensions/contrib/postgres18.toml';
const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
const head = 'c'.repeat(40);

test('every binary release includes its compiled sources across product boundaries', () => {
  const mobile = ['oliphaunt-swift', 'oliphaunt-kotlin'];
  for (const [file, products] of [
    ['src/wasix/sdks/rust/src/oliphaunt/base.rs', ['oliphaunt-wasix-rust', 'oliphaunt-wasix-napi']],
    ['src/wasix/pgwire-server/src/lib.rs', ['oliphaunt-pgwire-server', 'oliphaunt-wasix-napi']],
    [
      'src/query/rust/src/lib.rs',
      ['oliphaunt-query', 'oliphaunt-broker', 'oliphaunt-wasix-napi', ...mobile],
    ],
    ['src/wasix/runtime/crates/assets/src/lib.rs', ['liboliphaunt-wasix', 'oliphaunt-wasix-napi']],
    ['src/wasix/runtime/toolchain.toml', ['liboliphaunt-wasix', 'oliphaunt-wasix-napi']],
    [
      'src/wasix/postgres-tools/crates/tools/build-support.rs',
      ['postgres-tools-wasix', 'oliphaunt-wasix-napi'],
    ],
    ['src/database-resources/icu/cargo/src/lib.rs', ['database-resources', 'oliphaunt-wasix-napi']],
    [
      'src/native/rust-bindings/src/lib.rs',
      ['liboliphaunt-native-bindings', 'oliphaunt-broker', 'oliphaunt-node-direct', ...mobile],
    ],
    ['src/native/broker/src/lib.rs', ['oliphaunt-broker', ...mobile]],
    ['src/native/sdks/rust/src/lib.rs', ['oliphaunt-rust', ...mobile]],
    ['src/native/mobile-bindings/src/lib.rs', mobile],
    ['src/native/sdks/rust/crates/oliphaunt-build/src/lib.rs', ['oliphaunt-rust', ...mobile]],
  ]) {
    const plan = buildPlan(graph, [file]);
    expect(plan.releaseProducts.sort()).toEqual(products.sort());
  }
  for (const file of [
    'src/wasix/sdks/rust/tests/runtime_smoke.rs',
    'src/wasix/sdks/rust/README.md',
  ]) {
    expect(buildPlan(graph, [file]).releaseProducts).not.toContain('oliphaunt-wasix-napi');
  }
  for (const file of [
    'src/native/sdks/rust/tests/mobile_broker.rs',
    'src/native/broker/README.md',
  ]) {
    for (const product of mobile)
      expect(buildPlan(graph, [file]).releaseProducts).not.toContain(product);
  }
  // A dynamically loaded native runtime does not become part of the adapter binary.
  expect(buildPlan(graph, ['src/native/runtime/VERSION']).releaseProducts).toEqual([
    'liboliphaunt-native',
  ]);
  for (const file of ['Cargo.toml', 'Cargo.lock']) {
    expect(buildPlan(graph, [file]).releaseProducts.sort()).toEqual([
      'oliphaunt-broker',
      'oliphaunt-kotlin',
      'oliphaunt-node-direct',
      'oliphaunt-swift',
      'oliphaunt-wasix-napi',
    ]);
  }
});

test('new transitive, build and target Cargo dependencies automatically select embedding releases', () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const scratch = mkdtempSync(path.join(ROOT, 'target/embedded-cargo-'));
  const relative = path.relative(ROOT, scratch).split(path.sep).join('/');
  try {
    for (const name of ['binary', 'middle', 'leaf', 'build', 'target', 'test-only']) {
      mkdirSync(path.join(scratch, name, 'src'), { recursive: true });
      writeFileSync(path.join(scratch, name, 'src/lib.rs'), 'pub fn fixture() {}\n');
      writeFileSync(
        path.join(scratch, name, 'Cargo.toml'),
        `[package]\nname = "${name}"\nversion = "1.0.0"\n`,
      );
    }
    writeFileSync(
      path.join(scratch, 'binary/Cargo.toml'),
      '[dependencies]\nmiddle = { path = "../middle" }\n' +
        '[build-dependencies]\nbuild = { path = "../build" }\n' +
        '[target.\'cfg(unix)\'.dependencies]\ntarget = { path = "../target", optional = true }\n' +
        '[dev-dependencies]\ntest = { path = "../test-only" }\n',
    );
    writeFileSync(
      path.join(scratch, 'middle/Cargo.toml'),
      '[dependencies]\nleaf = { path = "../leaf" }\n',
    );
    const impacts = declaredSharedSourceImpacts({
      'oliphaunt-node-direct': {
        embedded_cargo_manifests: [`${relative}/binary/Cargo.toml`],
      },
    });
    const fixtureGraph = { ...graph, shared_release_sources: impacts };
    for (const name of ['middle', 'leaf', 'build', 'target']) {
      expect(buildPlan(fixtureGraph, [`${relative}/${name}/src/lib.rs`]).releaseProducts).toEqual([
        'oliphaunt-node-direct',
      ]);
    }
    expect(buildPlan(fixtureGraph, [`${relative}/test-only/src/lib.rs`]).releaseProducts).toEqual(
      [],
    );
    expect(buildPlan(fixtureGraph, [`${relative}/leaf/README.md`]).releaseProducts).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('embedded generated payloads follow private producer ownership for source-pin changes', () => {
  for (const file of ['src/third-party/postgres/source.toml', 'src/third-party/icu/source.toml']) {
    expect(existsSync(path.join(ROOT, file))).toBe(true);
    const plan = buildPlan(graph, [file]);
    expect(plan.releaseProducts).toContain('liboliphaunt-wasix');
    expect(plan.releaseProducts).toContain('oliphaunt-wasix-napi');
  }
});

async function generate(commits, baselines = { [native]: first, [wasix]: first }) {
  useSourceDate('2026-09-11');
  const config = Object.fromEntries(
    [native, wasix].map((owner) => [
      owner,
      {
        releaseType: 'simple',
        component: owner === native ? 'liboliphaunt-native' : 'liboliphaunt-wasix',
        packageName: owner === native ? 'liboliphaunt-native' : 'liboliphaunt-wasix',
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
  const selected = [
    'src/native/sdks/rust',
    'src/native/sdks/ts',
    'src/native/sdks/swift',
    'src/native/sdks/kotlin',
  ];
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
    expect(Bun.TOML.parse(read('src/native/sdks/rust/Cargo.toml')).package.version).toBe(
      after['src/native/sdks/rust'],
    );
    expect(
      Bun.TOML.parse(read('src/native/sdks/rust/crates/oliphaunt-build/Cargo.toml')).package
        .version,
    ).toBe(after['src/native/sdks/rust']);
    expect(JSON.parse(read('src/native/sdks/ts/package.json')).version).toBe(
      after['src/native/sdks/ts'],
    );
    expect(read('src/native/sdks/swift/VERSION').trim()).toBe(after['src/native/sdks/swift']);
    expect(read('src/native/sdks/kotlin/VERSION').trim()).toBe(after['src/native/sdks/kotlin']);
    expect(read('src/native/sdks/kotlin/gradle.properties')).toContain(
      `VERSION_NAME=${after['src/native/sdks/kotlin']}`,
    );
    expect(existsSync(path.join(scratch, 'src/native/sdks/rust/Cargo.lock'))).toBe(false);
    for (const owner of selected) expect(after[owner]).not.toBe(versions[owner]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
