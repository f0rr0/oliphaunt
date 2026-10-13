import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { requiredModules } from '../../../src/wasix/postmaster/lib/guest-build-provenance.mts';
import {
  validateGuestProducer,
  validateImportedGuestReceipt,
  writeAotModuleOutputs,
} from './guest-inputs.mts';
import { canonicalJson, digest, nativeGuestReceipt } from './native-receipts.mts';

type Spec = Parameters<typeof validateImportedGuestReceipt>[1];
const linuxTriple = 'x86_64-unknown-linux-gnu';
const identity = (bytes: string | Uint8Array) => ({
  sha256: digest(bytes),
  size: Buffer.byteLength(bytes),
});

function fixture(root: string): { spec: Spec; receipt: any } {
  const put = (relative: string, bytes: string) => {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return file;
  };
  const postgresql = {
    version: '18.4',
    url: 'https://example.test/postgresql-18.4.tar.bz2',
    sha256: digest('immutable PostgreSQL archive'),
  };
  const libcSource = {
    commit: 'c'.repeat(40),
    sha256: digest('immutable WASIX libc archive'),
    strip_prefix: 'wasix-libc',
    url: 'https://example.test/wasix-libc.tar.gz',
  };
  const patches = {
    'src/postgres/first.patch': put('patches/first.patch', 'first patch bytes'),
    'src/postgres/second.patch': put('patches/second.patch', 'second patch bytes'),
  };
  const overlays = {
    'src/port/wasix.h': put('overlays/wasix.h', 'WASIX port header'),
    'src/backend/wasix.c': put('overlays/wasix.c', 'WASIX backend overlay'),
  };
  const configuration = {
    'pg_config.h': put('configuration/pg_config.h', '#define EXEC_BACKEND 1\n'),
    'pg_config_os.h': put('configuration/pg_config_os.h', '#define WASIX_CORE 1\n'),
  };
  const spec: Spec = {
    source: put(
      'source.toml',
      `[postgresql]\n${Object.entries(postgresql)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join('\n')}\n`,
    ),
    series: put('series', `# Canonical ordered patches\n${Object.keys(patches).join('\n')}\n`),
    patches,
    overlays,
    configuration,
    libcSource: put('libc-source.json', `${JSON.stringify(libcSource)}\n`),
    libcPatch: put('libc.patch', 'canonical WASIX libc patch bytes'),
  };
  const fileIdentity = (file: string) => identity(readFileSync(file));
  const receipt = {
    schema: 'oliphaunt.wasix-postmaster.guest-build.native.v1',
    source: {
      postgresql,
      patches: Object.entries(patches).map(([path, file]) => ({ path, ...fileIdentity(file) })),
      overlays: Object.entries(overlays)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, file]) => ({ path, ...fileIdentity(file) })),
    },
    configuration: Object.fromEntries(
      Object.entries(configuration).map(([name, file]) => [name, fileIdentity(file)]),
    ),
    sysroot: {
      schema: 'oliphaunt.wasix-postmaster.libc.native.v1',
      source: libcSource,
      patch_sha256: fileIdentity(spec.libcPatch).sha256,
      closure_sha256: digest('original Linux construction sysroot closure'),
    },
    compiler: identity('original Linux construction Clang bytes'),
    core_profile: 'release-o3',
    postgres_version: postgresql.version,
    installed_closure_sha256: digest('original installed module closure'),
    atomic_fence_total: 995,
    final_wasm_concurrency_receipt_sha256: digest('original final concurrency receipt'),
    linear_memory_install_receipt_sha256: digest('original linear memory receipt'),
  };
  return { spec, receipt };
}

function withFixture(run: (value: ReturnType<typeof fixture>) => void) {
  const root = mkdtempSync(join(tmpdir(), 'postmaster-guest-inputs-'));
  try {
    run(fixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('imported guest binds declared inputs and preserves original Linux construction provenance', () =>
  withFixture(({ spec, receipt }) => {
    const bytes = `${canonicalJson(receipt)}\n`;
    for (const input of [bytes, Buffer.from(bytes)]) {
      const actual = validateImportedGuestReceipt(input, spec);
      assert.deepEqual(actual, receipt);
      assert.deepEqual(actual.compiler, identity('original Linux construction Clang bytes'));
      assert.equal(
        actual.sysroot.closure_sha256,
        digest('original Linux construction sysroot closure'),
      );
    }
    assert.deepEqual(
      validateImportedGuestReceipt(bytes, {
        ...spec,
        patches: Object.fromEntries(Object.entries(spec.patches).reverse()),
        overlays: Object.fromEntries(Object.entries(spec.overlays).reverse()),
        configuration: Object.fromEntries(Object.entries(spec.configuration).reverse()),
      }),
      receipt,
    );
  }));

test('structurally valid guest receipts reject stale source, patches, overlays, configuration and libc', () => {
  const cases: [string, (receipt: any) => void][] = [
    [
      'source archive',
      (value) => {
        value.source.postgresql.sha256 = digest('foreign PostgreSQL archive');
      },
    ],
    [
      'source URL',
      (value) => {
        value.source.postgresql.url = 'https://example.test/foreign.tar.bz2';
      },
    ],
    [
      'source version',
      (value) => {
        value.source.postgresql.version = value.postgres_version = '18.5';
      },
    ],
    [
      'patch order',
      (value) => {
        value.source.patches.reverse();
      },
    ],
    [
      'patch bytes',
      (value) => {
        value.source.patches[0].sha256 = digest('foreign patch bytes');
      },
    ],
    [
      'patch size',
      (value) => {
        value.source.patches[0].size += 1;
      },
    ],
    [
      'missing patch',
      (value) => {
        value.source.patches.pop();
      },
    ],
    [
      'foreign patch',
      (value) => {
        value.source.patches[0].path = 'src/postgres/foreign.patch';
      },
    ],
    [
      'overlay bytes',
      (value) => {
        value.source.overlays[0].sha256 = digest('foreign overlay bytes');
      },
    ],
    [
      'missing overlay',
      (value) => {
        value.source.overlays.pop();
      },
    ],
    [
      'foreign overlay',
      (value) => {
        value.source.overlays[0].path = 'src/port/foreign.h';
      },
    ],
    [
      'configuration bytes',
      (value) => {
        value.configuration['pg_config.h'].sha256 = digest('foreign config bytes');
      },
    ],
    [
      'configuration size',
      (value) => {
        value.configuration['pg_config.h'].size += 1;
      },
    ],
    [
      'missing configuration',
      (value) => {
        delete value.configuration['pg_config_os.h'];
      },
    ],
    [
      'extra configuration',
      (value) => {
        value.configuration['foreign.h'] = identity('foreign config');
      },
    ],
    [
      'libc source',
      (value) => {
        value.sysroot.source.commit = 'd'.repeat(40);
      },
    ],
    [
      'libc patch',
      (value) => {
        value.sysroot.patch_sha256 = digest('foreign libc patch');
      },
    ],
  ];
  for (const [name, mutate] of cases)
    withFixture(({ spec, receipt }) => {
      mutate(receipt);
      nativeGuestReceipt(receipt);
      assert.throws(() => validateImportedGuestReceipt(canonicalJson(receipt), spec), name);
    });
});

test('unchanged receipt rejects changed declared bytes and incomplete or foreign input maps', () => {
  const replaceSameSize = (file: string) => {
    const original = readFileSync(file);
    writeFileSync(file, Buffer.alloc(original.length, 0x78));
  };
  const cases: [string, (spec: Spec) => void][] = [
    ['patch bytes', (spec) => replaceSameSize(spec.patches['src/postgres/first.patch'])],
    ['overlay bytes', (spec) => replaceSameSize(spec.overlays['src/backend/wasix.c'])],
    ['configuration bytes', (spec) => replaceSameSize(spec.configuration['pg_config.h'])],
    ['libc patch bytes', (spec) => replaceSameSize(spec.libcPatch)],
    [
      'canonical series order',
      (spec) => writeFileSync(spec.series, `${Object.keys(spec.patches).reverse().join('\n')}\n`),
    ],
    [
      'duplicate canonical patch',
      (spec) =>
        writeFileSync(
          spec.series,
          `${Object.keys(spec.patches).join('\n')}\n${Object.keys(spec.patches)[0]}\n`,
        ),
    ],
    [
      'missing declared patch',
      (spec) => {
        delete spec.patches['src/postgres/second.patch'];
      },
    ],
    [
      'extra declared patch',
      (spec) => {
        spec.patches['src/postgres/foreign.patch'] = spec.patches['src/postgres/first.patch'];
      },
    ],
    [
      'missing declared overlay',
      (spec) => {
        delete spec.overlays['src/port/wasix.h'];
      },
    ],
    [
      'extra declared configuration',
      (spec) => {
        spec.configuration['foreign.h'] = spec.configuration['pg_config.h'];
      },
    ],
    [
      'canonical source version',
      (spec) =>
        writeFileSync(spec.source, readFileSync(spec.source, 'utf8').replace('18.4', '18.5')),
    ],
    [
      'canonical libc source',
      (spec) => {
        const source = JSON.parse(readFileSync(spec.libcSource, 'utf8'));
        source.sha256 = digest('another canonical libc archive');
        writeFileSync(spec.libcSource, JSON.stringify(source));
      },
    ],
  ];
  for (const [name, mutate] of cases)
    withFixture(({ spec, receipt }) => {
      mutate(spec);
      assert.throws(() => validateImportedGuestReceipt(canonicalJson(receipt), spec), name);
    });
});

test('import rejects legacy and wrong receipt schemas', () =>
  withFixture(({ spec, receipt }) => {
    for (const input of [
      'schema=oliphaunt.wasix-postmaster.guest-build.v5\ncore_profile=release-o3\n',
      canonicalJson({ ...receipt, schema: 'oliphaunt.wasix-postmaster.guest-build.v5' }),
      canonicalJson({ ...receipt, schema: 'oliphaunt.wasix-postmaster.executor-build.native.v1' }),
    ])
      assert.throws(() => validateImportedGuestReceipt(input, spec));
  }));

function producer(target = linuxTriple) {
  const contract = {
    schema: 'oliphaunt.wasix-postmaster.runtime-abi.native.v2',
    artifact_abi_version: 21,
    source: { wasmer: { commit: 'a'.repeat(40) } },
    lock_sha256: digest('producer Cargo lock bytes'),
    rust: { target },
    roles: Object.fromEntries(
      ['executor', 'compiler'].map((role) => [
        role,
        {
          features: [`product-${role}`],
          dependencies: [{ id: 'wasmer 7.2.0-alpha.2' }, { id: 'wasmer-wasix 0.702.0-alpha.2' }],
        },
      ]),
    ),
  };
  return { ...contract, runtime_abi_id: digest(canonicalJson(contract)) };
}

test('guest producer requires the canonical Linux x64 ABI rather than a foreign or stale contract', () => {
  validateGuestProducer(producer(), linuxTriple);
  for (const target of ['aarch64-unknown-linux-gnu', 'aarch64-apple-darwin'])
    assert.throws(() => validateGuestProducer(producer(target), linuxTriple));
  assert.throws(() =>
    validateGuestProducer(producer('aarch64-unknown-linux-gnu'), 'aarch64-unknown-linux-gnu'),
  );
  const stale = producer();
  stale.rust.target = 'aarch64-unknown-linux-gnu';
  assert.throws(() => validateGuestProducer(stale, linuxTriple));
  assert.throws(() =>
    validateGuestProducer(
      { ...producer(), schema: 'oliphaunt.wasix-postmaster.runtime-abi.v1' },
      linuxTriple,
    ),
  );
});

test('scalar AOT outputs preserve the canonical final bytes without unrelated tree metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'postmaster-aot-output-'));
  try {
    const tree = join(root, 'tree');
    for (const relative of requiredModules) {
      const file = join(tree, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    }
    const metadata = join(tree, 'share/postgresql/receipt.json');
    mkdirSync(dirname(metadata), { recursive: true });
    writeFileSync(metadata, '{"receipt":1}');
    const project = (name: string) => {
      const outputs = Object.fromEntries(
        requiredModules.map((relative) => [relative, join(root, name, relative)]),
      );
      writeAotModuleOutputs(tree, requiredModules, outputs);
      return Object.fromEntries(
        Object.entries(outputs).map(([relative, file]) => [relative, identity(readFileSync(file))]),
      );
    };
    const before = project('before');
    writeFileSync(metadata, '{"receipt":2}');
    assert.deepEqual(project('metadata-only'), before);
    writeFileSync(join(tree, 'bin/initdb'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 1, 0]));
    const changed = project('own-module');
    assert.notDeepEqual(changed['bin/initdb'], before['bin/initdb']);
    for (const relative of requiredModules.filter((path) => path !== 'bin/initdb'))
      assert.deepEqual(changed[relative], before[relative]);
    const outputs = Object.fromEntries(
      requiredModules.map((relative) => [relative, join(root, 'invalid', relative)]),
    );
    const missing = { ...outputs };
    delete missing['bin/postgres'];
    assert.throws(() => writeAotModuleOutputs(tree, requiredModules, missing), /outputs differ/);
    assert.throws(
      () =>
        writeAotModuleOutputs(tree, requiredModules, {
          ...outputs,
          foreign: join(root, 'foreign'),
        }),
      /outputs differ/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
