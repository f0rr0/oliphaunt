import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  embeddedBindings,
  exportsDefinition,
} from '../../../../build_defs/wasix/engine/generate.mts';
import { renderCargoToml } from '../../../../tools/packaging/cargo-manifest.mts';
import { createDeterministicTar } from '../../../../tools/packaging/package-archive.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../../tools/packaging/portable-archive.mts';
import { assembleWindowsEnginePackages, ENGINE_SOURCE_PACKAGES } from './package.mts';
import {
  assembleRelinkKit,
  buildRelinkKit,
  installRelinkedDll,
  type RelinkInputs,
  type RelinkTools,
  verifyRelinkKit,
} from './relink.mts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const version = '0.3.4';
const bindings = [
  ...Array.from({ length: 310 }, (_, index) => `wasm_fixture_${index}`),
  'wasm_tag_get',
  'wasm_tag_set',
  'wasm_tagtype_as_externtype',
  'wasm_tagtype_as_externtype_const',
]
  .map((name) => `unsafe extern "C" { #[link_name = "\\u{1}wee8_${name}"] pub fn ${name}(); }`)
  .join('\n');

function fixture(t): {
  input: RelinkInputs;
  root: string;
  dll: Buffer;
  file: (relative: string, content: string | Uint8Array) => string;
} {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'windows-v8-relink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (relative: string, content: string | Uint8Array) => {
    const destination = path.join(root, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
    return destination;
  };
  const dll = randomBytes(8192);
  const loader = '// engine identity @@ENGINE_DIGEST@@\n';
  const header = 'pinned C++ header fixture\n';
  const objectNames = ['branred', 's_sin', 'sincostab'];
  const originalObjects = Object.fromEntries(
    objectNames.map((name) => [
      `obj/libm/${name}.obj`,
      Buffer.from(`original ${name} COFF member fixture`).toString('base64'),
    ]),
  );
  const library = Buffer.from(
    JSON.stringify({
      ...originalObjects,
      'obj/unchanged.obj': Buffer.from('unchanged V8 object').toString('base64'),
    }),
  );
  const sourceDirectory = path.join(root, 'source');
  const sourcePins = objectNames.map((name) => {
    const sourcePath = `third_party/glibc/src/sysdeps/ieee754/dbl-64/${name}.c`;
    const source = `double ${name}_fixture(void) { return 1; }\n`;
    file(`source/${sourcePath}`, source);
    return {
      path: sourcePath,
      sha256: sha(Buffer.from(source)),
      url: 'https://example.invalid/pinned-source',
    };
  });
  file('archive/lib/v8.lib', library);
  const archiveFile = file(
    'wee8.tar.xz',
    gzipSync(
      createDeterministicTar(path.join(root, 'archive/lib'), 'lib', { includeDirectories: false }),
    ),
  );
  const sourcePinsFile = file(
    'relink.json',
    JSON.stringify({
      v8Commit: 'immutable-v8-fixture',
      files: sourcePins,
      objects: sourcePins.map((pin, index) => ({
        source: pin.path,
        member: `obj/libm/${objectNames[index]}.obj`,
        sha256: sha(Buffer.from(originalObjects[`obj/libm/${objectNames[index]}.obj`], 'base64')),
      })),
      compilerArguments: ['/c', '/TC', '/MT'],
    }),
  );
  const enginePinsFile = file(
    'sources.json',
    JSON.stringify({
      crates: Object.fromEntries(Object.keys(ENGINE_SOURCE_PACKAGES).map((name) => [name, {}])),
      wee8: {
        sha256: sha(readFileSync(archiveFile)),
        bytes: readFileSync(archiveFile).length,
        library: { path: 'lib/v8.lib', sha256: sha(library), bytes: library.length },
        header: { sha256: sha(Buffer.from(header)) },
        v8: { commit: 'immutable-v8-fixture' },
      },
    }),
  );
  const sources = {} as any;
  for (const name of Object.keys(ENGINE_SOURCE_PACKAGES)) {
    sources[name] = path.join(root, 'source-crates', name);
    file(
      `source-crates/${name}/Cargo.toml`,
      renderCargoToml({
        package: { name, version: name === 'wasmer' ? '7.5.0' : '0.705.0' },
        lib: { path: 'src/lib.rs' },
        features: name === 'wasmer' ? { v8: [] } : {},
      }),
    );
    file(`source-crates/${name}/src/lib.rs`, `// patched ${name} fixture\n`);
  }
  const noticesFile = file('notices.md', 'Full applicable license text fixture\n');
  const buildScript = file('build.rs.tpl', 'fn main() {}\n');
  const embedded = file('embedded.rs', embeddedBindings(bindings, loader, dll));
  const packages = assembleWindowsEnginePackages({
    version,
    sources,
    noticesFile,
    buildScriptTemplate: buildScript,
    dllFile: file('original.dll', dll),
    embeddedBindingsFile: embedded,
    sdkManifestFile: file(
      'sdk/Cargo.toml',
      `[package]\nname="oliphaunt-wasix"\nversion="${version}"\n`,
    ),
    outputDirectory: path.join(root, 'packages'),
  });
  const input = {
    version,
    sourceDirectory,
    sourcePinsFile,
    enginePinsFile,
    noticesFile,
    upstreamArchiveFile: archiveFile,
    outputDirectory: path.join(root, 'kit'),
    glue: {
      bridge: file('bridge.cc', '// actual bridge fixture\n'),
      header: file('wasm.hh', header),
      exports: file('exports.def', exportsDefinition(bindings)),
      bindings: file('bindings.rs', bindings),
      generator: fileURLToPath(
        new URL('../../../../build_defs/wasix/engine/generate.mts', import.meta.url),
      ),
      loader: file('loader.rs', loader),
      buildScript,
    },
    crates: Object.fromEntries(packages.map(({ name, archive }) => [name, archive])),
  };
  return { input, root, dll, file };
}

function extractCrates(input: RelinkInputs, root: string) {
  return Object.fromEntries(
    Object.entries(input.crates).map(([name, archive]) => {
      const directory = path.join(root, `${name}-${version}`);
      extractPortableArchiveTree(archive, directory, `${name}-${version}`);
      return [name, directory];
    }),
  );
}

/** Model LIB's documented combine-then-remove behavior; this is not a native compiler proof. */
function fakeTools(root: string, library?: string) {
  const tools: RelinkTools = Object.fromEntries(
    ['clangCl', 'cl', 'lib', 'link', ...(library ? [] : ['tar'])].map((name) => [
      name,
      path.join(root, 'tool paths with spaces', `${name}.exe`),
    ]),
  ) as RelinkTools;
  if (library) tools.library = library;
  const commands: { tool: string; args: string[] }[] = [];
  function write(file: string, data: Uint8Array | string) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  const execute = (tool: string, args: string[]): Buffer => {
    commands.push({ tool, args: [...args] });
    const option = (prefix: string) =>
      args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
    if (tool === tools.tar) {
      assert.equal(args[0], '-xf');
      assert.equal(args[2], '-C');
      const entry = readPortableArchiveEntries(args[1], { format: 'tar.gz' }).get(args[4]);
      assert(entry?.isFile);
      write(path.join(args[3], args[4]), entry.data());
    } else if (tool === tools.lib) {
      const output = option('/OUT:');
      assert(output);
      const extract = option('/EXTRACT:');
      const inputs = args.filter(
        (arg) =>
          arg !== '/NOLOGO' &&
          !['/OUT:', '/EXTRACT:', '/REMOVE:'].some((prefix) => arg.startsWith(prefix)),
      );
      if (extract) {
        assert.equal(inputs.length, 1);
        const members = JSON.parse(readFileSync(inputs[0], 'utf8'));
        assert(members[extract], `Missing original archive member ${extract}`);
        write(output, Buffer.from(members[extract], 'base64'));
      } else {
        const members: Record<string, string> = {};
        for (const input of inputs) {
          if (input.endsWith('.lib'))
            Object.assign(members, JSON.parse(readFileSync(input, 'utf8')));
          else members[path.basename(input)] = readFileSync(input).toString('base64');
        }
        // Real LIB applies /REMOVE after combining all the input libraries and objects.
        for (const remove of args.filter((arg) => arg.startsWith('/REMOVE:')))
          delete members[remove.slice('/REMOVE:'.length)];
        write(output, JSON.stringify(members));
      }
    } else if (tool === tools.clangCl || tool === tools.cl) {
      const output = option('/Fo');
      assert(output);
      write(
        output,
        Buffer.concat([Buffer.from('compiled fixture: '), readFileSync(args[args.length - 1])]),
      );
    } else if (tool === tools.link) {
      const output = option('/OUT:');
      assert(output);
      const linkedLibrary = args.find((arg) => arg.endsWith('v8.relinked.lib'));
      assert(linkedLibrary);
      const members = JSON.parse(readFileSync(linkedLibrary, 'utf8'));
      assert.equal(
        Buffer.from(members['obj/unchanged.obj'], 'base64').toString(),
        'unchanged V8 object',
      );
      for (const name of ['branred', 's_sin', 'sincostab']) {
        assert(!members[`obj/libm/${name}.obj`], `Old ${name} member survived removal`);
        assert(
          Buffer.from(members[`${name}.obj`], 'base64').toString().includes('return 2;'),
          `Modified ${name} source was not linked`,
        );
      }
      write(
        output,
        Buffer.concat([Buffer.from('linked DLL fixture: '), readFileSync(linkedLibrary)]),
      );
    } else assert.fail(`Unexpected tool ${tool}`);
    return Buffer.alloc(0);
  };
  return { tools, commands, execute };
}

for (const cached of [false, true]) {
  test(`complete relink command path ${cached ? 'reuses a verified cached library' : 'extracts the bundled library'} with spaces and coherent private packages`, (t) => {
    const { input, root, file } = fixture(t);
    input.outputDirectory = path.join(root, 'kit with spaces');
    const kit = assembleRelinkKit(input);
    const modified = path.join(root, 'modified source with spaces');
    cpSync(input.sourceDirectory, modified, { recursive: true });
    const recipe = JSON.parse(readFileSync(input.sourcePinsFile, 'utf8'));
    for (const pin of recipe.files) {
      const source = path.join(modified, pin.path);
      writeFileSync(source, readFileSync(source, 'utf8').replace('return 1;', 'return 2;'));
    }
    const originalLibrary = readFileSync(path.join(root, 'archive/lib/v8.lib'));
    const library = cached ? file('cached library with spaces/v8.lib', originalLibrary) : undefined;
    const { tools, commands, execute } = fakeTools(root, library);
    const output = path.join(root, 'output with spaces');
    const result = buildRelinkKit(input.outputDirectory, modified, output, tools, execute);
    const removal = commands.findIndex(({ args }) =>
      args.some((arg) => arg.startsWith('/REMOVE:')),
    );
    const addition = commands.findIndex(
      ({ args }) =>
        args.includes(path.join(output, 'v8.without-glibc.lib')) &&
        !args.some((arg) => arg.startsWith('/REMOVE:')),
    );
    assert(removal >= 0 && addition > removal);
    assert.equal(commands.filter(({ tool }) => tool === tools.tar).length, cached ? 0 : 1);
    for (const command of commands) assert(command.tool.includes('tool paths with spaces'));
    if (library) {
      assert.deepEqual(
        readFileSync(library),
        originalLibrary,
        'cached upstream library stays unchanged',
      );
      for (const command of commands.filter(({ args }) =>
        args.some((arg) => arg.startsWith('/EXTRACT:')),
      ))
        assert(command.args.includes(library), 'LIB consumes the cached path directly');
    }
    const dll = readFileSync(path.join(output, 'oliphaunt_wee8.dll'));
    assert.equal(result.dllSha256, sha(dll));
    assert.deepEqual(
      gunzipSync(
        Buffer.concat(
          kit.roles.parts.map((name) =>
            readFileSync(path.join(result.crates[name], 'payload/dll.gz.part')),
          ),
        ),
      ),
      dll,
    );
    assert(
      readFileSync(
        path.join(result.crates[kit.roles.api], 'prebuilt/embedded_bindings.rs'),
        'utf8',
      ).includes(sha(dll)),
    );
    const config = Bun.TOML.parse(
      readFileSync(path.join(output, '.cargo/config.toml'), 'utf8'),
    ) as any;
    assert.deepEqual(
      Object.keys(config.patch['crates-io']).sort(),
      [kit.roles.api, kit.roles.facade, ...kit.roles.parts].sort(),
    );
    assert.deepEqual(verifyRelinkKit(input.outputDirectory), kit);
  });
}

test('cached library size and hash are verified before any compiler or archive tool runs', (t) => {
  const { input, root, file } = fixture(t);
  assembleRelinkKit(input);
  const original = readFileSync(path.join(root, 'archive/lib/v8.lib'));
  for (const [label, bytes, expected] of [
    ['size', Buffer.concat([original, Buffer.from('extra')]), /Wee8 library size mismatch/u],
    ['hash', Buffer.from(original).fill(0), /Wee8 library hash mismatch/u],
  ] as const) {
    const { tools, execute, commands } = fakeTools(root, file(`${label}/v8.lib`, bytes));
    assert.throws(
      () =>
        buildRelinkKit(
          input.outputDirectory,
          input.sourceDirectory,
          path.join(root, `out-${label}`),
          tools,
          execute,
        ),
      expected,
    );
    assert.equal(commands.length, 0);
  }
});

test('real Cargo archives assemble into a closed kit with physical source, object archive and exact carrier inputs', (t) => {
  const { input } = fixture(t);
  const kit = assembleRelinkKit(input);
  assert.equal(Object.keys(kit.crates).length, 7);
  assert.deepEqual(verifyRelinkKit(input.outputDirectory), kit);
  assert.deepEqual(
    readFileSync(path.join(input.outputDirectory, 'upstream/v8-windows-amd64.tar.xz')),
    readFileSync(input.upstreamArchiveFile),
  );
  for (const [name, relative] of Object.entries(kit.crates))
    assert.deepEqual(
      readFileSync(path.join(input.outputDirectory, relative)),
      readFileSync(input.crates[name]),
    );
  const command = path.join(input.outputDirectory, 'src/wasix/runtime/engine/relink.mts');
  const result = spawnSync(process.execPath, [command], { encoding: 'utf8' });
  assert.match(
    result.stderr,
    /usage: relink.mts/u,
    'bundled relative generator import resolves without repository files',
  );
  assert.doesNotMatch(result.stderr, /Cannot find module/u);
  assert.throws(() => assembleRelinkKit(input), /Output already exists/u);
});

test('modified DLL regenerates its cache identity and payloads while keeping private Cargo patches confined to owned names', (t) => {
  const { input, root, dll, file } = fixture(t);
  const kit = assembleRelinkKit(input);
  const crates = extractCrates(input, path.join(root, 'extracted'));
  const modified = Buffer.concat([dll, Buffer.from('changed linked code')]);
  const output = path.join(root, 'result');
  installRelinkedDll(kit, input.outputDirectory, crates, file('modified.dll', modified), output);
  const restored = gunzipSync(
    Buffer.concat(
      kit.roles.parts.map((name) => readFileSync(path.join(crates[name], 'payload/dll.gz.part'))),
    ),
  );
  assert.deepEqual(restored, modified);
  const embedded = readFileSync(
    path.join(crates[kit.roles.api], 'prebuilt/embedded_bindings.rs'),
    'utf8',
  );
  assert(embedded.includes(sha(modified)));
  assert(!embedded.includes(sha(dll)));
  const config = Bun.TOML.parse(
    readFileSync(path.join(output, '.cargo/config.toml'), 'utf8'),
  ) as any;
  assert.deepEqual(
    Object.keys(config.patch['crates-io']).sort(),
    [kit.roles.api, kit.roles.facade, ...kit.roles.parts].sort(),
  );
  assert(!Object.hasOwn(config.patch['crates-io'], 'wasmer'));
  for (const [name, patch] of Object.entries(config.patch['crates-io']))
    assert.equal((patch as any).path, crates[name]);
  assert.deepEqual(
    verifyRelinkKit(input.outputDirectory),
    kit,
    'the immutable release kit stays unchanged',
  );
});

test('source, archive, export and package version drift fail before producing a kit', (t) => {
  const { input, file } = fixture(t);
  assert.throws(
    () => assembleRelinkKit({ ...input, upstreamArchiveFile: file('wrong.tar.xz', 'wrong') }),
    /Wee8 archive hash mismatch/u,
  );
  assert.throws(
    () => assembleRelinkKit({ ...input, version: '9.9.9' }),
    /Unexpected Cargo archive member/u,
  );
  assert.throws(
    () =>
      assembleRelinkKit({ ...input, glue: { ...input.glue, exports: file('wrong.def', 'wrong') } }),
    /DLL exports differ/u,
  );
  const pins = JSON.parse(readFileSync(input.sourcePinsFile, 'utf8'));
  file(`source/${pins.files[0].path}`, 'source drift');
  assert.throws(() => assembleRelinkKit(input), /Relink source hash mismatch/u);
});

test('a valid crate envelope with a stale API engine identity cannot enter the relink asset', (t) => {
  const { input, root, file } = fixture(t);
  const crates = extractCrates(input, path.join(root, 'extracted'));
  const api = 'oliphaunt-wasmer';
  writeFileSync(
    path.join(crates[api], 'prebuilt/embedded_bindings.rs'),
    '// stale engine digest\n',
  );
  const stale = file(
    'stale-api.crate',
    gzipSync(
      createDeterministicTar(crates[api], `${api}-${version}`, { includeDirectories: false }),
    ),
  );
  assert.throws(
    () => assembleRelinkKit({ ...input, crates: { ...input.crates, [api]: stale } }),
    /Published API does not bind the published DLL/u,
  );
});

test('unsafe members, missing carrier closure and output/input overlap are rejected', (t) => {
  const { input, root, file } = fixture(t);
  const [name] = Object.keys(input.crates);
  const stage = path.join(root, 'malicious');
  file('malicious/Cargo.toml', 'untrusted archive member');
  const malicious = file(
    'malicious.crate',
    gzipSync(createDeterministicTar(stage, '../escape', { includeDirectories: false })),
  );
  assert.throws(
    () => assembleRelinkKit({ ...input, crates: { ...input.crates, [name]: malicious } }),
    /portable-archive/u,
  );
  const fewer = { ...input.crates };
  delete fewer[name];
  assert.throws(() => assembleRelinkKit({ ...input, crates: fewer }), /all seven actual/u);
  assert.throws(
    () =>
      assembleRelinkKit({ ...input, outputDirectory: path.join(input.sourceDirectory, 'output') }),
    /Output overlaps/u,
  );
});

test('kit file tampering or an added file is rejected before any tool is executed', (t) => {
  const { input, root, file } = fixture(t);
  assembleRelinkKit(input);
  const clone = path.join(root, 'clone');
  cpSync(input.outputDirectory, clone, { recursive: true });
  writeFileSync(path.join(clone, 'glue/bridge.cc'), 'tampered');
  assert.throws(
    () =>
      buildRelinkKit(clone, input.sourceDirectory, path.join(root, 'out'), {
        tar: 'must-not-execute',
        clangCl: '',
        cl: '',
        lib: '',
        link: '',
      }),
    /Relink kit hash mismatch/u,
  );
  file('kit/unexpected.txt', 'unexpected');
  assert.throws(() => verifyRelinkKit(input.outputDirectory), /inventory differs/u);
});
