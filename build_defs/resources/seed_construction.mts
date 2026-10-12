/** A seed is immutable data; reuse requires the same concrete construction intent. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  emptyDirectoryPaths,
  filesystemTreeRows,
  logicalTreeSha256,
  validatePgdataDirectories,
} from '../../src/database-resources/contracts/native-manifest.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import type { CompletedPublication } from '../../tools/release/completed-release-publication.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';

export const SEED_CONSTRUCTION_SCHEMA = 'oliphaunt-seed-construction-v1';
export const SEED_CONSTRUCTION_RECEIPT_SUFFIX = '.seed-construction.json';
type FileIdentity = { size: number; sha256: string };
type DeclaredFile = FileIdentity & { path: string };
type Slot = { family: 'native' | 'wasix'; target: string; profile: 'standard' | 'icu' };
export type SeedConstructionIntent = Slot & {
  invocation: unknown;
  inputs: { name: string; members: unknown[] }[];
};

/** Bind semantic roles to the actual declared File, independent of its cache location. */
export function seedConstructionFileBinding(inputs: Record<string, string>, file: string) {
  const names = Object.entries(inputs)
    .filter(([, declared]) => path.resolve(declared) === path.resolve(file))
    .map(([name]) => name);
  assert.equal(names.length, 1, 'constructor role must name exactly one declared logical File');
  return names[0];
}

/** Only explicitly named execution locations are replaced, never input contents. */
export function seedConstructionInvocation(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  locations: Record<string, string>,
) {
  const mappings = Object.entries(locations).sort(
    ([, left], [, right]) => right.length - left.length,
  );
  const transport = (value: string) => {
    for (const [name, location] of mappings) {
      assert.ok(location, 'constructor execution location is required');
      value = value.replaceAll(location, `<${name}>`);
    }
    return value;
  };
  return {
    command: transport(command),
    arguments: arguments_.map(transport),
    environment: Object.fromEntries(
      Object.entries(environment)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([name, value]) => [name, transport(value)]),
    ),
  };
}
export type SeedReuseControl = {
  operation: 'reuse' | 'adopt';
  publication: CompletedPublication;
  archive: DeclaredFile;
  manifest: DeclaredFile;
  metadata?: DeclaredFile;
  /** Reviewed, immutable migration contract, distinct from old release metadata. */
  anchor?: DeclaredFile;
};
type Source = { commit: string; tree: string };
export type QualifiedSeedControl = {
  source: Source;
  evidenceDigest: string;
  invocationId: string;
  frozen: DeclaredFile;
  receipt: DeclaredFile;
  transition: { source: Source; updatesSha256: string };
};
export type SeedProducerIdentity = { postgresSha256: string; initdbSha256: string };
type SeedSourceManifest = FileIdentity & { contents: string; publication: CompletedPublication };
export type SeedConstructionReceipt = {
  schema: typeof SEED_CONSTRUCTION_SCHEMA;
  intent: SeedConstructionIntent;
  intentSha256: string;
  frozen: FileIdentity;
  pgdata: { treeSha256: string; emptyDirectories: string[] };
  /** A promoted seed retains its original constructor, qualified by the current runtime. */
  qualificationIntent?: SeedConstructionIntent;
  /** Desired seed contents; executable/tool provenance remains in intent. */
  contentIntent?: SeedConstructionIntent;
  contentIntentSha256?: string;
  qualificationContentIntent?: SeedConstructionIntent;
  /** The exact completed descriptor preserves creator facts for copied PGDATA. */
  sourceManifest?: SeedSourceManifest;
  origin:
    | { kind: 'constructed' }
    | {
        kind: 'completed-publication';
        operation: 'reused' | 'adopted';
        publication: CompletedPublication;
        archive: FileIdentity;
        manifest: FileIdentity;
        metadata?: FileIdentity;
        anchor?: FileIdentity & { source: Source; receiptSha256: string };
      }
    | {
        kind: 'qualified-construction';
        source: Source;
        evidenceDigest: string;
        invocationId: string;
        frozen: FileIdentity;
        receipt: FileIdentity;
        transition: QualifiedSeedControl['transition'];
      };
};

export const SEED_CONSTRUCTION_ANCHOR_SCHEMA = 'oliphaunt-seed-construction-anchor-v1';
export type SeedConstructionAnchor = {
  schema: typeof SEED_CONSTRUCTION_ANCHOR_SCHEMA;
  source: Source;
  publication: CompletedPublication;
  seeds: (Slot & {
    archive: FileIdentity;
    manifest: FileIdentity;
    receipt: FileIdentity & { contents: string };
    producer: {
      evidenceDigest: string;
      invocationId: string;
      root: string;
      configuration: string;
      output: string;
    };
  })[];
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
          .join(',')}}`
      : JSON.stringify(value);
const digest = (value: unknown) => sha256(Buffer.from(canonical(value)));
export const seedConstructionIntentSha256 = (intent: SeedConstructionIntent) => digest(intent);
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const physicalFile = (file: string) => fileIdentity(realpathSync(file));
const identity = ({ size, sha256 }: FileIdentity): FileIdentity => ({ size, sha256 });
const assertIdentity = (value: FileIdentity) => {
  assert.ok(Number.isSafeInteger(value?.size) && value.size > 0, 'seed identity needs size');
  assert.match(value.sha256, /^[a-f0-9]{64}$/u, 'seed identity needs SHA-256');
};
const safeName = (name: string) => {
  assert.ok(
    name &&
      !path.isAbsolute(name) &&
      !/[\\\u0000-\u001f\u007f]/u.test(name) &&
      !name.split('/').some((part) => !part || part === '.' || part === '..'),
    'seed constructor input requires a safe logical name',
  );
};

/** Physical names are transport locations; logical File names and all bytes remain exact. */
export function captureSeedConstructionIntent(
  slot: Slot,
  invocation: unknown,
  inputs: Record<string, string>,
): SeedConstructionIntent {
  assert.ok(['native', 'wasix'].includes(slot.family), 'seed family is required');
  assert.ok(['standard', 'icu'].includes(slot.profile), 'seed profile is required');
  safeName(slot.target);
  assert.ok(Object.keys(inputs).length > 0, 'seed construction must declare actual inputs');
  const records = Object.entries(inputs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, file]) => {
      safeName(name);
      const physical = realpathSync(file);
      const members: Record<string, unknown>[] = [];
      const visit = (file: string, name: string) => {
        const stat = lstatSync(file);
        assert.ok(!stat.isSymbolicLink(), 'constructor input tree must contain actual Files');
        if (stat.isDirectory()) {
          members.push({ path: name, type: 'directory' });
          for (const child of readdirSync(file).sort())
            visit(path.join(file, child), name ? `${name}/${child}` : child);
        } else {
          members.push({ path: name, type: 'file', ...identity(fileIdentity(file)) });
        }
      };
      // Cache read-only modes and checkout write bits do not describe seed intent.
      visit(physical, '');
      members.sort((left, right) => String(left.path).localeCompare(String(right.path)));
      assert.ok(members.length, 'constructor input must contain actual bytes');
      return { name, members };
    });
  return structuredClone({ ...slot, invocation, inputs: records });
}

/** Actual initdb bootstrap data, separate from runtime/tool implementation and version envelopes. */
export function captureSeedContentIntent(
  slot: Slot,
  invocation: unknown,
  share: string,
  icuData?: string,
) {
  const names = [
    'postgres.bki',
    'pg_hba.conf.sample',
    'pg_ident.conf.sample',
    'postgresql.conf.sample',
    'snowball_create.sql',
    'information_schema.sql',
    'sql_features.txt',
    'system_constraints.sql',
    'system_functions.sql',
    'system_views.sql',
  ];
  const control = path.join(share, 'extension/plpgsql.control');
  const versions = [
    ...readFileSync(control, 'utf8').matchAll(
      /^\s*default_version\s*=\s*'([A-Za-z0-9._-]+)'\s*(?:#.*)?$/gmu,
    ),
  ];
  assert.equal(versions.length, 1, 'initdb requires one declared plpgsql bootstrap version');
  const inputs = Object.fromEntries(
    names.map((name) => [`bootstrap/${name}`, path.join(share, name)]),
  );
  inputs['bootstrap/plpgsql.control'] = control;
  inputs['bootstrap/plpgsql.sql'] = path.join(share, `extension/plpgsql--${versions[0][1]}.sql`);
  if (icuData) inputs['icu/data'] = icuData;
  return captureSeedConstructionIntent(slot, invocation, inputs);
}

export function captureSeedProducerIdentity(runtime: string, target: string): SeedProducerIdentity {
  const suffix = target.startsWith('windows-') ? '.exe' : '';
  return {
    postgresSha256: physicalFile(path.join(runtime, 'bin', 'postgres' + suffix)).sha256,
    initdbSha256: physicalFile(path.join(runtime, 'bin', 'initdb' + suffix)).sha256,
  };
}

/** Current qualification never rewrites the identity of the data's creator. */
export function seedProducerIdentity(receipt: SeedConstructionReceipt): SeedProducerIdentity {
  let producer: SeedProducerIdentity;
  if (receipt.sourceManifest) {
    const manifest = JSON.parse(receipt.sourceManifest.contents);
    producer = {
      postgresSha256:
        receipt.intent.family === 'native'
          ? manifest.source?.postgresSha256
          : manifest.runtime?.producerSha256,
      initdbSha256:
        receipt.intent.family === 'native'
          ? manifest.source?.initdbSha256
          : manifest.runtime?.initdbSha256,
    };
  } else {
    assert.ok(
      receipt.origin.kind !== 'completed-publication',
      'copied seed lacks its original completed descriptor',
    );
    producer = (receipt.intent.invocation as any)?.producer;
  }
  assert.ok(producer, 'seed constructor lacks its original producer identity');
  for (const value of [producer.postgresSha256, producer.initdbSha256])
    assert.match(value, /^[a-f0-9]{64}$/u, 'seed original producer needs exact hashes');
  return { postgresSha256: producer.postgresSha256, initdbSha256: producer.initdbSha256 };
}

export function validateSeedConstructionReceipt(value: unknown): SeedConstructionReceipt {
  const receipt = value as SeedConstructionReceipt;
  assert.equal(receipt?.schema, SEED_CONSTRUCTION_SCHEMA, 'unsupported seed constructor receipt');
  assert.ok(
    receipt.intent && Array.isArray(receipt.intent.inputs),
    'missing seed constructor intent',
  );
  assert.ok(receipt.intent.inputs.length, 'empty seed constructor intent');
  assert.equal(
    receipt.intentSha256,
    digest(receipt.intent),
    'seed constructor intent digest differs',
  );
  assert.equal(
    Boolean(receipt.contentIntent),
    Boolean(receipt.contentIntentSha256),
    'seed content intent/digest must be paired',
  );
  if (receipt.contentIntent) {
    assert.ok(receipt.contentIntent.inputs.length, 'seed content intent requires actual inputs');
    assert.equal(
      receipt.contentIntentSha256,
      digest(receipt.contentIntent),
      'seed content intent digest differs',
    );
    assert.ok(
      ['family', 'target', 'profile'].every(
        (key) => receipt.contentIntent?.[key] === receipt.intent[key],
      ),
      'seed content intent slot differs',
    );
  }
  if (receipt.qualificationContentIntent) {
    assert.ok(
      receipt.origin.kind === 'qualified-construction' && receipt.contentIntent,
      'qualified seed content requires original content intent',
    );
    assert.ok(
      ['family', 'target', 'profile'].every(
        (key) => receipt.qualificationContentIntent?.[key] === receipt.intent[key],
      ),
      'qualified seed content slot differs',
    );
  }
  if (receipt.sourceManifest) {
    const original = receipt.sourceManifest;
    assert.deepEqual(Object.keys(original).sort(), ['contents', 'publication', 'sha256', 'size']);
    assertCompletedIdentity(original.publication);
    const contents = Buffer.from(original.contents);
    assert.deepEqual(
      identity(original),
      { size: contents.length, sha256: sha256(contents) },
      'seed original descriptor bytes differ',
    );
    const manifest = JSON.parse(original.contents);
    assert.equal(manifest.catalogProfile, receipt.intent.profile);
    assert.equal(manifest.runtime?.engineFamily, receipt.intent.family);
    assert.equal(manifest.runtime?.target, receipt.intent.target);
    assert.equal(manifest.runtime?.postgresMajor, 18);
    assert.ok(
      receipt.origin.kind !== 'constructed',
      'fresh seed cannot claim a completed descriptor',
    );
    if (receipt.origin.kind === 'completed-publication') {
      assert.deepEqual(original.publication, receipt.origin.publication);
      assert.deepEqual(identity(original), receipt.origin.manifest);
      assert.equal(
        manifest.archive?.sha256,
        receipt.origin.archive.sha256,
        'original descriptor archive digest differs',
      );
      assert.equal(
        manifest.archive?.compressedBytes,
        receipt.origin.archive.size,
        'original descriptor archive size differs',
      );
    }
    seedProducerIdentity(receipt);
  }
  assertIdentity(receipt.frozen);
  assert.match(receipt.pgdata?.treeSha256, /^[a-f0-9]{64}$/u, 'missing exact PGDATA digest');
  assert.ok(Array.isArray(receipt.pgdata.emptyDirectories), 'missing empty PGDATA directories');
  for (const name of receipt.pgdata.emptyDirectories) safeName(name);
  assert.deepEqual(
    receipt.pgdata.emptyDirectories,
    [...new Set(receipt.pgdata.emptyDirectories)].sort(),
    'seed empty directory identity is not canonical',
  );
  if (receipt.origin?.kind === 'qualified-construction') {
    validateQualifiedSeedOrigin(receipt.origin);
    assert.ok(receipt.qualificationIntent, 'promoted seed requires the observed current intent');
    assert.ok(
      ['family', 'target', 'profile'].every(
        (key) => receipt.intent[key] === receipt.qualificationIntent?.[key],
      ),
      'promoted seed must keep the same seed slot',
    );
  } else if (receipt.origin?.kind === 'completed-publication') {
    assert.ok(
      ['reused', 'adopted'].includes(receipt.origin.operation),
      'unknown seed reuse operation',
    );
    assertCompletedIdentity(receipt.origin.publication);
    assertIdentity(receipt.origin.archive);
    assertIdentity(receipt.origin.manifest);
    if (receipt.origin.metadata) assertIdentity(receipt.origin.metadata);
    if (receipt.origin.anchor) {
      assertIdentity(receipt.origin.anchor);
      for (const value of Object.values(receipt.origin.anchor.source))
        assert.match(value, /^[a-f0-9]{40}$/u);
      assert.match(receipt.origin.anchor.receiptSha256, /^[a-f0-9]{64}$/u);
      assert.ok(receipt.contentIntent, 'anchored seed reuse requires observed content intent');
    }
    if (receipt.origin.operation === 'reused')
      assert.ok(
        receipt.origin.metadata || receipt.origin.anchor,
        'reused seed requires its authentic constructor metadata or declared migration anchor',
      );
  } else assert.equal(receipt.origin?.kind, 'constructed', 'unknown seed construction origin');
  return structuredClone(receipt);
}

/** Structural validation cannot authenticate an anchor; the controller binds reviewed source. */
export function validateSeedConstructionAnchor(value: unknown): SeedConstructionAnchor {
  const anchor = value as SeedConstructionAnchor;
  assert.equal(
    anchor?.schema,
    SEED_CONSTRUCTION_ANCHOR_SCHEMA,
    'unsupported seed construction anchor',
  );
  assert.deepEqual(
    Object.keys(anchor).sort(),
    ['schema', 'source', 'publication', 'seeds'].sort(),
    'seed anchor fields differ',
  );
  assert.deepEqual(Object.keys(anchor.source).sort(), ['commit', 'tree']);
  for (const value of Object.values(anchor.source)) assert.match(value, /^[a-f0-9]{40}$/u);
  assertCompletedIdentity(anchor.publication);
  assert.ok(
    Array.isArray(anchor.seeds) && anchor.seeds.length,
    'seed anchor requires original observations',
  );
  const keys = anchor.seeds.map((seed) => {
    assert.deepEqual(
      Object.keys(seed).sort(),
      ['family', 'target', 'profile', 'archive', 'manifest', 'receipt', 'producer'].sort(),
      'seed anchor slot fields differ',
    );
    assertIdentity(seed.archive);
    assertIdentity(seed.manifest);
    assertIdentity(seed.receipt);
    assert.equal(
      seed.receipt.size,
      Buffer.byteLength(seed.receipt.contents),
      'seed anchor receipt size differs',
    );
    assert.equal(
      seed.receipt.sha256,
      sha256(Buffer.from(seed.receipt.contents)),
      'seed anchor receipt bytes differ',
    );
    assert.deepEqual(
      Object.keys(seed.producer).sort(),
      ['evidenceDigest', 'invocationId', 'root', 'configuration', 'output'].sort(),
      'seed anchor producer fields differ',
    );
    assert.match(seed.producer.evidenceDigest, /^sha256:[a-f0-9]{64}$/u);
    for (const field of ['invocationId', 'root', 'configuration', 'output'])
      assert.ok(typeof seed.producer[field] === 'string' && seed.producer[field]);
    const receipt = validateSeedConstructionReceipt(JSON.parse(seed.receipt.contents));
    assert.ok(receipt.contentIntent, 'seed anchor requires original observed desired contents');
    assert.ok(
      ['family', 'target', 'profile'].every((key) => receipt.intent[key] === seed[key]),
      'seed anchor slot differs from original receipt',
    );
    assert.equal(
      receipt.origin.kind,
      'completed-publication',
      'seed anchor must record explicit adoption',
    );
    assert.equal(
      receipt.origin.operation,
      'adopted',
      'seed anchor cannot reinterpret a constructed seed',
    );
    assert.deepEqual(
      receipt.origin.publication,
      anchor.publication,
      'seed anchor publication differs',
    );
    assert.deepEqual(receipt.origin.archive, seed.archive, 'seed anchor archive differs');
    assert.deepEqual(receipt.origin.manifest, seed.manifest, 'seed anchor manifest differs');
    return `${seed.family}/${seed.target}/${seed.profile}`;
  });
  assert.deepEqual(keys, [...new Set(keys)].sort(), 'seed anchor slots must be unique and sorted');
  return structuredClone(anchor);
}

function validateQualifiedSeedOrigin(
  control: Omit<QualifiedSeedControl, 'frozen' | 'receipt'> & {
    frozen: FileIdentity;
    receipt: FileIdentity;
  },
) {
  for (const source of [control.source, control.transition?.source])
    for (const value of [source?.commit, source?.tree])
      assert.match(value, /^[a-f0-9]{40}$/u, 'qualified seed source must be exact');
  assert.match(
    control.evidenceDigest,
    /^sha256:[a-f0-9]{64}$/u,
    'qualified seed requires its authenticated evidence digest',
  );
  assert.ok(
    typeof control.invocationId === 'string' && control.invocationId.length > 0,
    'qualified seed requires its original invocation',
  );
  assert.match(
    control.transition.updatesSha256,
    /^[a-f0-9]{64}$/u,
    'seed promotion requires exact generated version updates',
  );
  assertIdentity(control.frozen);
  assertIdentity(control.receipt);
}

/** Only the controller authenticates producer/transition; this action binds exact declared Files. */
export function selectQualifiedSeed(
  intent: SeedConstructionIntent,
  control?: QualifiedSeedControl,
  contentIntent?: SeedConstructionIntent,
) {
  if (!control) return undefined;
  validateQualifiedSeedOrigin(control);
  for (const file of [control.frozen, control.receipt])
    assert.deepEqual(
      identity(physicalFile(file.path)),
      identity(file),
      'qualified seed input bytes differ',
    );
  const receipt = validateSeedConstructionReceipt(
    JSON.parse(readFileSync(control.receipt.path, 'utf8')),
  );
  assert.deepEqual(
    receipt.frozen,
    identity(control.frozen),
    'qualified seed receipt/TAR binding differs',
  );
  assert.ok(
    ['family', 'target', 'profile'].every((key) => receipt.intent[key] === intent[key]),
    'qualified seed promotion cannot change seed slot',
  );
  if (contentIntent) {
    const originalContent = receipt.qualificationContentIntent ?? receipt.contentIntent;
    assert.ok(
      originalContent && equal(originalContent, contentIntent),
      'version promotion changed declared seed contents',
    );
  }
  const origin: SeedConstructionReceipt['origin'] = {
    kind: 'qualified-construction',
    source: structuredClone(control.source),
    evidenceDigest: control.evidenceDigest,
    invocationId: control.invocationId,
    frozen: identity(control.frozen),
    receipt: identity(control.receipt),
    transition: structuredClone(control.transition),
  };
  return {
    frozen: control.frozen.path,
    receipt,
    qualificationIntent: structuredClone(intent),
    ...(contentIntent ? { qualificationContentIntent: structuredClone(contentIntent) } : {}),
    origin,
  };
}

export function writePromotedSeedReceipt(
  file: string,
  promoted: NonNullable<ReturnType<typeof selectQualifiedSeed>>,
  frozen: string,
  pgdata: string,
) {
  assert.deepEqual(
    identity(physicalFile(frozen)),
    promoted.receipt.frozen,
    'promotion must preserve exact frozen TAR bytes',
  );
  assert.equal(
    logicalTreeSha256(filesystemTreeRows(pgdata)),
    promoted.receipt.pgdata.treeSha256,
    'promotion must preserve every PGDATA byte',
  );
  assert.deepEqual(
    emptyDirectoryPaths(pgdata),
    promoted.receipt.pgdata.emptyDirectories,
    'promotion must preserve empty PGDATA directories',
  );
  const receipt = validateSeedConstructionReceipt({
    ...promoted.receipt,
    qualificationIntent: promoted.qualificationIntent,
    ...(promoted.qualificationContentIntent
      ? { qualificationContentIntent: promoted.qualificationContentIntent }
      : {}),
    origin: promoted.origin,
  });
  writeFileSync(file, `${JSON.stringify(receipt)}\n`);
  return receipt;
}

function assertCompletedIdentity(publication: CompletedPublication) {
  assert.equal(publication?.product, 'database-resources', 'seed owner is database-resources');
  assert.equal(publication.tagName, `${publication.product}-v${publication.version}`);
  for (const value of [
    publication.publicationSha,
    publication.publicationTree,
    publication.releaseSha,
  ])
    assert.match(value, /^[a-f0-9]{40}$/u, 'seed reuse needs an exact completed publication');
}

/** Validate supplied acquisition bytes even when their recipe will not be reused. */
export function selectCompletedSeed(
  intent: SeedConstructionIntent,
  control?: SeedReuseControl,
  contentIntent?: SeedConstructionIntent,
) {
  if (!control) return undefined;
  assertCompletedIdentity(control.publication);
  assert.ok(
    ['reuse', 'adopt'].includes(control.operation),
    'explicit seed reuse operation is required',
  );
  for (const file of [
    control.archive,
    control.manifest,
    ...(control.metadata ? [control.metadata] : []),
    ...(control.anchor ? [control.anchor] : []),
  ]) {
    assertIdentity(file);
    assert.deepEqual(
      identity(physicalFile(file.path)),
      identity(file),
      'completed seed input bytes differ',
    );
  }
  const manifest = JSON.parse(readFileSync(control.manifest.path, 'utf8'));
  assert.equal(manifest.catalogProfile, intent.profile, 'completed seed profile differs');
  assert.equal(manifest.runtime?.engineFamily, intent.family, 'completed seed family differs');
  assert.equal(manifest.runtime?.target, intent.target, 'completed seed target differs');
  assert.equal(manifest.runtime?.postgresMajor, 18, 'completed seed PostgreSQL contract differs');
  assert.equal(
    manifest.archive?.path,
    path.basename(control.archive.path),
    'completed archive name differs',
  );
  assert.equal(
    manifest.archive?.sha256,
    control.archive.sha256,
    'completed descriptor digest differs',
  );
  assert.equal(
    manifest.archive?.compressedBytes,
    control.archive.size,
    'completed descriptor size differs',
  );
  const origin = {
    kind: 'completed-publication' as const,
    operation: control.operation === 'adopt' ? ('adopted' as const) : ('reused' as const),
    publication: structuredClone(control.publication),
    archive: identity(control.archive),
    manifest: identity(control.manifest),
    ...(control.metadata ? { metadata: identity(control.metadata) } : {}),
  };
  assert.ok(!(control.metadata && control.anchor), 'seed constructor baseline is ambiguous');
  const sourceManifest = {
    ...identity(control.manifest),
    contents: readFileSync(control.manifest.path, 'utf8'),
    publication: structuredClone(control.publication),
  };
  if (control.operation === 'adopt')
    return { archive: control.archive.path, origin, sourceManifest };
  let receipt: SeedConstructionReceipt;
  if (control.anchor) {
    assert.ok(contentIntent, 'anchor reuse requires observed desired contents');
    const anchor = validateSeedConstructionAnchor(
      JSON.parse(readFileSync(control.anchor.path, 'utf8')),
    );
    assert.deepEqual(
      anchor.publication,
      control.publication,
      'seed anchor completed origin differs',
    );
    const seed = anchor.seeds.find((seed) =>
      ['family', 'target', 'profile'].every((key) => seed[key] === intent[key]),
    );
    assert.ok(seed, 'seed anchor slot is absent');
    assert.deepEqual(seed.archive, identity(control.archive), 'seed anchor public archive differs');
    assert.deepEqual(
      seed.manifest,
      identity(control.manifest),
      'seed anchor public descriptor differs',
    );
    receipt = validateSeedConstructionReceipt(JSON.parse(seed.receipt.contents));
    if (!equal(receipt.contentIntent, contentIntent)) return undefined;
    Object.assign(origin, {
      anchor: {
        ...identity(control.anchor),
        source: anchor.source,
        receiptSha256: seed.receipt.sha256,
      },
    });
  } else {
    if (!control.metadata) return undefined;
    const metadata = JSON.parse(readFileSync(control.metadata.path, 'utf8'));
    assert.deepEqual(
      metadata.source,
      {
        commit: control.publication.publicationSha,
        tree: control.publication.publicationTree,
      },
      'seed metadata source differs from completed publication',
    );
    assert.equal(metadata.product?.id, control.publication.product);
    assert.equal(metadata.product?.version, control.publication.version);
    const receipts = (metadata.construction ?? [])
      .flatMap((construction) => construction.seedConstructions ?? [])
      .map(({ contents }) => validateSeedConstructionReceipt(JSON.parse(contents)))
      .filter((receipt) =>
        ['family', 'profile', 'target'].every((key) => receipt.intent[key] === intent[key]),
      );
    if (!receipts.length) return undefined; // Legacy public origins contain no constructor history.
    assert.equal(receipts.length, 1, 'completed seed constructor slot is ambiguous');
    receipt = receipts[0];
    const completedContent = receipt.qualificationContentIntent ?? receipt.contentIntent;
    if (contentIntent && completedContent) {
      if (!equal(completedContent, contentIntent)) return undefined;
    } else if (!equal(receipt.qualificationIntent ?? receipt.intent, intent)) return undefined;
  }
  assertSeedPublicData(control.archive.path, receipt);
  return { archive: control.archive.path, origin, sourceManifest };
}

/** The public seed must contain every original PGDATA byte and empty directory. */
export function assertSeedPublicData(archive: string, receipt: SeedConstructionReceipt) {
  const entries = readPortableArchiveEntries(archive);
  const actualTree = logicalTreeSha256(
    [...entries.values()]
      .filter((entry) => entry.isFile)
      .map((entry) => ({ path: entry.name, bytes: entry.data() })),
  );
  assert.equal(
    actualTree,
    receipt.pgdata.treeSha256,
    'completed PGDATA differs from constructor receipt',
  );
  const directories = [...entries.values()]
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name.replace(/\/$/u, ''));
  const names = [...entries.keys()];
  const emptyDirectories = directories
    .filter(
      (directory) =>
        !names.some((name) => name !== `${directory}/` && name.startsWith(`${directory}/`)),
    )
    .sort();
  assert.deepEqual(
    emptyDirectories,
    receipt.pgdata.emptyDirectories,
    'completed PGDATA empty directories differ',
  );
}

export function writeSeedConstructionReceipt(
  file: string,
  intent: SeedConstructionIntent,
  frozen: string,
  pgdata: string,
  origin: SeedConstructionReceipt['origin'] = { kind: 'constructed' },
  contentIntent?: SeedConstructionIntent,
  sourceManifest?: SeedSourceManifest,
) {
  validatePgdataDirectories(pgdata);
  const receipt = validateSeedConstructionReceipt({
    schema: SEED_CONSTRUCTION_SCHEMA,
    intent,
    intentSha256: digest(intent),
    ...(contentIntent ? { contentIntent, contentIntentSha256: digest(contentIntent) } : {}),
    frozen: identity(physicalFile(frozen)),
    pgdata: {
      treeSha256: logicalTreeSha256(filesystemTreeRows(pgdata)),
      emptyDirectories: emptyDirectoryPaths(pgdata),
    },
    origin,
    ...(sourceManifest ? { sourceManifest } : {}),
  });
  writeFileSync(file, `${JSON.stringify(receipt)}\n`);
  return receipt;
}
