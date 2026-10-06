import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { archiveTreeDigest, sha256File } from '../../../../third-party/tools/source-fetch-core.mts';
import { renderDispatch, renderExports, V8_FLAGS } from './dispatch.mts';
import { ENGINE_SOURCE_CRATES } from '../contract.mts';

const root = path.resolve(import.meta.dir, '../../../../..');
const owner = path.join(root, 'src/wasix/runtime/engine');
const pins = Bun.TOML.parse(readFileSync(path.join(owner, 'source.toml'), 'utf8'));
const inputs = path.join(root, 'target/oliphaunt-wasix/engine/inputs');
const output = path.join(root, 'target/oliphaunt-wasix/engine/windows-x64-msvc');
const inputNames = ['wee8-windows', 'v8-header', 'v8-license'];

function verify(name: string, file: string) {
  assert(inputNames.includes(name), `unknown engine input ${name}`);
  assert.equal(statSync(file).size, pins[name].bytes, `${name}: incorrect byte size`);
  assert.equal(sha256File(file), pins[name].sha256, `${name}: checksum mismatch`);
}

function run(command: string[]) {
  const result = Bun.spawnSync(command, { cwd: output, stdout: 'inherit', stderr: 'inherit' });
  assert.equal(result.exitCode, 0, `engine producer failed: ${command[0]}`);
}

function build() {
  assert.equal(process.platform, 'win32', 'the native engine producer requires Windows x64 MSVC');
  assert.equal(process.arch, 'x64');
  for (const name of inputNames) verify(name, path.join(inputs, name));
  const header = path.join(owner, 'crates/wasmer/upstream/third-party/wee8/wasm.h');
  assert.equal(
    sha256File(header),
    '97f49de5418f02c55633dbcdc96b72fb404659c9275e9a47a3b4d6bdce384b96',
    'regenerate C bindings for the pinned header',
  );
  mkdirSync(output, { recursive: true });
  const archive = path.join(inputs, 'wee8-windows');
  const library = path.join(output, 'v8.lib');
  const pin = pins['wee8-windows'];
  if (
    !existsSync(library) ||
    statSync(library).size !== pin['member-bytes'] ||
    sha256File(library) !== pin['member-sha256']
  ) {
    const extracted = Bun.spawnSync(['tar', '-xOf', archive, '--', pin.member], {
      stdout: Bun.file(library),
      stderr: 'inherit',
    });
    assert.equal(extracted.exitCode, 0, 'extract pinned V8 static archive');
    assert.equal(statSync(library).size, pin['member-bytes']);
    assert.equal(sha256File(library), pin['member-sha256']);
  }
  copyFileSync(path.join(inputs, 'v8-header'), path.join(output, 'wasm.hh'));
  copyFileSync(path.join(inputs, 'v8-license'), path.join(output, 'LICENSE.v8'));
  const msvc = path.join(process.env.VCToolsInstallDir ?? '', 'bin/HostX64/x64');
  const compiler = path.join(msvc, 'cl.exe'),
    linker = path.join(msvc, 'link.exe');
  assert(existsSync(compiler) && existsSync(linker), 'initialize the existing MSVC environment');
  const { symbols } = renderDispatch('0'.repeat(64));
  writeFileSync(path.join(output, 'engine.def'), renderExports(symbols));
  run([
    compiler,
    '/nologo',
    '/c',
    '/O2',
    '/MT',
    '/EHsc',
    '/std:c++20',
    `/I${output}`,
    path.join(import.meta.dir, 'bridge.cpp'),
    `/Fo${path.join(output, 'bridge.obj')}`,
  ]);
  run([
    linker,
    '/NOLOGO',
    '/DLL',
    '/Brepro',
    `/OUT:${path.join(output, 'oliphaunt_wee8.dll')}`,
    `/DEF:${path.join(output, 'engine.def')}`,
    `/IMPLIB:${path.join(output, 'oliphaunt_wee8.lib')}`,
    path.join(output, 'bridge.obj'),
    library,
    'winmm.lib',
    'dbghelp.lib',
    'shlwapi.lib',
  ]);
  writeFileSync(
    path.join(output, 'profile.h'),
    `#define OLIPHAUNT_V8_FLAGS ${JSON.stringify(V8_FLAGS)}\n`,
  );
  run([
    compiler,
    '/nologo',
    '/c',
    '/O2',
    '/GS-',
    '/Zl',
    `/I${output}`,
    path.join(import.meta.dir, 'cache-producer.c'),
    `/Fo${path.join(output, 'cache-producer.obj')}`,
  ]);
  run([
    linker,
    '/nologo',
    '/nodefaultlib',
    '/machine:x64',
    '/entry:mainCRTStartup',
    '/subsystem:console',
    '/Brepro',
    path.join(output, 'cache-producer.obj'),
    'kernel32.lib',
    path.join(output, 'oliphaunt_wee8.lib'),
    `/out:${path.join(output, 'cache-producer.exe')}`,
  ]);
  const dll = path.join(output, 'oliphaunt_wee8.dll');
  const digest = sha256File(dll);
  const prebuilt = path.join(owner, 'crates/wasmer/prebuilt');
  mkdirSync(prebuilt, { recursive: true });
  const bindings = path.join(prebuilt, 'embedded_bindings.rs');
  writeFileSync(bindings, renderDispatch(digest).generated);
  run(['rustfmt', '--edition', '2024', bindings]);
  writeFileSync(
    path.join(output, 'source.json'),
    JSON.stringify(
      {
        source: pins,
        engineSources: Object.fromEntries(
          ENGINE_SOURCE_CRATES.map((name) => [
            name,
            archiveTreeDigest(path.join(owner, 'crates', name, 'upstream')),
          ]),
        ),
        sourceSha: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root })
          .stdout.toString()
          .trim(),
        dllSha256: digest,
        bindingsSha256: sha256File(bindings),
        flags: V8_FLAGS,
        entries: symbols.length,
      },
      null,
      2,
    ) + '\n',
  );
}

if (import.meta.main) {
  const [operation, name, file] = Bun.argv.slice(2);
  if (operation === 'acquisition-plan' && !name) {
    for (const input of inputNames) console.log(`${input}\t${pins[input].url}`);
  } else if (operation === 'verify-input' && name && file) {
    try {
      verify(name, file);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (operation === 'build' && !name) build();
  else throw new Error('usage: build.mts acquisition-plan | verify-input NAME FILE | build');
}
