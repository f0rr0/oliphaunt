import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readCompletedContribCarrierRows } from './completed-contrib-carrier-context.mts';
import { createCompletedPublicationChecker } from './completed-release-publication.mts';
import { registryPackageRows } from './release-artifact-targets.mts';

const repository = 'f0rr0/oliphaunt';
const captured = JSON.parse(
  readFileSync(
    new URL('../../build_defs/release/native-0.3.3-completed-publication.json', import.meta.url),
    'utf8',
  ),
);
const files = new Map<string, Buffer>();
function fixture() {
  const changed = new Map<string, Buffer>();
  const requests: string[] = [];
  const raw = (file: string) => {
    const replacement = changed.get(file);
    if (replacement) return replacement;
    if (!files.has(file))
      files.set(file, execFileSync('git', ['show', `${captured.publicationSha}:${file}`]));
    const bytes = files.get(file);
    if (!bytes) throw new Error(`fixture lacks historical file ${file}`);
    return bytes;
  };
  const replace = (file: string, text: string) => changed.set(file, Buffer.from(text));
  const readJson = async (endpoint: string) => {
    requests.push(endpoint);
    const match = endpoint.match(/^repos\/f0rr0\/oliphaunt\/contents\/(.+)\?ref=([a-f0-9]{40})$/u);
    if (!match || match[2] !== captured.publicationSha)
      throw new Error(`fixture received a foreign source endpoint: ${endpoint}`);
    const file = match[1];
    const bytes = raw(file);
    return {
      type: 'file',
      path: file,
      encoding: 'base64',
      content: bytes.toString('base64'),
      sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    };
  };
  // This controlled transport substitutes completion; it does not claim that
  // hypothetical source mutations below were actually published or qualified.
  const options = { repository, readJson, assertCompleted: async (publication) => publication };
  return { raw, replace, readJson, requests, options };
}

function ownerPath(f: ReturnType<typeof fixture>, owner: string) {
  const config = JSON.parse(f.raw('release-please-config.json').toString('utf8'));
  const entry = Object.entries(config.packages).find(([, row]: any) => row.component === owner);
  if (!entry) throw new Error(`fixture lacks historical owner ${owner}`);
  return entry[0];
}

function wasixPublication(f: ReturnType<typeof fixture>) {
  const owner = ownerPath(f, 'liboliphaunt-wasix');
  const version = JSON.parse(f.raw('.release-please-manifest.json').toString('utf8'))[owner];
  return {
    ...captured,
    product: 'liboliphaunt-wasix',
    version,
    tagName: `liboliphaunt-wasix-v${version}`,
  };
}

test('genuine completed native source expands its contrib carriers without old BUILD or Moon data', async () => {
  const f = fixture();
  const result = await readCompletedContribCarrierRows(captured, f.options);
  expect(result.publication).toEqual(captured);
  expect(result.descriptor.version).toBe('0.3.3');
  expect(result.descriptor.artifact_targets).toBeUndefined();
  expect(result.registryRows).toEqual(registryPackageRows({ product: 'liboliphaunt-native' }));
  const names = result.registryRows.map(({ raw }) => raw);
  expect(names).toContain('crates:oliphaunt-extension-contrib-pg18');
  expect(names).toContain('crates:oliphaunt-extension-contrib-pg18-windows-x64-msvc');
  expect(names).toContain('npm:@oliphaunt/extension-contrib-pg18-macos-arm64');
  expect(names).toContain(
    'maven:dev.oliphaunt.extensions:oliphaunt-extension-contrib-pg18-android-arm64-v8a',
  );
  expect(result.sourceFiles).toHaveLength(10);
  expect(f.requests.every((endpoint) => endpoint.endsWith(`?ref=${captured.publicationSha}`))).toBe(
    true,
  );
  expect(result.sourceFiles.some(({ path }) => /BUILD|moon/.test(path))).toBe(false);
});

test('historical profiles rather than current workspace targets determine expansion', async () => {
  const f = fixture();
  const file = 'src/extensions/contracts/extension-target-profiles.toml';
  const profiles = Bun.TOML.parse(f.raw(file).toString('utf8')) as any;
  // A hypothetical older declaration promises one desktop carrier only.
  f.replace(
    file,
    `schema = "${profiles.schema}"\n[[profiles]]\nid="old-desktop"\n[[profiles.targets]]\ntarget="linux-x64-gnu"\nfamily="native"\nkind="native-dynamic"\n`,
  );
  const result = await readCompletedContribCarrierRows(captured, f.options);
  const names = result.registryRows.map(({ raw }) => raw);
  expect(names).toContain('crates:oliphaunt-extension-contrib-pg18-linux-x64-gnu');
  expect(names).not.toContain('crates:oliphaunt-extension-contrib-pg18-macos-arm64');
  expect(names).not.toContain(
    'maven:dev.oliphaunt.extensions:oliphaunt-extension-contrib-pg18-android-x86_64',
  );
  // Independent directly authored runtime obligations remain present.
  expect(names).toContain('crates:liboliphaunt-native-macos-arm64');
});

test('source-declared module membership controls held WASIX AOT carriers', async () => {
  const f = fixture();
  const publication = wasixPublication(f);
  const before = await readCompletedContribCarrierRows(publication, f.options);
  expect(
    before.registryRows.some(({ raw }) => raw.includes('contrib-pg18-') && raw.includes('-aot-')),
  ).toBe(true);
  const file = 'src/extensions/generated/extensions.catalog.json';
  const catalog = JSON.parse(f.raw(file).toString('utf8'));
  for (const row of catalog.extensions) delete row['native-module-file'];
  f.replace(file, JSON.stringify(catalog));
  const after = await readCompletedContribCarrierRows(publication, f.options);
  expect(
    after.registryRows.some(({ raw }) => raw.includes('contrib-pg18-') && raw.includes('-aot-')),
  ).toBe(false);
  expect(after.registryRows.map(({ raw }) => raw)).toContain(
    'crates:oliphaunt-extension-contrib-pg18-wasix',
  );
  expect(after.registryRows.map(({ raw }) => raw)).toContain(
    'npm:@oliphaunt/extension-contrib-pg18-wasix',
  );
});

test('partial target-table migration cannot silently bypass an authored runtime declaration', async () => {
  for (const [owner, target] of [
    ['liboliphaunt-native', 'linux-x64-gnu'],
    ['liboliphaunt-wasix', 'portable'],
  ]) {
    const f = fixture();
    const file = `${ownerPath(f, owner)}/release.toml`;
    f.replace(
      file,
      `${f.raw(file).toString('utf8')}\n[artifact_targets]\npreset="${owner}"\ntargets=["${target}"]\n`,
    );
    await expect(readCompletedContribCarrierRows(captured, f.options)).rejects.toThrow(
      'mixed historical runtime artifact target declarations',
    );
  }
});

test('unsupported historical family, kind and target combinations are not silently omitted', async () => {
  for (const [target, family, kind] of [
    ['linux-x64-gnu', 'foreign', 'native-dynamic'],
    ['linux-x64-gnu', 'native', 'wasix-runtime'],
    ['linux-x64-gnu', 'wasix', 'native-dynamic'],
    ['unknown-host', 'native', 'native-dynamic'],
    ['ios-xcframework', 'native', 'native-dynamic'],
    ['linux-x64-gnu', 'native', 'native-static-registry'],
    ['constructor', 'wasix', 'wasix-runtime'],
    ['constructor', 'native', 'native-dynamic'],
  ]) {
    const f = fixture();
    f.replace(
      'src/extensions/contracts/extension-target-profiles.toml',
      `schema="oliphaunt-extension-artifact-target-profiles-v1"\n[[profiles]]\nid="old-profile"\n[[profiles.targets]]\ntarget="${target}"\nfamily="${family}"\nkind="${kind}"\n`,
    );
    await expect(readCompletedContribCarrierRows(captured, f.options)).rejects.toThrow(
      'unsupported historical profile',
    );
  }
});

test('held WASIX expansion requires the historical portable and supported AOT declarations', async () => {
  const missingPortable = fixture();
  const file = 'src/extensions/contracts/extension-target-profiles.toml';
  missingPortable.replace(
    file,
    `schema="oliphaunt-extension-artifact-target-profiles-v1"\n[[profiles]]\nid="native-only"\n[[profiles.targets]]\ntarget="linux-x64-gnu"\nfamily="native"\nkind="native-dynamic"\n`,
  );
  await expect(
    readCompletedContribCarrierRows(wasixPublication(missingPortable), missingPortable.options),
  ).rejects.toThrow('historical WASIX portable carrier profile is missing');

  const missingAot = fixture();
  const descriptor = `${ownerPath(missingAot, 'liboliphaunt-wasix')}/release.toml`;
  missingAot.replace(
    descriptor,
    missingAot
      .raw(descriptor)
      .toString('utf8')
      .replace(/\s*"crates:liboliphaunt-wasix-aot-aarch64-apple-darwin",/u, ''),
  );
  await expect(
    readCompletedContribCarrierRows(wasixPublication(missingAot), missingAot.options),
  ).rejects.toThrow('historical WASIX AOT carrier mapping');
});

test('owner path is resolved from the completed release config, not current directories', async () => {
  const f = fixture();
  const file = 'release-please-config.json';
  const config = JSON.parse(f.raw(file).toString('utf8'));
  const previous = ownerPath(f, captured.product);
  const renamed = 'historical/native-owner';
  config.packages[renamed] = config.packages[previous];
  delete config.packages[previous];
  f.replace(file, JSON.stringify(config));
  f.replace(`${renamed}/release.toml`, f.raw(`${previous}/release.toml`).toString('utf8'));
  const versions = JSON.parse(f.raw('.release-please-manifest.json').toString('utf8'));
  versions[renamed] = versions[previous];
  delete versions[previous];
  f.replace('.release-please-manifest.json', JSON.stringify(versions));
  const result = await readCompletedContribCarrierRows(captured, f.options);
  expect(result.descriptor.path).toBe(renamed);
  expect(
    f.requests.some((endpoint) => endpoint.includes(`/contents/${previous}/release.toml?`)),
  ).toBe(false);
});

test('missing, substituted and malformed historical source inputs never fall back to current files', async () => {
  for (const mutation of [
    (row) => ({ ...row, path: 'foreign/catalog.json' }),
    (row) => ({ ...row, sha: 'f'.repeat(40) }),
    (row) => ({ ...row, type: 'symlink' }),
  ]) {
    const f = fixture();
    await expect(
      readCompletedContribCarrierRows(captured, {
        ...f.options,
        readJson: async (endpoint) => mutation(await f.readJson(endpoint)),
      }),
    ).rejects.toThrow();
  }
  for (const [file, text] of [
    [
      'src/extensions/contrib/carriers.toml',
      (f) =>
        f
          .raw('src/extensions/contrib/carriers.toml')
          .toString('utf8')
          .replace('src/extensions/contrib/postgres18.toml', '../outside.toml'),
    ],
    [
      'src/extensions/generated/extensions.catalog.json',
      () => '{"format-version":1,"extensions":[]}',
    ],
    ['src/extensions/contrib/postgres18.toml', () => 'extensions=[]'],
    [
      'src/extensions/contracts/extension-target-profiles.toml',
      () => 'schema="foreign"\nprofiles=[]',
    ],
  ] as const) {
    const f = fixture();
    f.replace(file, text(f));
    await expect(readCompletedContribCarrierRows(captured, f.options)).rejects.toThrow();
  }
  const malformed = fixture();
  await expect(
    readCompletedContribCarrierRows(captured, {
      ...malformed.options,
      readJson: async () => {
        throw new Error('historical catalog absent');
      },
    }),
  ).rejects.toThrow('historical catalog absent');
});

test('completed origin, owner version and canonical source ownership are mandatory', async () => {
  const f = fixture();
  await expect(
    readCompletedContribCarrierRows(captured, {
      ...f.options,
      assertCompleted: async (value) => ({ ...value, publicationSha: 'f'.repeat(40) }),
    }),
  ).rejects.toThrow('completed contrib source');
  expect(f.requests).toHaveLength(0);
  await expect(
    readCompletedContribCarrierRows(captured, { ...f.options, repository: 'foreign/repo' }),
  ).rejects.toThrow('unsupported repository');
  await expect(
    readCompletedContribCarrierRows({ ...captured, version: '9.9.9' }, f.options),
  ).rejects.toThrow('product version');
  await expect(
    readCompletedContribCarrierRows({ ...captured, product: 'oliphaunt-query' }, f.options),
  ).rejects.toThrow('not a historical contrib owner');
  const checker = createCompletedPublicationChecker({
    repository,
    readJson: async () => ({
      tag_name: captured.tagName,
      target_commitish: captured.publicationSha,
      draft: true,
      prerelease: false,
    }),
  });
  await expect(
    readCompletedContribCarrierRows(captured, { ...f.options, assertCompleted: checker }),
  ).rejects.toThrow('public release');
});
