import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { NativeCurrentArtifact } from '../../tools/release/native-extension-final-inputs.mts';
import {
  type ConstructorKind,
  constructorName,
  projectConstructorInputs,
} from './constructor-inputs.mts';

function row(kind: ConstructorKind, label: string): NativeCurrentArtifact {
  return {
    product: 'liboliphaunt-wasix',
    version: '1.2.3',
    artifact: `constructor:${constructorName(kind, label)}`,
    configuration: kind === 'module' ? 'portable' : 'windows-x64-msvc',
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    file: {
      path: `@oliphaunt_metadata//:native-current-artifacts/liboliphaunt-wasix/1.2.3/${'c'.repeat(64)}/postgres.wasix.wasm`,
      size: 1234,
      sha256: 'c'.repeat(64),
      producer: {
        evidenceDigest: `sha256:${'d'.repeat(64)}`,
        invocationId: 'original-linux-invocation',
        root: '//src/wasix/runtime:original_constructor_shipping',
        configuration: 'e'.repeat(64),
        output: 'bazel-out/wasm32-fastbuild/bin/src/wasix/runtime/postgres/postgres.wasix.wasm',
      },
    },
  };
}
function current(...rows: NativeCurrentArtifact[]) {
  return Object.fromEntries(
    rows.map((entry) => [`${entry.product}/${entry.version}/${entry.artifact}`, entry]),
  );
}

test('source-only work needs no snapshot; foreign and final phases require it', () => {
  assert.deepEqual(projectConstructorInputs('source', null), {
    phase: 'source',
    modules: {},
    aotImages: {},
  });
  for (const phase of ['windows-v8', 'package']) {
    assert.throws(() => projectConstructorInputs(phase, null), /current-source snapshot/);
    assert.equal(projectConstructorInputs(phase, {}).phase, phase);
  }
  assert.throws(() => projectConstructorInputs('windows', {}), /Unknown WASIX constructor phase/);
});

test('routing retains complete original source/producer facts and ignores public carriers', () => {
  const module = row('module', '//src/wasix/runtime:postgres');
  const image = row('aot', '//src/wasix/runtime:aot_windows_x64_msvc_postgres');
  image.file.producer.invocationId = 'original-windows-invocation';
  const published = { ...module, artifact: 'cargo:liboliphaunt-wasix-portable' };
  const other = { ...module, artifact: 'constructor:apple-private-input' };
  const inputs = current(module, image, published, other);
  const before = structuredClone(inputs);
  for (const phase of ['source', 'windows-v8', 'package']) {
    assert.deepEqual(projectConstructorInputs(phase, inputs), {
      phase,
      modules: { '//src/wasix/runtime:postgres': module },
      aotImages: { '//src/wasix/runtime:aot_windows_x64_msvc_postgres': image },
    });
  }
  assert.deepEqual(inputs, before);
});

test('private names are injective and round-trip special characters without a second decoding pass', () => {
  assert.equal(
    constructorName('module', '//src/a_u+b/c:thing_s'),
    'wasix-module-src_sa_uu_pb_sc_cthing_us',
  );
  let seed = 0x735ab;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = 'abc_usp+.-012';
  const word = () => Array.from({ length: 9 }, () => alphabet[next() % alphabet.length]).join('');
  const labels = new Set<string>();
  for (let index = 0; index < 250; index++) labels.add(`//src/${word()}/${word()}:${word()}`);
  labels.add('//:root_target');
  const rows = [...labels].flatMap((label) => [row('module', label), row('aot', label)]);
  assert.equal(new Set(rows.map((entry) => entry.artifact)).size, rows.length);
  const projected = projectConstructorInputs('package', current(...rows));
  assert.deepEqual(Object.keys(projected.modules).sort(), [...labels].sort());
  assert.deepEqual(Object.keys(projected.aotImages).sort(), [...labels].sort());
});

test('ambiguous sources, noncanonical identities and nonoriginal imports fail', () => {
  const original = row('module', '//src/wasix/runtime:postgres');
  const secondOwner = { ...original, product: 'postgres-tools-wasix' };
  assert.throws(
    () => projectConstructorInputs('package', current(original, secondOwner)),
    /Constructor source repeats/,
  );
  for (const artifact of [
    'constructor:wasix-other-src_cpostgres',
    'constructor:wasix-module-src_cbad_qescape',
    'constructor:wasix-module-src_s.._ctarget',
  ])
    assert.throws(() => projectConstructorInputs('package', current({ ...original, artifact })));
  for (const label of ['src:target', '//src//bad:target', '//../src:target', '//src:'])
    assert.throws(() => constructorName('module', label));
  const member = structuredClone(original);
  member.file.member = 'archive/member.wasm';
  assert.throws(() => projectConstructorInputs('package', current(member)), /whole original File/);
  const local = structuredClone(original);
  local.file.path = '/tmp/unverified.wasm';
  assert.throws(
    () => projectConstructorInputs('package', current(local)),
    /verified metadata File alias/,
  );
  assert.throws(
    () =>
      projectConstructorInputs(
        'package',
        current({ ...original, configuration: 'windows-x64-msvc' }),
      ),
    /Portable constructor configuration differs/,
  );
});

test('repository projector CLI consumes the existing metadata map without acquiring or rewriting Files', (t) => {
  const directory = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'wasix-constructors-'),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'current.json');
  const output = path.join(directory, 'inputs.json');
  const inputs = current(row('module', '//src/wasix/runtime:postgres'));
  writeFileSync(input, JSON.stringify(inputs));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./constructor-inputs.mts', import.meta.url)),
      'windows-v8',
      input,
      output,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(output, 'utf8')),
    projectConstructorInputs('windows-v8', inputs),
  );
});
