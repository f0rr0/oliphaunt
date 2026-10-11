import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { writeNativeChecksums } from './checksums.mts';
import { type EnvelopeSpec, packageEnvelope, validateNpmIdentity } from './envelopes.mts';
import { type FacadeSpec, packageToolsFacade, toolsFacadeTargets } from './facades.mts';
import { copyDeclaredTree, materializeMappings, stageLegalSources } from './payload.mts';

const [inputs] = process.argv.slice(2);
assert(inputs, 'expected canonical carrier test inputs');
const specification = JSON.parse(readFileSync(inputs, 'utf8'));
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'native-carrier-tests-'));
function requiredMember(
  entries: ReturnType<typeof readPortableArchiveEntries>,
  name: string,
): Buffer {
  const entry = entries.get(name);
  assert(entry?.isFile, `missing regular archive member ${name}`);
  return Buffer.from(entry.data());
}
let scenarios = 0;
try {
  const scalar = path.join(root, 'scalar');
  writeFileSync(scalar, 'actual producer bytes');
  const tree = path.join(root, 'tree');
  mkdirSync(path.join(tree, 'nested'), { recursive: true });
  writeFileSync(path.join(tree, 'nested/data'), 'timezone bytes');
  const output = path.join(root, 'mapped');
  const mappings = [
    { source: scalar, destination: 'runtime/bin/postgres', tree: false, mode: '0755' },
    { source: tree, destination: 'runtime/share/postgresql/timezone', tree: true, mode: '0644' },
  ];
  materializeMappings(mappings, output);
  assert.equal(
    readFileSync(path.join(output, 'runtime/bin/postgres'), 'utf8'),
    'actual producer bytes',
  );
  assert.equal(statSync(path.join(output, 'runtime/bin/postgres')).mode & 0o777, 0o755);
  assert.equal(
    readFileSync(path.join(output, 'runtime/share/postgresql/timezone/nested/data'), 'utf8'),
    'timezone bytes',
  );
  assert.throws(
    () => materializeMappings([...mappings, mappings[0]], path.join(root, 'duplicate')),
    /duplicate/,
  );
  assert.throws(
    () =>
      materializeMappings(
        [{ ...mappings[0], destination: '../escape' }],
        path.join(root, 'escape'),
      ),
    /unsafe/,
  );
  assert.throws(
    () => materializeMappings([{ ...mappings[0], mode: '0777' }], path.join(root, 'bad-mode')),
    /mode/,
  );
  symlinkSync(scalar, path.join(tree, 'escape'));
  assert.throws(
    () => materializeMappings([mappings[1]], path.join(root, 'linked')),
    /symbolic link/,
  );
  rmSync(path.join(tree, 'escape'));
  scenarios++;

  const generated = path.join(root, 'producer/declared/tree');
  const sandbox = path.join(root, 'sandbox');
  const projected = path.join(sandbox, 'declared/tree');
  mkdirSync(path.join(generated, 'nested'), { recursive: true });
  mkdirSync(path.join(projected, 'nested'), { recursive: true });
  writeFileSync(path.join(generated, 'nested/data'), 'declared tree bytes');
  symlinkSync(path.join(generated, 'nested/data'), path.join(projected, 'nested/data'));
  const sourceCwd = process.cwd();
  try {
    process.chdir(sandbox);
    copyDeclaredTree('declared/tree', path.join(root, 'physical-tree'));
    assert.equal(
      readFileSync(path.join(root, 'physical-tree/nested/data'), 'utf8'),
      'declared tree bytes',
    );
    chmodSync(path.join(generated, 'nested/data'), 0o755);
    copyDeclaredTree('declared/tree', path.join(root, 'normalized-tree'), []);
    assert.equal(statSync(path.join(root, 'normalized-tree/nested/data')).mode & 0o777, 0o644);
    assert.throws(
      () => copyDeclaredTree('declared/tree', path.join(root, 'missing-executable'), ['missing']),
      /omitted executable/,
    );
    symlinkSync(scalar, path.join(projected, 'outside'));
    assert.throws(
      () => copyDeclaredTree('declared/tree', path.join(root, 'outside-tree')),
      /escapes/,
    );
    rmSync(path.join(projected, 'outside'));
    rmSync(path.join(generated, 'nested/data'));
    symlinkSync(scalar, path.join(generated, 'nested/data'));
    assert.throws(
      () => copyDeclaredTree('declared/tree', path.join(root, 'authored-link-tree')),
      /non-regular original/,
    );
  } finally {
    process.chdir(sourceCwd);
  }
  scenarios++;

  const artifact = specification.targets.find(({ target }) => target === 'linux-x64-gnu');
  const leaf = specification.carriers.find(
    ({ ecosystem, name }) => ecosystem === 'npm' && name === artifact.npm_package,
  );
  const manifest = {
    name: leaf.name,
    version: specification.version,
    os: [artifact.npm_os],
    cpu: [artifact.npm_cpu],
    libc: [artifact.npm_libc],
    exports: { './package.json': './package.json' },
    oliphaunt: { target: artifact.target, runtimeRelativePath: 'runtime' },
  };
  const envelope: EnvelopeSpec = {
    phase: 'npm',
    artifact,
    version: specification.version,
    carriers: specification.carriers,
    payload: output,
    sources: {},
    legal: specification.legal,
    output: path.join(root, 'leaf.tgz'),
  };
  assert.equal(validateNpmIdentity(manifest, envelope).name, leaf.name);
  assert.throws(() => validateNpmIdentity({ ...manifest, version: '999.0.0' }, envelope));
  assert.throws(() => validateNpmIdentity({ ...manifest, cpu: ['arm64'] }, envelope));
  scenarios++;

  const facade: FacadeSpec = {
    phase: 'npm',
    version: specification.version,
    targets: specification.targets,
    carriers: specification.carriers,
    sources: Object.fromEntries(
      Object.entries(specification.sources)
        .filter(([name]) => name.startsWith('npm/'))
        .map(([name, file]) => [name.slice(4), file]),
    ) as Record<string, string>,
    legal: specification.legal,
    output: path.join(root, 'tools.tgz'),
  };
  assert.equal(toolsFacadeTargets(facade).length, specification.targets.length);
  assert.throws(
    () => toolsFacadeTargets({ ...facade, targets: facade.targets.slice(1) }),
    /all declared/,
  );
  packageToolsFacade(facade);
  const npm = readPortableArchiveEntries(facade.output);
  const packed = JSON.parse(requiredMember(npm, 'package/package.json').toString());
  assert.deepEqual(
    packed.optionalDependencies,
    Object.fromEntries(
      specification.targets.map(({ npm_package }) => [npm_package, specification.version]),
    ),
  );
  assert.equal(packed.scripts, undefined);
  assert(requiredMember(npm, 'package/index.js').toString().includes('resolveRuntime'));
  const repeat = path.join(root, 'tools-repeat.tgz');
  packageToolsFacade({ ...facade, output: repeat });
  assert.deepEqual(readFileSync(repeat), readFileSync(facade.output));
  scenarios++;

  const cargoFacade = {
    ...facade,
    phase: 'cargo' as const,
    sources: Object.fromEntries(
      Object.entries(specification.sources)
        .filter(([name]) => name.startsWith('cargo/'))
        .map(([name, file]) => [name.slice(6), file]),
    ) as Record<string, string>,
    output: path.join(root, 'tools.crate'),
  };
  packageToolsFacade(cargoFacade);
  const cargo = readPortableArchiveEntries(cargoFacade.output);
  const text = requiredMember(
    cargo,
    `oliphaunt-tools-${specification.version}/Cargo.toml`,
  ).toString();
  const cargoManifest = Bun.TOML.parse(text);
  const dependencies = Object.values(cargoManifest.target).flatMap((table) =>
    Object.entries(table.dependencies),
  );
  assert.deepEqual(
    dependencies.map(([name]) => name).sort(),
    specification.targets.map(({ target }) => `oliphaunt-tools-${target}`).sort(),
  );
  for (const [, dependency] of dependencies)
    assert.deepEqual(dependency, { version: `=${specification.version}` });
  assert(cargo.has(`oliphaunt-tools-${specification.version}/testdata/logical-tools.json`));
  scenarios++;

  const payload = path.join(root, 'cargo-payload');
  mkdirSync(path.join(payload, 'runtime/bin'), { recursive: true });
  writeFileSync(path.join(payload, 'runtime/bin/psql'), randomBytes(1024));
  chmodSync(path.join(payload, 'runtime/bin/psql'), 0o755);
  for (const name of ['pg_dump', 'pg_basebackup'])
    writeFileSync(path.join(payload, 'runtime/bin', name), 'archive executable');
  writeFileSync(path.join(payload, 'runtime/bin/provider.dll'), 'provider library');
  writeFileSync(path.join(payload, 'runtime/bin/provider-receipt.json'), '{}');
  // Reproduce Bazel's generated-tree permissions, rather than assuming those
  // permissions retain the package mapping's distinction between files/programs.
  chmodSync(path.join(payload, 'runtime/bin/provider.dll'), 0o755);
  chmodSync(path.join(payload, 'runtime/bin/provider-receipt.json'), 0o755);
  const legal = path.join(root, 'legal');
  stageLegalSources(specification.legal, legal);
  const cargoOutput = path.join(root, 'cargo-packages');
  await packageEnvelope({
    ...envelope,
    phase: 'cargo',
    payload,
    output: cargoOutput,
    partBytes: 256,
  });
  const index = JSON.parse(readFileSync(path.join(cargoOutput, 'packages.json'), 'utf8'));
  assert.equal(index.schema, 'oliphaunt-liboliphaunt-cargo-artifacts-v1');
  assert(index.packages.filter(({ role }) => role === 'part').length > 4);
  assert.equal(index.packages.filter(({ role }) => role === 'aggregator').length, 1);
  for (const pkg of index.packages) {
    assert(!pkg.manifestPath.includes('native-envelope-'));
    assert(statSync(pkg.cratePath).size <= 10 * 1024 * 1024);
  }
  const chunks = index.packages
    .filter(({ role }) => role === 'part')
    .flatMap(({ cratePath }) =>
      [...readPortableArchiveEntries(cratePath).values()]
        .filter((entry) => entry.isFile && /\/psql\.part\d{3}$/u.test(entry.name))
        .map((entry) => Buffer.from(entry.data())),
    );
  assert.equal(chunks.length, 4);
  assert.deepEqual(Buffer.concat(chunks), readFileSync(path.join(payload, 'runtime/bin/psql')));
  const aggregator = index.packages.find(({ role }) => role === 'aggregator');
  const build = requiredMember(
    readPortableArchiveEntries(aggregator.cratePath),
    `${aggregator.name}-${specification.version}/build.rs`,
  ).toString();
  for (const executable of ['pg_dump', 'pg_basebackup', 'psql'])
    assert.match(build, new RegExp(`\\("runtime/bin/${executable}", "[0-9a-f]{64}", true\\)`));
  for (const regular of ['provider.dll', 'provider-receipt.json'])
    assert.match(
      build,
      new RegExp(`\\("runtime/bin/${regular.replaceAll('.', '\\.')}", "[0-9a-f]{64}", false\\)`),
    );
  const cwd = process.cwd();
  const absoluteLegal = Object.fromEntries(
    Object.entries(envelope.legal).map(([name, file]) => [name, path.resolve(file)]),
  );
  try {
    process.chdir(root);
    await packageEnvelope({
      ...envelope,
      phase: 'cargo',
      payload,
      output: 'logical-cargo',
      partBytes: 256,
      legal: absoluteLegal,
    });
    const relative = JSON.parse(readFileSync('logical-cargo/packages.json', 'utf8'));
    assert(
      relative.packages.every(
        ({ cratePath, manifestPath }) =>
          cratePath.startsWith('logical-cargo/') &&
          manifestPath.startsWith('logical-cargo/manifests/'),
      ),
    );
  } finally {
    process.chdir(cwd);
  }
  scenarios++;

  const github = path.join(root, artifact.asset.replaceAll('{version}', specification.version));
  await packageEnvelope({ ...envelope, phase: 'github', payload, output: github });
  const githubEntries = readPortableArchiveEntries(github);
  for (const regular of ['provider.dll', 'provider-receipt.json'])
    assert.equal(githubEntries.get(`runtime/bin/${regular}`)?.mode, 0o644);
  for (const executable of ['pg_dump', 'pg_basebackup', 'psql'])
    assert.equal(githubEntries.get(`runtime/bin/${executable}`)?.mode, 0o755);
  const copy = path.join(root, 'repeat', path.basename(github));
  await packageEnvelope({ ...envelope, phase: 'github', payload, output: copy });
  assert.deepEqual(readFileSync(github), readFileSync(copy));
  const checksum = path.join(root, 'checksums');
  writeNativeChecksums({ expected: [path.basename(github)], files: [github], output: checksum });
  assert.match(
    readFileSync(checksum, 'utf8'),
    new RegExp(`^[0-9a-f]{64}  ${path.basename(github).replaceAll('.', '\\.')}\\n$`),
  );
  assert.throws(
    () =>
      writeNativeChecksums({
        expected: [path.basename(github), 'missing'],
        files: [github],
        output: checksum,
      }),
    /missing/,
  );
  assert.throws(
    () =>
      writeNativeChecksums({
        expected: [path.basename(github)],
        files: [github, copy],
        output: checksum,
      }),
    /repeats/,
  );
  scenarios++;
  console.log(
    `Native runtime/tools carriers: ${scenarios} mapping, identity, facade, split-payload and checksum scenarios passed.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
