import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manifest } from 'release-please';
import { ManifestPlugin } from 'release-please/build/src/plugin.js';
import { mergeUpdates } from 'release-please/build/src/updaters/composite.js';
import { Version } from 'release-please/build/src/version.js';
import { frozenConsumerMatrix, frozenConsumerPlan } from './frozen-consumer.mts';
import {
  applyCandidate,
  includeOwnedSourceCommits,
  useSourceDate,
} from './prepare-release-candidate.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { releaseDependencyPlan } from './release-dependency-plan.mts';
import {
  buildPlan,
  compatibilityVersionEntries,
  compatibilityVersionFromText,
  compatibilityVersionValue,
  declaredSharedSourceImpacts,
  loadGraph,
  productCompatibilityVersion,
  ROOT,
} from './release-graph.mts';

const graph = loadGraph('prepare-release-candidate.test');
const native = 'src/native/runtime';
const wasix = 'src/wasix/runtime';
const shared = 'src/extensions/contrib/postgres18.toml';
const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
const head = 'c'.repeat(40);

test('extension facade generator changes select every product shipping its output', () => {
  const products = Object.entries(graph.products)
    .filter(([, product]) => product.extension?.class === 'external')
    .map(([id]) => id);
  expect(
    buildPlan(graph, [
      'src/extensions/artifacts/packages/tools/package-extension-cargo-facades.mts',
    ]).releaseProducts.sort(),
  ).toEqual(['liboliphaunt-native', ...products].sort());
});

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

test('Cargo owns transitive, inherited, renamed, build, target and custom source inputs', () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const scratch = mkdtempSync(path.join(ROOT, 'target/embedded-cargo-'));
  const relative = path.relative(ROOT, scratch).split(path.sep).join('/');
  const previousCargoHome = process.env.CARGO_HOME;
  try {
    const names = ['binary', 'middle', 'leaf', 'build', 'target', 'test-only'];
    writeFileSync(
      path.join(scratch, 'Cargo.toml'),
      `[workspace]\nmembers = ${JSON.stringify(names)}\nresolver = "3"\n` +
        '[workspace.dependencies]\nrenamed = { package = "leaf", path = "leaf" }\n',
    );
    for (const name of names) {
      mkdirSync(path.join(scratch, name, 'src'), { recursive: true });
      writeFileSync(path.join(scratch, name, 'src/lib.rs'), 'pub fn fixture() {}\n');
      writeFileSync(
        path.join(scratch, name, 'Cargo.toml'),
        `[package]\nname = "${name}"\nversion = "1.0.0"\n`,
      );
    }
    appendFileSync(
      path.join(scratch, 'binary/Cargo.toml'),
      '[dependencies]\nmiddle = { path = "../middle" }\n' +
        '[build-dependencies]\nbuild = { path = "../build" }\n' +
        '[target.\'cfg(target_arch = "riscv64")\'.dependencies]\ntarget = { path = "../target", optional = true }\n' +
        '[dev-dependencies]\ntest-only = { path = "../test-only" }\n',
    );
    appendFileSync(
      path.join(scratch, 'middle/Cargo.toml'),
      '[dependencies]\nrenamed.workspace = true\nserde = "1"\n',
    );
    mkdirSync(path.join(scratch, 'leaf/custom'), { recursive: true });
    mkdirSync(path.join(scratch, 'leaf/scripts'), { recursive: true });
    writeFileSync(path.join(scratch, 'leaf/custom/lib.rs'), 'pub fn custom() {}\n');
    writeFileSync(path.join(scratch, 'leaf/scripts/build.rs'), 'fn main() {}\n');
    writeFileSync(
      path.join(scratch, 'leaf/Cargo.toml'),
      '[package]\nname = "leaf"\nversion = "1.0.0"\nbuild = "scripts/build.rs"\n' +
        '[lib]\npath = "custom/lib.rs"\n',
    );
    // Planning must work before any registry cache or lockfile exists.
    process.env.CARGO_HOME = path.join(scratch, 'empty-cargo-cache');
    const impacts = declaredSharedSourceImpacts({
      'oliphaunt-node-direct': {
        embedded_cargo_manifests: [`${relative}/binary/Cargo.toml`],
      },
    });
    const fixtureGraph = { ...graph, shared_release_sources: impacts };
    for (const name of ['middle', 'build', 'target']) {
      expect(buildPlan(fixtureGraph, [`${relative}/${name}/src/lib.rs`]).releaseProducts).toEqual([
        'oliphaunt-node-direct',
      ]);
    }
    expect(buildPlan(fixtureGraph, [`${relative}/test-only/src/lib.rs`]).releaseProducts).toEqual(
      [],
    );
    expect(buildPlan(fixtureGraph, [`${relative}/leaf/README.md`]).releaseProducts).toEqual([]);
    expect(buildPlan(fixtureGraph, [`${relative}/leaf/src/lib.rs`]).releaseProducts).toEqual([]);
    for (const file of ['leaf/custom/module.rs', 'leaf/scripts/helper.rs']) {
      expect(buildPlan(fixtureGraph, [`${relative}/${file}`]).releaseProducts).toEqual([
        'oliphaunt-node-direct',
      ]);
    }
    expect(existsSync(path.join(scratch, 'Cargo.lock'))).toBe(false);
    expect(existsSync(path.join(process.env.CARGO_HOME, 'registry'))).toBe(false);
  } finally {
    if (previousCargoHome === undefined) delete process.env.CARGO_HOME;
    else process.env.CARGO_HOME = previousCargoHome;
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

async function generateProductCandidate(
  commits,
  readCompatibility = (product, source) => productCompatibilityVersion(product, source),
  configure = () => {},
  { root = ROOT, baseline = first } = {},
) {
  const config = JSON.parse(readFileSync(path.join(root, 'release-please-config.json'), 'utf8'));
  const versions = JSON.parse(
    readFileSync(path.join(root, '.release-please-manifest.json'), 'utf8'),
  );
  const github = {
    repository: { owner: 'f0rr0', repo: 'oliphaunt', defaultBranch: 'main' },
    async *releaseIterator() {
      for (const owner of Object.keys(config.packages))
        yield {
          tagName: `${config.packages[owner].component}-v${versions[owner]}`,
          sha: baseline,
          notes: 'Existing release',
        };
    },
    async *mergeCommitIterator() {
      yield* commits;
      yield { sha: baseline, message: 'chore(release): previous versions', files: [] };
    },
    async getFileContentsOnBranch(file) {
      const local = path.join(root, file);
      const parsedContent =
        file === 'release-please-config.json'
          ? JSON.stringify(config)
          : file === '.release-please-manifest.json'
            ? JSON.stringify(versions)
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
  includeOwnedSourceCommits(manifest, github, graph, readCompatibility);
  configure(manifest, github);
  const candidates = await manifest.buildPullRequests();
  expect(candidates.length).toBeLessThanOrEqual(1);
  const [candidate] = candidates;
  return { candidate, versions };
}

for (const scenario of [
  {
    name: 'documentation only',
    files: [
      'src/native/sdks/ts/README.md',
      'src/extensions/generated/docs/extension-evidence.json',
    ],
    products: [],
  },
  {
    name: 'one source SDK',
    files: ['src/native/sdks/ts/src/index.ts'],
    products: ['oliphaunt-js'],
  },
  {
    name: 'query updates and native ecosystem dependency bumps',
    files: ['src/query/ts/src/query.ts', 'src/query/rust/src/lib.rs'],
    products: [
      'oliphaunt-query-ts',
      'oliphaunt-query',
      'oliphaunt-broker',
      'oliphaunt-kotlin',
      'oliphaunt-swift',
      'oliphaunt-wasix-napi',
      'oliphaunt-js',
      'oliphaunt-react-native',
      'oliphaunt-wasix-ts',
    ],
  },
  {
    name: 'runtime and one external extension',
    files: [`${native}/src/liboliphaunt.c`, 'src/extensions/external/vector/source.toml'],
    products: ['liboliphaunt-native', 'oliphaunt-extension-vector'],
  },
  {
    name: 'broker and Rust SDK retain the older published broker requirement',
    files: ['src/native/broker/src/lib.rs', 'src/native/sdks/rust/src/lib.rs'],
    products: ['oliphaunt-broker', 'oliphaunt-rust', 'oliphaunt-kotlin', 'oliphaunt-swift'],
  },
  {
    name: 'WASIX compiled inputs advance while installed SDK pins retain published history',
    files: [
      `${wasix}/toolchain.toml`,
      'src/wasix/sdks/rust/src/oliphaunt/base.rs',
      'src/wasix/sdks/ts/src/index.ts',
    ],
    products: [
      'liboliphaunt-wasix',
      'oliphaunt-wasix-napi',
      'oliphaunt-wasix-rust',
      'oliphaunt-wasix-ts',
    ],
  },
  {
    name: 'shared package writer',
    files: ['src/extensions/artifacts/packages/tools/package-extension-cargo-facades.mts'],
    products: [
      'liboliphaunt-native',
      'oliphaunt-extension-pg-hashids',
      'oliphaunt-extension-pg-ivm',
      'oliphaunt-extension-pg-textsearch',
      'oliphaunt-extension-pg-uuidv7',
      'oliphaunt-extension-pgtap',
      'oliphaunt-extension-postgis',
      'oliphaunt-extension-vector',
    ],
  },
])
  test(`release scenario: ${scenario.name} produces coherent versions and exact consumer scope`, async () => {
    if (!scenario.products.length) {
      const { candidate } = await generateProductCandidate([
        { sha: head, message: 'docs: clarify usage', files: scenario.files },
      ]);
      expect(candidate).toBeUndefined();
      return;
    }
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'release-scenario-'));
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(ROOT, 'target'),
    };
    for (const name of Object.keys(env)) {
      if (
        /^(ACTIONS_|GH_|GITHUB_|RELEASE_|PUBLICATION_|OLIPHAUNT_(RELEASE_|PRODUCT_HISTORY|GIT_SOURCE_JSON|EVIDENCE_))/u.test(
          name,
        )
      )
        delete env[name];
    }
    const run = (command, args) => {
      const result = spawnSync(command, args, {
        cwd: scratch,
        env,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error || result.status !== 0)
        throw new Error(
          `${command} ${args.join(' ')}: ${result.error?.message ?? result.status}\n${result.stdout?.slice(-4000)}\n${result.stderr?.slice(-4000)}`,
        );
      return result.stdout.trim();
    };
    try {
      run('git', ['clone', '--quiet', '--shared', ROOT, '.']);
      // Include uncommitted control fixes, without rebuilding any product outputs.
      const changed = spawnSync('git', ['diff', '--name-only', '-z', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(changed.status).toBe(0);
      for (const file of changed.stdout.split('\0').filter(Boolean)) {
        const destination = path.join(scratch, file);
        if (existsSync(path.join(ROOT, file))) {
          mkdirSync(path.dirname(destination), { recursive: true });
          cpSync(path.join(ROOT, file), destination);
        } else rmSync(destination, { force: true });
      }
      appendFileSync(path.join(scratch, '.git/info/exclude'), '/node_modules\n');
      symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'));
      run('git', ['config', 'user.name', 'Release Fixture']);
      run('git', ['config', 'user.email', 'release@example.invalid']);
      run('git', ['add', '-A']);
      run('git', ['commit', '--allow-empty', '-qm', 'test: published release baseline']);
      const baseline = run('git', ['rev-parse', 'HEAD']);
      for (const product of Object.values(graph.products))
        run('git', ['tag', '-f', product.tag_prefix + product.version, baseline]);
      for (const file of scenario.files)
        appendFileSync(
          path.join(scratch, file),
          file.endsWith('.toml') ? '\n# release fixture\n' : '\n// release fixture\n',
        );
      if (scenario.files.some((file) => file.endsWith('/source.toml')))
        run('bash', ['tools/release/sync-release-pr.sh']);
      run('git', ['add', '-A']);
      run('git', ['commit', '-qm', 'fix: repair shipped behavior']);
      const source = run('git', ['rev-parse', 'HEAD']);
      const entries = compatibilityVersionEntries(graph.products, { requireSourceProduct: true });
      const readCompatibility = (product, dependency, _prefix, { ref = null } = {}) => {
        const entry = entries.find(
          (entry) => entry.product === product && entry.sourceProduct === dependency,
        );
        return compatibilityVersionFromText(
          entry,
          ref
            ? run('git', ['show', `${ref}:${entry.path}`])
            : readFileSync(path.join(scratch, entry.path), 'utf8'),
        );
      };
      const { candidate, versions } = await generateProductCandidate(
        [
          {
            sha: source,
            message: 'fix: repair shipped behavior',
            files: run('git', ['diff', '--name-only', baseline, source]).split('\n'),
          },
        ],
        readCompatibility,
        undefined,
        { root: scratch, baseline },
      );
      applyCandidate(scratch, candidate);
      const declaredRequirements = new Map(
        entries.map((entry) => [
          entry.id,
          compatibilityVersionFromText(entry, readFileSync(path.join(scratch, entry.path), 'utf8')),
        ]),
      );
      const metadata = path.join(scratch, '.git/release-candidate');
      mkdirSync(metadata);
      writeFileSync(path.join(metadata, 'required'), 'true\n');
      writeFileSync(path.join(metadata, 'title'), `${candidate.title.toString()}\n`);
      writeFileSync(path.join(metadata, 'body.md'), `${candidate.body.toString()}\n`);
      run('bash', ['tools/release/close-release-candidate.sh', metadata]);
      const closed = run('git', ['rev-parse', 'HEAD']);
      expect(run('git', ['rev-parse', 'HEAD^'])).toBe(source);
      run('bash', ['tools/release/sync-release-pr.sh']);
      run('bash', ['tools/release/sync-release-pr.sh', '--check-generated-release']);
      expect(run('git', ['diff', '--no-ext-diff'])).toBe('');
      expect(run('git', ['status', '--porcelain', '--untracked-files=all'])).toBe('');
      expect(run('git', ['rev-parse', 'HEAD'])).toBe(closed);
      const after = JSON.parse(
        readFileSync(path.join(scratch, '.release-please-manifest.json'), 'utf8'),
      );
      const changedOwners = Object.keys(after).filter((owner) => after[owner] !== versions[owner]);
      expect(changedOwners.sort()).toEqual(
        scenario.products.map((id) => graph.products[id].path).sort(),
      );
      const paths = candidate.updates.map((update) => update.path);
      expect(new Set(paths).size).toBe(paths.length);
      const products = structuredClone(graph.products);
      for (const id of scenario.products) {
        products[id].version = after[products[id].path];
        const before = Version.parse(versions[products[id].path]);
        expect(Version.parse(products[id].version).compare(before)).toBeGreaterThan(0);
        expect(paths).toContain(`${products[id].path}/CHANGELOG.md`);
      }
      const readRequirement = (entry) =>
        compatibilityVersionFromText(entry, readFileSync(path.join(scratch, entry.path), 'utf8'));
      const requirements = releaseDependencyPlan(products, scenario.products, {
        readValue: (entry) => declaredRequirements.get(entry.id),
      });
      for (const requirement of requirements) {
        expect(readRequirement(requirement)).toBe(requirement.version);
        if (requirement.binding === 'compiled-input')
          expect(requirement.version).toBe(products[requirement.sourceProduct].version);
        if (
          requirement.binding === 'declared-requirement' &&
          ['liboliphaunt-native', 'liboliphaunt-wasix'].includes(requirement.sourceProduct)
        )
          expect(requirement.version).toBe(compatibilityVersionValue(requirement));
      }
      const catalog = loadPublicationCatalog('release scenario', { products: scenario.products });
      const lock = {
        lockDigest: 'a'.repeat(64),
        products: catalog.products.map((product) => ({
          ...product,
          version: products[product.id].version,
        })),
        carriers: catalog.carriers.map((carrier) => ({
          ...carrier,
          version: products[carrier.product].version,
        })),
      };
      const plan = frozenConsumerPlan(lock, { configurationDigest: 'b'.repeat(64) });
      expect([...new Set(plan.cases.map((test) => test.product))].sort()).toEqual(
        [...scenario.products].sort(),
      );
      for (const carrier of lock.carriers)
        expect(
          plan.cases.some(
            (test) =>
              test.carrierId === carrier.id &&
              test.id.startsWith(`${carrier.id}@${carrier.version}/`),
          ),
        ).toBe(true);
      expect(new Set(frozenConsumerMatrix(plan).include.map((row) => row.target)).size).toBe(
        frozenConsumerMatrix(plan).include.length,
      );
      if (scenario.products.includes('oliphaunt-rust')) {
        expect(readCompatibility('oliphaunt-rust', 'oliphaunt-broker')).toBe(
          graph.products['oliphaunt-broker'].version,
        );
        expect(products['oliphaunt-broker'].version).not.toBe(
          graph.products['oliphaunt-broker'].version,
        );
      }
      if (scenario.products.includes('liboliphaunt-wasix')) {
        expect(readCompatibility('oliphaunt-wasix-rust', 'liboliphaunt-wasix')).toBe(
          graph.products['liboliphaunt-wasix'].version,
        );
        expect(readCompatibility('oliphaunt-wasix-napi', 'liboliphaunt-wasix')).toBe(
          products['liboliphaunt-wasix'].version,
        );
        run('git', ['reset', '--hard', source]);
        applyCandidate(scratch, candidate);
        const sdkPath = path.join(scratch, 'src/wasix/sdks/ts/package.json');
        const sdk = JSON.parse(readFileSync(sdkPath, 'utf8'));
        sdk.oliphaunt.runtimeVersion = products['liboliphaunt-wasix'].version;
        writeFileSync(sdkPath, `${JSON.stringify(sdk, null, 2)}\n`);
        expect(() => run('bash', ['tools/release/close-release-candidate.sh', metadata])).toThrow(
          /differs from oliphaunt-wasix-napi .* runtime/u,
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);

test('actual Rust, npm, Swift and Gradle strategy updates apply to one local candidate', async () => {
  const root = path.resolve(import.meta.dir, '../..');
  const selected = [
    'src/native/sdks/rust',
    'src/native/sdks/ts',
    'src/native/sdks/swift',
    'src/native/sdks/kotlin',
  ];
  const { candidate, versions } = await generateProductCandidate([
    {
      sha: head,
      message: 'fix: correct the selected SDK behavior',
      files: selected.map((owner) => `${owner}/src/implementation`),
    },
  ]);
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

test('runtime and SDK changes retain independent extension releases', async () => {
  for (const sdk of ['oliphaunt-kotlin', 'oliphaunt-wasix-rust', 'oliphaunt-react-native']) {
    const { candidate } = await generateProductCandidate([
      {
        sha: head,
        message: 'fix: repair integration',
        files: [`${native}/tools/package.sh`, `${graph.products[sdk].path}/src/implementation`],
      },
    ]);
    expect(
      candidate.updates.some(({ path: file }) => file.startsWith('src/extensions/external/')),
    ).toBe(false);
  }
});

test('independent SDK pins do not impose a single global runtime version', async () => {
  const readCompatibility = (product, source) =>
    product === 'oliphaunt-react-native' ? '0.2.0' : graph.products[source].version;
  const { candidate } = await generateProductCandidate(
    [
      {
        sha: head,
        message: 'fix: repair mobile adapters',
        files: [
          'src/native/sdks/kotlin/src/implementation',
          'src/native/sdks/react-native/ios/OliphauntAdapter.swift',
        ],
      },
    ],
    readCompatibility,
  );
  expect(candidate).toBeDefined();
  expect(
    candidate.updates.some(({ path: file }) => file.startsWith('src/extensions/external/')),
  ).toBe(false);
});

test('removing published exact host support supplies breaking intent before native version selection', async () => {
  const vector = graph.products['oliphaunt-extension-vector'];
  const reads = [];
  const readCompatibility = (product, source, _prefix, { ref = null } = {}) => {
    reads.push({ product, source, ref });
    return ref ? '0.1.0' : graph.products[source].version;
  };
  const { candidate, versions } = await generateProductCandidate(
    [
      {
        sha: head,
        message: 'fix: repair vector packaging',
        files: [`${vector.path}/source.toml`],
      },
    ],
    readCompatibility,
  );
  const update = mergeUpdates(candidate.updates).find(
    ({ path: file }) => file === '.release-please-manifest.json',
  );
  const after = JSON.parse(update.updater.updateContent(JSON.stringify(versions)));
  const [major, minor] = vector.version.split('.').map(Number);
  expect(after[vector.path]).toBe(`${major}.${minor + 1}.0`);
  const changelog = candidate.updates
    .find(({ path: file }) => file === vector.changelog_path)
    .updater.updateContent('# Changelog\n');
  expect(changelog).toContain('replace exact host support');
  expect(changelog).toContain('repair vector packaging');
  expect(
    reads
      .filter(({ ref }) => ref !== null)
      .every(({ product }) => product === vector.id || product === 'oliphaunt-extension-vector'),
  ).toBe(true);
});

test('unchanged public support permits an ordinary patch release', async () => {
  const vector = graph.products['oliphaunt-extension-vector'];
  const { candidate, versions } = await generateProductCandidate([
    {
      sha: head,
      message: 'fix: repair vector SQL',
      files: [`${vector.path}/source.toml`],
    },
  ]);
  const update = mergeUpdates(candidate.updates).find(
    ({ path: file }) => file === '.release-please-manifest.json',
  );
  const after = JSON.parse(update.updater.updateContent(JSON.stringify(versions)));
  const [major, minor, patch] = vector.version.split('.').map(Number);
  expect(after[vector.path]).toBe(`${major}.${minor}.${patch + 1}`);
});

test('workspace-created candidates receive public support intent through native bump selection', async () => {
  const vector = graph.products['oliphaunt-extension-vector'];
  let bump;
  await generateProductCandidate(
    [
      {
        sha: head,
        message: 'fix: update build helper API',
        files: ['src/native/sdks/rust/crates/oliphaunt-build/src/lib.rs'],
      },
    ],
    (_product, source, _prefix, { ref = null } = {}) =>
      ref ? '0.1.0' : graph.products[source].version,
    (manifest, github) => {
      manifest.plugins.push(
        new (class extends ManifestPlugin {
          async preconfigure(strategies, _commits, releases) {
            bump = await strategies[vector.path].versioningStrategy.bump(
              releases[vector.path].tag.version,
              [],
            );
            return strategies;
          }
        })(github, 'main', manifest.repositoryConfig),
      );
    },
  );
  const [major, minor] = vector.version.split('.').map(Number);
  expect(bump.toString()).toBe(`${major}.${minor + 1}.0`);
});

test('docs changes do not read compatibility or create candidates', async () => {
  const { candidate } = await generateProductCandidate(
    [
      {
        sha: head,
        message: 'docs: clarify preparation',
        files: ['src/docs/maintainers/release.md'],
      },
    ],
    () => {
      throw new Error('unexpected compatibility read');
    },
  );
  expect(candidate).toBeUndefined();
});

test('regeneration preserves the grouped body and complete update set', async () => {
  const commits = [
    { sha: head, message: 'fix: repair runtime', files: [`${native}/tools/package.sh`] },
  ];
  const render = ({ candidate }) => ({
    body: candidate.body.toString(),
    updates: mergeUpdates(candidate.updates).map((update) => {
      const file = path.join(ROOT, update.path);
      return [
        update.path,
        update.updater.updateContent(existsSync(file) ? readFileSync(file, 'utf8') : undefined),
      ];
    }),
  });
  expect(render(await generateProductCandidate(commits))).toEqual(
    render(await generateProductCandidate(commits)),
  );
});
