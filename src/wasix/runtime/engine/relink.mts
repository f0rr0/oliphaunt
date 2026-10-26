import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  embeddedBindings,
  exportsDefinition,
} from '../../../../build_defs/wasix/engine/generate.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../../tools/packaging/portable-archive.mts';

type Pin = { path: string; sha256: string; url: string };
type Recipe = {
  v8Commit: string;
  files: Pin[];
  objects: { source: string; member: string; sha256: string }[];
  compilerArguments: string[];
};
type Roles = { api: string; facade: string; parts: string[] };
type Kit = {
  version: string;
  files: Record<string, string>;
  crates: Record<string, string>;
  roles: Roles;
};
export type RelinkTools = {
  /** Optional already-extracted upstream library; its size and digest are still verified. */
  library?: string;
  tar?: string;
  clangCl: string;
  cl: string;
  lib: string;
  link: string;
};
export interface RelinkInputs {
  version: string;
  sourcePinsFile: string;
  enginePinsFile: string;
  sourceDirectory: string;
  upstreamArchiveFile: string;
  glue: {
    bridge: string;
    header: string;
    exports: string;
    bindings: string;
    generator: string;
    loader: string;
    buildScript: string;
  };
  crates: Record<string, string>;
  noticesFile: string;
  outputDirectory: string;
}

const helperPath = 'src/wasix/runtime/engine/relink.mts';
const generatorPath = 'build_defs/wasix/engine/generate.mts';
const archiveHelperPath = 'tools/packaging/portable-archive.mts';
const gluePaths = {
  bridge: 'glue/bridge.cc',
  header: 'glue/wasm.hh',
  exports: 'glue/oliphaunt_wee8.def',
  bindings: 'glue/v8_bindings.rs',
  generator: generatorPath,
  loader: 'glue/embedded-engine.rs',
  buildScript: 'glue/build.rs.tpl',
} as const;
const archivePath = 'upstream/v8-windows-amd64.tar.xz';

function safePath(value: string): string {
  assert(value && !/[\\:\r\n\0]/u.test(value) && !value.startsWith('/'), `Unsafe path: ${value}`);
  assert(
    value.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Unsafe path: ${value}`,
  );
  return value;
}

function hash(file: string): string {
  assert(lstatSync(realpathSync(file)).isFile(), `Not a regular file: ${file}`);
  const digest = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      digest.update(buffer.subarray(0, size));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

function write(file: string, bytes: string | Uint8Array) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function run(tool: string, args: string[]): Buffer {
  const result = spawnSync(tool, args, { maxBuffer: 128 * 1024 * 1024 });
  assert(
    !result.error && result.status === 0,
    `${tool} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  return result.stdout;
}

function checkCrate(archive: string, name: string, version: string) {
  assert.match(name, /^oliphaunt-[a-z0-9-]+$/u, 'Only owned Cargo identities belong in the kit');
  const prefix = `${name}-${version}`;
  // Declared Bazel inputs may be sandbox symlinks; validate their actual archive bytes.
  const entries = readPortableArchiveEntries(realpathSync(archive), { format: 'tar.gz' });
  for (const name of entries.keys()) {
    const normalized = name.replace(/\/$/u, '');
    assert(
      normalized.startsWith(`${prefix}/`) || normalized === prefix,
      `Unexpected Cargo archive member: ${name}`,
    );
  }
  const manifestEntry = entries.get(`${prefix}/Cargo.toml`);
  assert(manifestEntry?.isFile, `Missing regular Cargo manifest: ${name}`);
  const manifest = Bun.TOML.parse(manifestEntry.data().toString()) as any;
  assert(
    manifest.package?.name === name && manifest.package.version === version,
    `Cargo identity/version mismatch: ${name}`,
  );
  return { manifest, entries };
}

function freshOutput(output: string, inputs: string[]) {
  assert(!existsSync(output), `Output already exists: ${output}`);
  for (const input of inputs) {
    const relative = path.relative(path.resolve(output), path.resolve(input));
    assert(
      relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
      'Output overlaps an input',
    );
    if (lstatSync(realpathSync(input)).isDirectory()) {
      const reverse = path.relative(path.resolve(input), path.resolve(output));
      assert(
        reverse.startsWith(`..${path.sep}`) || path.isAbsolute(reverse),
        'Output overlaps an input',
      );
    }
  }
  mkdirSync(output, { recursive: true });
}

function walk(directory: string, prefix = ''): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(directory, name);
      const stat = lstatSync(file);
      assert(
        stat.isFile() || stat.isDirectory(),
        `Kit must contain only regular files: ${relative}`,
      );
      return stat.isDirectory() ? walk(file, relative) : [safePath(relative)];
    });
}

/** Stage the exact published crates and the physical source/object materials they use. */
export function assembleRelinkKit(input: RelinkInputs): Kit {
  const recipe = JSON.parse(readFileSync(input.sourcePinsFile, 'utf8')) as Recipe;
  const engine = JSON.parse(readFileSync(input.enginePinsFile, 'utf8'));
  assert(recipe.v8Commit === engine.wee8.v8.commit, 'Relink source and binary pins disagree');
  assert.equal(hash(input.upstreamArchiveFile), engine.wee8.sha256, 'Wee8 archive hash mismatch');
  assert.equal(
    lstatSync(realpathSync(input.upstreamArchiveFile)).size,
    engine.wee8.bytes,
    'Wee8 archive size mismatch',
  );
  assert.equal(hash(input.glue.header), engine.wee8.header.sha256, 'Wee8 C++ header hash mismatch');
  assert.equal(
    hash(input.glue.generator),
    hash(
      fileURLToPath(new URL('../../../../build_defs/wasix/engine/generate.mts', import.meta.url)),
    ),
    'The bundled binding generator differs from the assembler generator',
  );
  const bindings = readFileSync(input.glue.bindings, 'utf8');
  assert.equal(
    readFileSync(input.glue.exports, 'utf8'),
    exportsDefinition(bindings),
    'DLL exports differ from the declared bindings',
  );
  const archives = Object.fromEntries(
    Object.entries(input.crates).map(([name, file]) => [
      name,
      checkCrate(file, name, input.version),
    ]),
  );
  const manifests = Object.fromEntries(
    Object.entries(archives).map(([name, archive]) => [name, archive.manifest]),
  );
  assert.equal(
    Object.keys(manifests).length,
    7,
    'The relink kit requires all seven actual engine Cargo archives',
  );
  const sources = Object.values(manifests).filter(
    (manifest) => manifest.package.metadata?.oliphaunt?.upstream,
  );
  assert.deepEqual(
    sources.map((manifest) => manifest.package.metadata.oliphaunt.upstream.package).sort(),
    Object.keys(engine.crates).sort(),
    'Engine source carrier closure differs from source pins',
  );
  const api = sources.find(
    (manifest) => manifest.package.metadata.oliphaunt.upstream.package === 'wasmer',
  )?.package.name;
  assert(api, 'Missing maintained API crate');
  const facadeNames = Object.keys(manifests[api]['build-dependencies'] ?? {}).filter(
    (name) => input.crates[name],
  );
  assert.equal(facadeNames.length, 1, 'API must have one owned engine delivery dependency');
  const facade = facadeNames[0];
  const parts = Object.keys(manifests[facade].dependencies ?? {})
    .filter((name) => input.crates[name])
    .sort();
  assert.deepEqual(
    parts,
    [`${facade}-part-001`, `${facade}-part-002`],
    'Unexpected engine payload parts',
  );
  const roles = { api, facade, parts };
  const member = (name: string, relative: string): Buffer => {
    const entry = archives[name].entries.get(`${name}-${input.version}/${relative}`);
    assert(entry?.isFile, `Missing regular Cargo member: ${name}/${relative}`);
    return entry.data();
  };
  const dll = gunzipSync(Buffer.concat(parts.map((name) => member(name, 'payload/dll.gz.part'))));
  assert.equal(
    member(api, 'prebuilt/embedded_bindings.rs').toString(),
    embeddedBindings(bindings, readFileSync(input.glue.loader, 'utf8'), dll),
    'Published API does not bind the published DLL bytes',
  );
  assert.deepEqual(
    member(api, 'build.rs'),
    readFileSync(input.glue.buildScript),
    'Published API build script differs',
  );
  const notices = readFileSync(input.noticesFile);
  assert(notices.length, 'Missing engine notices');
  for (const name of Object.keys(input.crates))
    assert.deepEqual(member(name, 'THIRD_PARTY_NOTICES.md'), notices, `${name} notices differ`);
  for (const pin of recipe.files)
    assert.equal(
      hash(path.join(input.sourceDirectory, safePath(pin.path))),
      pin.sha256,
      `Relink source hash mismatch: ${pin.path}`,
    );
  const output = input.outputDirectory;
  freshOutput(output, [
    input.sourceDirectory,
    input.upstreamArchiveFile,
    ...Object.values(input.glue),
    ...Object.values(input.crates),
    input.noticesFile,
    input.sourcePinsFile,
    input.enginePinsFile,
  ]);
  function copy(source: string, relative: string) {
    const destination = path.join(output, safePath(relative));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  try {
    copy(input.upstreamArchiveFile, archivePath);
    copy(input.enginePinsFile, 'sources.json');
    copy(input.sourcePinsFile, 'relink.json');
    copy(input.noticesFile, 'THIRD_PARTY_NOTICES.md');
    copy(fileURLToPath(import.meta.url), helperPath);
    copy(
      fileURLToPath(new URL('../../../../tools/packaging/portable-archive.mts', import.meta.url)),
      archiveHelperPath,
    );
    for (const [key, relative] of Object.entries(gluePaths)) copy(input.glue[key], relative);
    for (const pin of recipe.files)
      copy(path.join(input.sourceDirectory, pin.path), `source/${pin.path}`);
    const crates = Object.fromEntries(
      Object.entries(input.crates).map(([name, file]) => {
        const relative = `crates/${name}-${input.version}.crate`;
        copy(file, relative);
        return [name, relative];
      }),
    );
    write(path.join(output, 'README.md'), instructions(input.version));
    const files = Object.fromEntries(
      walk(output).map((relative) => [relative, hash(path.join(output, relative))]),
    );
    const kit = { version: input.version, files, crates, roles };
    write(path.join(output, 'kit.json'), `${JSON.stringify(kit, null, 2)}\n`);
    return kit;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

export function verifyRelinkKit(directory: string): Kit {
  const kit = JSON.parse(readFileSync(path.join(directory, 'kit.json'), 'utf8')) as Kit;
  assert.deepEqual(
    walk(directory).filter((file) => file !== 'kit.json'),
    Object.keys(kit.files).sort(),
    'Relink kit file inventory differs',
  );
  for (const [relative, expected] of Object.entries(kit.files))
    assert.equal(
      hash(path.join(directory, safePath(relative))),
      expected,
      `Relink kit hash mismatch: ${relative}`,
    );
  return kit;
}

/** Regenerate the cache identity and the two delivery parts for a modified DLL. */
export function installRelinkedDll(
  kit: Kit,
  kitDirectory: string,
  crateDirectories: Record<string, string>,
  dllFile: string,
  output: string,
) {
  const dll = readFileSync(dllFile);
  write(
    path.join(crateDirectories[kit.roles.api], 'prebuilt/embedded_bindings.rs'),
    embeddedBindings(
      readFileSync(path.join(kitDirectory, gluePaths.bindings), 'utf8'),
      readFileSync(path.join(kitDirectory, gluePaths.loader), 'utf8'),
      dll,
    ),
  );
  const compressed = gzipSync(dll, { level: 9 });
  const midpoint = Math.ceil(compressed.length / 2);
  for (const [index, name] of kit.roles.parts.entries())
    write(
      path.join(crateDirectories[name], 'payload/dll.gz.part'),
      compressed.subarray(index * midpoint, (index + 1) * midpoint),
    );
  const patched = [kit.roles.api, kit.roles.facade, ...kit.roles.parts];
  assert(
    patched.every((name) => /^oliphaunt-[a-z0-9-]+$/u.test(name) && kit.crates[name]),
    'Private patches must use owned engine Cargo identities',
  );
  write(
    path.join(output, '.cargo/config.toml'),
    `[patch.crates-io]\n${patched.map((name) => `${JSON.stringify(name)} = { path = ${JSON.stringify(path.resolve(crateDirectories[name]))} }`).join('\n')}\n`,
  );
}

/** Run in an x64 Native Tools environment; no network or V8/GN rebuild is needed. */
export function buildRelinkKit(
  directory: string,
  modifiedSourceDirectory: string,
  output: string,
  tools: RelinkTools,
  execute = run,
) {
  const kit = verifyRelinkKit(directory);
  const engine = JSON.parse(readFileSync(path.join(directory, 'sources.json'), 'utf8'));
  const recipe = JSON.parse(readFileSync(path.join(directory, 'relink.json'), 'utf8')) as Recipe;
  freshOutput(output, [
    directory,
    modifiedSourceDirectory,
    ...(tools.library ? [tools.library] : []),
  ]);
  const original = path.join(output, 'original');
  mkdirSync(original);
  const library = tools.library
    ? path.resolve(tools.library)
    : path.join(original, engine.wee8.library.path);
  if (!tools.library) {
    assert(tools.tar, 'Provide the cached upstream library or an explicit tar tool');
    execute(tools.tar, [
      '-xf',
      path.join(directory, archivePath),
      '-C',
      original,
      safePath(engine.wee8.library.path),
    ]);
  }
  assert.equal(
    lstatSync(realpathSync(library)).size,
    engine.wee8.library.bytes,
    'Wee8 library size mismatch',
  );
  assert.equal(hash(library), engine.wee8.library.sha256, 'Wee8 library hash mismatch');
  const replacement = path.join(output, 'replacement');
  mkdirSync(replacement);
  const sourceHashes: Record<string, string> = {};
  for (const pin of recipe.files.filter((pin) => pin.path.startsWith('third_party/glibc/src/'))) {
    const source = path.join(modifiedSourceDirectory, safePath(pin.path));
    sourceHashes[pin.path] = hash(source);
    const destination = path.join(replacement, pin.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  const objects = recipe.objects.map((object) => {
    const originalObject = path.join(original, path.basename(object.member));
    execute(tools.lib, ['/NOLOGO', `/EXTRACT:${object.member}`, `/OUT:${originalObject}`, library]);
    assert.equal(
      hash(originalObject),
      object.sha256,
      `Original object hash mismatch: ${object.member}`,
    );
    const replacementObject = path.join(replacement, path.basename(object.member));
    execute(tools.clangCl, [
      ...recipe.compilerArguments,
      `/Fo${replacementObject}`,
      path.join(replacement, safePath(object.source)),
    ]);
    return replacementObject;
  });
  const stripped = path.join(output, 'v8.without-glibc.lib');
  execute(tools.lib, [
    '/NOLOGO',
    `/OUT:${stripped}`,
    ...recipe.objects.map((object) => `/REMOVE:${object.member}`),
    library,
  ]);
  const relinked = path.join(output, 'v8.relinked.lib');
  // LIB removes after combining inputs; replacements must be added in a separate invocation.
  execute(tools.lib, ['/NOLOGO', `/OUT:${relinked}`, stripped, ...objects]);
  const bridge = path.join(output, 'bridge.obj');
  execute(tools.cl, [
    '/nologo',
    '/c',
    '/MT',
    '/O2',
    '/EHsc',
    '/std:c++20',
    `/I${path.join(directory, 'glue')}`,
    `/Fo${bridge}`,
    path.join(directory, gluePaths.bridge),
  ]);
  const dll = path.join(output, 'oliphaunt_wee8.dll');
  execute(tools.link, [
    '/NOLOGO',
    '/DLL',
    '/MACHINE:X64',
    '/INCREMENTAL:NO',
    `/OUT:${dll}`,
    `/DEF:${path.join(directory, gluePaths.exports)}`,
    bridge,
    relinked,
    'winmm.lib',
    'dbghelp.lib',
    'shlwapi.lib',
  ]);
  const crates: Record<string, string> = {};
  for (const [name, relative] of Object.entries(kit.crates)) {
    crates[name] = path.join(output, 'crates', `${name}-${kit.version}`);
    extractPortableArchiveTree(
      path.join(directory, safePath(relative)),
      crates[name],
      `${name}-${kit.version}`,
    );
  }
  installRelinkedDll(kit, directory, crates, dll, output);
  const result = { version: kit.version, dllSha256: hash(dll), sourceHashes, crates };
  write(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function instructions(version: string): string {
  return `# Windows V8 relink materials for oliphaunt-wasix ${version}\n\nThis kit contains the original pinned Wee8 archive (including the original COFF objects), the exact glibc sources and notices, fdlibm source mappings, the bridge and raw binding inputs, and all seven actual engine Cargo archives. The remaining V8 objects are retained unchanged.\n\nUse Windows x64, Bun, LLVM clang-cl, and the Visual Studio x64 Native Tools environment with its C/C++ headers, Windows SDK and libraries. The three C files use GNU extensions supported by clang-cl. The C++ bridge and DLL use the MSVC ABI and release static CRT. No V8/GN source build or network download occurs.\n\n1. Verify the release asset checksum before extracting this kit.\n2. Copy the source directory outside the kit and modify the glibc C/header files there. Keep their paths.\n3. Write tools.json with explicit paths for clangCl, cl, lib and link. Set tar to an explicit tar executable, or set library to an already-extracted upstream v8.lib to avoid extracting it again. Its exact size and SHA-256 are always verified; the cached file is read without copying or modifying it. Use the x64 MSVC tools.\n4. Run: bun src/wasix/runtime/engine/relink.mts build KIT MODIFIED_SOURCE_DIRECTORY NEW_OUTPUT_DIRECTORY tools.json\n5. Build your Windows Cargo application with: cargo --config NEW_OUTPUT_DIRECTORY/.cargo/config.toml test --target x86_64-pc-windows-msvc\n\nThe command verifies immutable kit files, extracts and checks the original object hashes, compiles the three replacement objects, removes originals before adding replacements, relinks the DLL, regenerates its API cache digest, and replaces both compressed payload parts. The private Cargo config patches only the four owned API/delivery identities. It does not patch stock Wasmer names or change registry dependencies. result.json records the modified sources and DLL hashes. Run your application's runtime and exception tests against the resulting DLL; command success alone does not establish runtime compatibility.\n\nThe source/member mappings and exact pins are in relink.json and sources.json. Full applicable notices are in THIRD_PARTY_NOTICES.md and in every Cargo archive.\n`;
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'assemble' && args.length === 1)
    assembleRelinkKit(JSON.parse(readFileSync(args[0], 'utf8')));
  else if (mode === 'build' && args.length === 4)
    buildRelinkKit(
      args[0],
      args[1],
      path.resolve(args[2]),
      JSON.parse(readFileSync(args[3], 'utf8')),
    );
  else
    throw new Error(
      'usage: relink.mts assemble SPEC.json | build KIT MODIFIED_SOURCE_DIRECTORY OUTPUT_DIRECTORY TOOLS.json',
    );
}
