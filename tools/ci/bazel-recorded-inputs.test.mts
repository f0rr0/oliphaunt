import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectBazelRecordedSourceInputs,
  IncompleteBazelRecordedInputsError,
} from './bazel-recorded-inputs.mts';

// RepoRecordedInput.escape/WithValue and GsonTypeAdapterUtil's string adapter,
// pinned at https://github.com/bazelbuild/bazel/tree/8.8.1/src/main/java/com/google/devtools/build/lib.
const escapeRecorded = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(' ', '\\s');
const record = (kind: string, key: string, value = 'ignored') =>
  `${kind}:${escapeRecorded(key)} ${escapeRecorded(value)}`;
const row = (recordedInputs: string[], generatedNames = ['fixture']) => ({
  recordedInputs,
  generatedRepoSpecs: Object.fromEntries(generatedNames.map((name) => [name, {}])),
  bzlTransitiveDigest: 'ignored',
  usagesDigest: 'ignored',
});
const lock = (recordedInputs: string[] = [], generatedNames = ['fixture']) => ({
  lockFileVersion: 28,
  moduleExtensions: {
    '//build_defs:acquire.bzl%inputs': { general: row(recordedInputs, generatedNames) },
  },
});

async function fixture(
  run: (f: {
    workspaceRoot: string;
    outputBase: string;
    repositories: string[];
    source: (value: unknown) => void;
    hidden: (value: unknown) => void;
    marker: (name: string, records: string[]) => void;
  }) => Promise<void>,
) {
  const root = mkdtempSync(path.join(tmpdir(), 'bazel-recorded-inputs-'));
  const workspaceRoot = path.join(root, 'source with spaces');
  const outputBase = path.join(root, 'output');
  mkdirSync(workspaceRoot);
  mkdirSync(path.join(outputBase, 'external'), { recursive: true });
  writeFileSync(path.join(workspaceRoot, '.bazelversion'), '8.8.1\n');
  const source = (value: unknown) =>
    writeFileSync(path.join(workspaceRoot, 'MODULE.bazel.lock'), JSON.stringify(value));
  const hidden = (value: unknown) =>
    writeFileSync(path.join(outputBase, 'MODULE.bazel.lock'), JSON.stringify(value));
  source(lock());
  hidden(lock());
  writeFileSync(path.join(outputBase, 'external/@+inputs+fixture.marker'), `${'a'.repeat(64)}\n`);
  try {
    await run({
      workspaceRoot,
      outputBase,
      repositories: ['+inputs+fixture'],
      source,
      hidden,
      marker: (name, records) => {
        writeFileSync(
          path.join(outputBase, 'external', `@${name}.marker`),
          `${'a'.repeat(64)}\n${records.join('\n')}\n`,
        );
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('unions both lock locations and recursively follows acquisition-only external inputs', async () => {
  await fixture(async (f) => {
    f.repositories = ['+inputs+product', '+inputs+product'];
    f.source(
      lock(
        [record('FILE', '@@//src/version.toml'), record('FILE', '@@metadata+//model.json')],
        ['product'],
      ),
    );
    f.hidden(
      lock(
        [
          record('DIRTREE', '//src/resources'),
          record('DIRENTS', '//src/extensions'),
          record('FILE', '@@//src/version.toml'),
        ],
        ['product'],
      ),
    );
    f.marker('+inputs+product', [
      record('FILE', '@@//patches/compiler.patch'),
      record('DIRTREE', '@@metadata+//catalog'),
    ]);
    f.marker('metadata+', [
      record('FILE', '//src/model.toml'),
      record('DIRENTS', '@@metadata-helper+//metadata'),
    ]);
    f.marker('metadata-helper+', [record('FILE', '//src/manifest with space.toml')]);
    assert.deepEqual(await collectBazelRecordedSourceInputs(f), {
      files: [
        'patches/compiler.patch',
        'src/manifest with space.toml',
        'src/model.toml',
        'src/version.toml',
      ],
      trees: ['src/resources'],
      directories: ['src/extensions'],
    });
  });
});

test('unused extension rows do not broaden a configured request', async () => {
  await fixture(async (f) => {
    f.hidden({ lockFileVersion: 28, moduleExtensions: {} });
    f.source({
      lockFileVersion: 28,
      moduleExtensions: {
        '//defs:inputs.bzl%inputs': { general: row([record('FILE', '//used')]) },
        '//defs:unrelated.bzl%unrelated': {
          general: row([record('DIRTREE', '//'), record('FILE', '@@unfetched+//secret')]),
        },
      },
    });
    assert.deepEqual(await collectBazelRecordedSourceInputs(f), {
      files: ['used'],
      trees: [],
      directories: [],
    });
  });
});

test('generated names distinguish extension-name digits from collision ordinals', async () => {
  await fixture(async (f) => {
    f.repositories = ['+ext2+output'];
    f.marker('+ext2+output', []);
    f.source({
      lockFileVersion: 28,
      moduleExtensions: {
        '//defs:one.bzl%ext': { general: row([record('FILE', '//collision')], ['other']) },
        '//defs:two.bzl%ext2': { general: row([record('FILE', '//exact')], ['output']) },
        '//defs:three.bzl%ext3': { general: row([record('FILE', '//unused')]) },
      },
    });
    assert.deepEqual((await collectBazelRecordedSourceInputs(f)).files, ['exact']);
  });
});

test('one reached hub binds all shared names to its sibling extension without fetching unused metadata', async () => {
  await fixture(async (f) => {
    const missing = '+_repo_rules9+wasix_adapter_cargo_metadata';
    const adapter = [
      'shared',
      'adapter_hub',
      ...Array.from({ length: 491 }, (_, i) => `adapter_${i}`),
    ];
    const postmaster = [
      'shared',
      'postmaster_hub',
      ...Array.from({ length: 824 }, (_, i) => `postmaster_${i}`),
    ];
    f.source({
      lockFileVersion: 28,
      moduleExtensions: {
        '//defs:adapter.bzl%crate': {
          general: row([record('FILE', `@@${missing}//Cargo.toml`)], adapter),
        },
        '//defs:postmaster.bzl%crate': {
          general: row([record('FILE', '@@postmaster_metadata+//Cargo.toml')], postmaster),
        },
      },
    });
    f.repositories = ['+crate3+shared', '+crate3+postmaster_hub'];
    for (const name of f.repositories) f.marker(name, []);
    f.marker('postmaster_metadata+', [
      record('FILE', '//src/postmaster/Cargo.toml'),
      record('DIRTREE', '//src/postmaster/assets'),
      record('DIRENTS', '//src/postmaster/manifests'),
    ]);
    assert.deepEqual(await collectBazelRecordedSourceInputs(f), {
      files: ['src/postmaster/Cargo.toml'],
      trees: ['src/postmaster/assets'],
      directories: ['src/postmaster/manifests'],
    });
    f.repositories = ['+crate3+shared', '+crate3+adapter_hub'];
    f.marker('+crate3+adapter_hub', []);
    await assert.rejects(collectBazelRecordedSourceInputs(f), {
      name: 'IncompleteBazelRecordedInputsError',
      message: `Missing or unreadable Bazel recorded source input: repository marker @${missing} (ENOENT)`,
    });
  });
});

test('unresolved same-name sibling repositories fail closed', async () => {
  await fixture(async (f) => {
    f.repositories = ['+crate3+shared'];
    f.marker('+crate3+shared', []);
    f.source({
      lockFileVersion: 28,
      moduleExtensions: {
        '//defs:one.bzl%crate': { general: row([record('FILE', '//one')], ['shared']) },
        '//defs:two.bzl%crate': { general: row([record('FILE', '//two')], ['shared']) },
      },
    });
    await assert.rejects(collectBazelRecordedSourceInputs(f), /Ambiguous used module extension/u);
  });
});

test('reached marker fan-in can disambiguate a shared name before the fixpoint closes', async () => {
  await fixture(async (f) => {
    f.repositories = ['+crate3+shared'];
    f.marker('+crate3+shared', [record('FILE', '@@+crate3+postmaster_hub//metadata')]);
    f.marker('+crate3+postmaster_hub', []);
    f.source({
      lockFileVersion: 28,
      moduleExtensions: {
        '//defs:adapter.bzl%crate': {
          general: row([record('FILE', '@@unused+//metadata')], ['shared', 'adapter_hub']),
        },
        '//defs:postmaster.bzl%crate': {
          general: row([record('FILE', '//postmaster')], ['shared', 'postmaster_hub']),
        },
      },
    });
    assert.deepEqual((await collectBazelRecordedSourceInputs(f)).files, ['postmaster']);
  });
});

test('one extension identity cannot authenticate two canonical unique prefixes', async () => {
  await fixture(async (f) => {
    f.repositories = ['+crate3+shared', '+crate4+shared'];
    for (const name of f.repositories) f.marker(name, []);
    f.source({
      lockFileVersion: 28,
      moduleExtensions: {
        '//defs:one.bzl%crate': { general: row([], ['shared']) },
      },
    });
    await assert.rejects(collectBazelRecordedSourceInputs(f), /conflicting canonical prefixes/u);
  });
});

test('missing or malformed generated-repository names remain unknown', async () => {
  for (const generated of [
    '',
    ',"generatedRepoSpecs":[]',
    ',"generatedRepoSpecs":{}',
    ',"generatedRepoSpecs":{"fixture":{}},"generatedRepoSpecs":{"fixture":{}}',
    ',"generatedRepoSpecs":{"fixture":{},"fixture":{}}',
    ',"generatedRepoSpecs":{"bad/name":{}}',
    ',"generatedRepoSpecs":{"..":{}}',
  ])
    await fixture(async (f) => {
      writeFileSync(
        path.join(f.workspaceRoot, 'MODULE.bazel.lock'),
        `{"lockFileVersion":28,"moduleExtensions":{"//defs:inputs.bzl%inputs":{"general":{"recordedInputs":[]${generated}}}}}`,
      );
      f.hidden({ lockFileVersion: 28, moduleExtensions: {} });
      await assert.rejects(collectBazelRecordedSourceInputs(f), IncompleteBazelRecordedInputsError);
    });
});

test('metadata repository reads activate transitive extension inputs to a fixpoint', async () => {
  await fixture(async (f) => {
    f.hidden({ lockFileVersion: 28, moduleExtensions: {} });
    f.source({
      lockFileVersion: 28,
      moduleExtensions: {
        '@@metadata+//defs:acquire.bzl%next': {
          general: row([record('FILE', '//transitive')], ['data']),
        },
        '//defs:inputs.bzl%inputs': {
          general: row([record('FILE', '@@metadata++next+data//metadata')]),
        },
      },
    });
    f.marker('metadata++next+data', [record('FILE', '//marker')]);
    assert.deepEqual((await collectBazelRecordedSourceInputs(f)).files, ['marker', 'transitive']);
  });
});

test('used isolated or missing extension rows fail closed; innate rows use actual markers', async () => {
  await fixture(async (f) => {
    f.repositories = ['+_ext+out'];
    f.marker('+_ext+out', []);
    f.source({
      lockFileVersion: 28,
      moduleExtensions: { '//defs:e.bzl%ext%isolation': { general: row([]) } },
    });
    await assert.rejects(collectBazelRecordedSourceInputs(f), /isolated/u);
  });
  await fixture(async (f) => {
    f.repositories = ['mod++missing+out'];
    f.marker('mod++missing+out', []);
    await assert.rejects(collectBazelRecordedSourceInputs(f), /persisted/u);
  });
  await fixture(async (f) => {
    f.repositories = ['mod++_repo_rules2+out'];
    f.marker('mod++_repo_rules2+out', [record('FILE', '//definition')]);
    assert.deepEqual((await collectBazelRecordedSourceInputs(f)).files, ['definition']);
  });
});

test('repository cycles are visited once without losing source inputs', async () => {
  await fixture(async (f) => {
    f.repositories = ['one+'];
    f.marker('one+', [record('FILE', '@@two+//x')]);
    f.marker('two+', [record('FILE', '@@one+//x'), record('FILE', '//input.txt')]);
    assert.deepEqual((await collectBazelRecordedSourceInputs(f)).files, ['input.txt']);
  });
});

test('does not decode secret values, arbitrary attributes or facts, including across stream chunks', async () => {
  await fixture(async (f) => {
    const secret = 'SYNTHETIC_SECRET_DO_NOT_DECODE';
    const large = `${'x'.repeat(70_000)}${secret}\\n ${'y'.repeat(70_000)}`;
    const sourceLock = lock(
      [
        record('ENV', 'TOKEN', large),
        record('REPO_MAPPING', ',dep', secret),
        record('FILE', '//safe'),
      ],
      ['secret'],
    );
    sourceLock.moduleExtensions[
      '//build_defs:acquire.bzl%inputs'
    ].general.generatedRepoSpecs.secret = {
      attributes: { [secret]: [large, null, true, 123.4] },
    };
    f.source({
      ...sourceLock,
      facts: { [secret]: { attributes: [large, null, true, false, 123.4] } },
    });
    f.hidden(lock([record('ENV', 'OTHER', large)], ['secret']));
    f.repositories = ['+inputs+secret'];
    f.marker('+inputs+secret', [
      record('ENV', 'TOKEN', large),
      record('FILE', '//also-safe', large),
    ]);
    const original = Buffer.prototype.toString;
    const originalJsonParse = JSON.parse;
    Buffer.prototype.toString = function (...args) {
      assert.equal(
        this.includes(Buffer.from(secret)),
        false,
        'ignored private bytes reached string decoding',
      );
      return original.apply(this, args);
    };
    JSON.parse = (text, reviver) => {
      assert.equal(text.includes(secret), false, 'ignored private bytes reached JSON decoding');
      return originalJsonParse(text, reviver);
    };
    try {
      const result = await collectBazelRecordedSourceInputs(f);
      assert.deepEqual(result, { files: ['also-safe', 'safe'], trees: [], directories: [] });
      assert.equal(JSON.stringify(result).includes(secret), false);
    } finally {
      Buffer.prototype.toString = original;
      JSON.parse = originalJsonParse;
    }
  });
});

test('includes current host and general evaluation factors, excluding foreign host rows', async () => {
  await fixture(async (f) => {
    f.repositories = ['+ext+host'];
    f.marker('+ext+host', []);
    const os =
      process.platform === 'darwin'
        ? 'mac os x'
        : process.platform === 'win32'
          ? 'windows 11'
          : process.platform;
    const arch =
      process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
    f.source({
      lockFileVersion: 28,
      moduleExtensions: {
        '//defs:extension.bzl%ext': {
          general: row([record('FILE', '//general')], ['host']),
          [`os:${os},arch:${arch}`]: row([record('FILE', '//host')], ['host']),
          'os:foreign host,arch:unavailable': row([record('FILE', '@@not-fetched-foreign+//x')]),
        },
      },
    });
    assert.deepEqual((await collectBazelRecordedSourceInputs(f)).files, ['general', 'host']);
  });
});

test('a used extension needs a matched persisted row, including collision candidates', async () => {
  await fixture(async (f) => {
    f.repositories = ['+ext2+host'];
    f.marker('+ext2+host', []);
    f.source({
      lockFileVersion: 28,
      moduleExtensions: {
        '//defs:e.bzl%ext': { general: row([], ['other']) },
        '//defs:e.bzl%ext2': { 'os:foreign host': row([record('FILE', '//omitted')], ['host']) },
      },
    });
    await assert.rejects(collectBazelRecordedSourceInputs(f), /current-host/u);
    f.hidden({
      lockFileVersion: 28,
      moduleExtensions: { '//defs:e.bzl%ext2': { general: row([], ['host']) } },
    });
    assert.deepEqual(await collectBazelRecordedSourceInputs(f), {
      files: [],
      trees: [],
      directories: [],
    });
  });
});

test('absolute source paths normalize; outside-workspace host observations are not source paths', async () => {
  await fixture(async (f) => {
    f.source(
      lock([
        record('FILE', path.join(f.workspaceRoot, 'src/one')),
        record('DIRTREE', path.join(f.workspaceRoot, 'src/tree')),
        record('FILE', path.join(f.outputBase, 'host SDK/input')),
      ]),
    );
    assert.deepEqual(await collectBazelRecordedSourceInputs(f), {
      files: ['src/one'],
      trees: ['src/tree'],
      directories: [],
    });
  });
});

test('missing referenced repository markers reject an incomplete basis', async () => {
  await fixture(async (f) => {
    f.hidden(
      lock([
        record('ENV', 'PRIVATE_NAME', 'PRIVATE_RECORDED_VALUE'),
        record('FILE', '@@missing+//metadata'),
      ]),
    );
    await assert.rejects(collectBazelRecordedSourceInputs(f), {
      name: 'IncompleteBazelRecordedInputsError',
      message:
        'Missing or unreadable Bazel recorded source input: repository marker @missing+ (ENOENT)',
    });
  });
});

test('only pinned stock builtin repositories can lack fetch markers', async () => {
  await fixture(async (f) => {
    f.repositories = ['bazel_tools', '_builtins'];
    assert.deepEqual(await collectBazelRecordedSourceInputs(f), {
      files: [],
      trees: [],
      directories: [],
    });
    f.repositories.push('arbitrary_override');
    await assert.rejects(collectBazelRecordedSourceInputs(f), IncompleteBazelRecordedInputsError);
  });
});

test('missing either lock or version pin rejects an incomplete basis', async () => {
  for (const [file, kind] of [
    ['MODULE.bazel.lock', 'workspace lock'],
    ['.bazelversion', 'version pin'],
    ['hidden', 'hidden lock'],
  ])
    await fixture(async (f) => {
      rmSync(
        file === 'hidden'
          ? path.join(f.outputBase, 'MODULE.bazel.lock')
          : path.join(f.workspaceRoot, file),
      );
      await assert.rejects(collectBazelRecordedSourceInputs(f), {
        name: 'IncompleteBazelRecordedInputsError',
        message: `Missing or unreadable Bazel recorded source input: ${kind} (ENOENT)`,
      });
    });
});

test('unexpected I/O errors withhold raw messages and unapproved codes', async () => {
  await fixture(async (f) => {
    await assert.rejects(
      collectBazelRecordedSourceInputs({
        ...f,
        workspaceRoot: `${f.workspaceRoot}\0PRIVATE_PATH_VALUE`,
      }),
      {
        name: 'IncompleteBazelRecordedInputsError',
        message: 'Missing or unreadable Bazel recorded source input: version pin (UNKNOWN)',
      },
    );
  });
});

test('malformed records retain their decoding diagnostic without revealing values', async () => {
  await fixture(async (f) => {
    writeFileSync(
      path.join(f.outputBase, 'MODULE.bazel.lock'),
      '{"lockFileVersion":28,"moduleExtensions":{},"facts":{"PRIVATE_NAME":"PRIVATE_VALUE\\x"}}',
    );
    await assert.rejects(collectBazelRecordedSourceInputs(f), {
      name: 'IncompleteBazelRecordedInputsError',
      message: 'Malformed Bazel lock escape',
    });
  });
});

test('wrong Bazel or lock formats cannot silently yield an empty basis', async () => {
  await fixture(async (f) => {
    writeFileSync(path.join(f.workspaceRoot, '.bazelversion'), '8.9.0\n');
    await assert.rejects(collectBazelRecordedSourceInputs(f), IncompleteBazelRecordedInputsError);
  });
  for (const value of [27, '28', 28.0 + 0.01])
    await fixture(async (f) => {
      f.hidden({ ...lock(), lockFileVersion: value });
      await assert.rejects(collectBazelRecordedSourceInputs(f), IncompleteBazelRecordedInputsError);
    });
});

test('malformed lock structures and missing extension records fail without exposing ignored data', async () => {
  const malformed = [
    '{}',
    '{"lockFileVersion":28}',
    '{"lockFileVersion":28,"moduleExtensions":[]}',
    '{"lockFileVersion":28,"moduleExtensions":{"//x:e.bzl%e":{"general":{}}}}',
    '{"lockFileVersion":28,"moduleExtensions":{},"facts":{"secret":"\\x"}}',
    '{"lockFileVersion":28,"moduleExtensions":{}} trailing',
    '{"lockFileVersion":28,"moduleExtensions":{},"lockFileVersion":28}',
    '{"lockFileVersion":28,"moduleExtensions":{"//x:e.bzl%e":{"unknown":{}}}}',
  ];
  for (const value of malformed)
    await fixture(async (f) => {
      writeFileSync(path.join(f.outputBase, 'MODULE.bazel.lock'), value);
      await assert.rejects(collectBazelRecordedSourceInputs(f), IncompleteBazelRecordedInputsError);
    });
});

test('malformed or unsupported recorded keys fail closed', async () => {
  for (const key of [
    'FILE://x',
    'FUTURE://x value',
    'FILE:relative value',
    'FILE://../escape value',
    'FILE:@@../x value',
    'FILE://x\\ value',
  ])
    await fixture(async (f) => {
      f.source(lock([key]));
      await assert.rejects(collectBazelRecordedSourceInputs(f), IncompleteBazelRecordedInputsError);
    });
});

test('invalid marker headers and separators fail closed', async () => {
  for (const content of ['', 'version:7\n', `${'a'.repeat(64)}\nFILE://input\n`])
    await fixture(async (f) => {
      f.repositories = ['invalid+'];
      writeFileSync(path.join(f.outputBase, 'external/@invalid+.marker'), content);
      await assert.rejects(collectBazelRecordedSourceInputs(f), IncompleteBazelRecordedInputsError);
    });
});

test('Gson key escapes are decoded separately from recorded-key escapes', async () => {
  await fixture(async (f) => {
    const content = JSON.stringify(lock([record('FILE', '//src/a space é.txt')]));
    writeFileSync(path.join(f.workspaceRoot, 'MODULE.bazel.lock'), content.replace('é', '\\u00e9'));
    assert.deepEqual((await collectBazelRecordedSourceInputs(f)).files, ['src/a space é.txt']);
  });
});

test('reader never modifies source or output-base observations', async () => {
  await fixture(async (f) => {
    const source = readFileSync(path.join(f.workspaceRoot, 'MODULE.bazel.lock'));
    const hidden = readFileSync(path.join(f.outputBase, 'MODULE.bazel.lock'));
    await collectBazelRecordedSourceInputs(f);
    assert.deepEqual(readFileSync(path.join(f.workspaceRoot, 'MODULE.bazel.lock')), source);
    assert.deepEqual(readFileSync(path.join(f.outputBase, 'MODULE.bazel.lock')), hidden);
  });
});

test('seeded mixed acquisition observations preserve exact source union regardless of order', async () => {
  let seed = 0x88128;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let scenario = 0; scenario < 24; scenario++)
    await fixture(async (f) => {
      const expected = {
        files: new Set<string>(),
        trees: new Set<string>(),
        directories: new Set<string>(),
      };
      const keys = ['FILE', 'DIRTREE', 'DIRENTS'] as const;
      const groups = {
        FILE: expected.files,
        DIRTREE: expected.trees,
        DIRENTS: expected.directories,
      };
      const source: string[] = [];
      const hidden: string[] = [];
      const external: string[] = [record('FILE', '@@cycle+//unused')];
      f.marker('cycle+', [record('FILE', '@@acquisition+//cycle')]);
      for (let i = 0; i < 32; i++) {
        const kind = keys[random() % keys.length];
        const name = `source/${random() % 13} input`;
        groups[kind].add(name);
        [source, hidden, external][random() % 3].push(
          record(kind, `@@//${name}`, `SYNTHETIC_VALUE_${random()}`),
        );
      }
      source.push(
        record('FILE', '@@acquisition+//metadata'),
        record('ENV', 'TOKEN', 'SYNTHETIC_SECRET'),
      );
      f.source(lock(source.reverse()));
      f.hidden(lock(hidden.reverse()));
      f.marker('acquisition+', external.reverse());
      assert.deepEqual(
        await collectBazelRecordedSourceInputs(f),
        Object.fromEntries(
          Object.entries(expected).map(([key, values]) => [key, [...values].sort()]),
        ),
      );
    });
});
