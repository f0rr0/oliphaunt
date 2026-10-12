/** File aliases from the controller's existing authenticated producer transport. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileIdentity, safeRelative } from './native-file-identity.mts';

export type ExtensionFinalInputFile = {
  path: string;
  size: number;
  sha256: string;
  producer: {
    evidenceDigest: string;
    invocationId: string;
    root: string;
    configuration: string;
    output: string;
  };
  /** Existing captured TreeArtifact member path; absent for a regular output. */
  member?: string;
};
export type ExtensionFinalInput = {
  product: string;
  owner: string;
  version: string;
  family: 'native' | 'wasix';
  target: string;
  github: ExtensionFinalInputFile[];
  npm: ExtensionFinalInputFile[];
  cargo: ExtensionFinalInputFile[];
  manifest: ExtensionFinalInputFile;
  frozen: ExtensionFinalInputFile;
};
export type NativeAppleBaseInput = {
  owner: 'liboliphaunt-native';
  version: string;
  file: ExtensionFinalInputFile;
};
export type NativeSwiftSourceInput = {
  owner: 'oliphaunt-swift';
  version: string;
  archive: ExtensionFinalInputFile;
  carrier: ExtensionFinalInputFile;
  ownerCatalog: ExtensionFinalInputFile;
};
function fields(value: unknown, names: string[], label: string) {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} needs an object`,
  );
  assert.deepEqual(Object.keys(value).sort(), names.sort(), `${label} fields differ`);
}
/** A fact-only regular File alias. The original controller authenticates its producer. */
export function projectOriginalNativeFinalFile(file: ExtensionFinalInputFile, prefix: string) {
  fields(
    file,
    ['path', 'size', 'sha256', 'producer', ...(file.member === undefined ? [] : ['member'])],
    'original native File',
  );
  assert.ok(path.isAbsolute(file.path), 'original native import needs an absolute retained File');
  const actual = fileIdentity(file.path);
  assert.deepEqual(
    { size: actual.size, sha256: actual.sha256 },
    { size: file.size, sha256: file.sha256 },
    'original native File bytes differ',
  );
  fields(
    file.producer,
    ['evidenceDigest', 'invocationId', 'root', 'configuration', 'output'],
    'original native producer',
  );
  assert.match(file.producer.evidenceDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(file.producer.configuration, /^[a-f0-9]{64}$/u);
  assert.match(file.producer.root, /^\/\/[A-Za-z0-9_./+-]*:[A-Za-z0-9_.+-]+$/u);
  const packagePath = file.producer.root.slice(2, file.producer.root.indexOf(':'));
  if (packagePath) safeRelative(packagePath);
  assert.ok(
    typeof file.producer.invocationId === 'string' &&
      file.producer.invocationId.length &&
      !/[\u0000-\u001f\u007f]/u.test(file.producer.invocationId),
  );
  safeRelative(file.producer.output);
  if (file.member !== undefined) safeRelative(file.member);
  safeRelative(prefix);
  const basename = path.basename(file.path);
  assert.match(basename, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
  const output = `${prefix}/${file.sha256}/${basename}`;
  return {
    file: { ...structuredClone(file), path: `@oliphaunt_metadata//:${output}` },
    alias: { source: file.path, path: output, size: file.size, sha256: file.sha256 },
  };
}

export function projectNativeAppleBaseInput(value: unknown) {
  fields(value, ['owner', 'version', 'file'], 'native Apple base input');
  const input = value as NativeAppleBaseInput;
  assert.equal(input.owner, 'liboliphaunt-native');
  assert.match(input.version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u);
  assert.equal(
    input.file.member,
    undefined,
    'Apple base manifest must remain its whole regular original File',
  );
  assert.equal(path.basename(input.file.path), 'ios.json');
  const projected = projectOriginalNativeFinalFile(input.file, 'native-apple-base');
  return { input: { ...input, file: projected.file }, files: [projected.alias] };
}

/** The final fixture consumes original source/control Files, never a source
 * checkout or a re-created source ZIP under another version. */
export function projectNativeSwiftSourceInput(value: unknown) {
  fields(
    value,
    ['owner', 'version', 'archive', 'carrier', 'ownerCatalog'],
    'native Swift source input',
  );
  const input = value as NativeSwiftSourceInput;
  assert.equal(input.owner, 'oliphaunt-swift');
  assert.match(input.version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u);
  const expected = {
    archive: 'Oliphaunt-source.zip',
    carrier: 'oliphaunt-react-native-ios-carriers.json',
    ownerCatalog: 'extension-owner-catalog.json',
  };
  const aliases = [];
  const projected = { owner: input.owner, version: input.version } as NativeSwiftSourceInput;
  for (const name of ['archive', 'carrier', 'ownerCatalog'] as const) {
    assert.equal(
      path.basename(input[name].path),
      expected[name],
      'Swift source input name differs',
    );
    if (name !== 'carrier')
      assert.equal(
        input[name].member,
        undefined,
        'Swift source ZIP/catalog must remain whole original Files',
      );
    const result = projectOriginalNativeFinalFile(input[name], `native-swift-source/${name}`);
    projected[name] = result.file;
    aliases.push(result.alias);
  }
  const carrier = JSON.parse(readFileSync(input.carrier.path, 'utf8'));
  assert.equal(carrier.schema, 'oliphaunt-react-native-ios-carrier-v1');
  assert.equal(carrier.base?.product, 'liboliphaunt-native');
  assert.match(carrier.base.version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u);
  assert.equal(carrier.base.tag, `liboliphaunt-native-v${carrier.base.version}`);
  assert.deepEqual(carrier.extensions, []);
  assert.deepEqual(carrier.carriers, []);
  return { input: { ...projected, nativeVersion: carrier.base.version }, files: aliases };
}

/** Byte checks bind the import; authentication remains with the original controller. */
export function projectNativeExtensionFinalInputs(value: unknown) {
  assert.ok(Array.isArray(value), 'extension final inputs need an array');
  const leaves: Record<string, ExtensionFinalInput> = {};
  const files = new Map<string, { source: string; path: string; size: number; sha256: string }>();
  const refs = new Set<string>();
  for (const input of value as ExtensionFinalInput[]) {
    fields(
      input,
      [
        'product',
        'owner',
        'version',
        'family',
        'target',
        'github',
        'npm',
        'cargo',
        'manifest',
        'frozen',
      ],
      'extension final input',
    );
    for (const id of [input.product, input.owner, input.target])
      assert.match(id, /^[a-z0-9][a-z0-9-]*$/u);
    assert.match(input.version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u);
    assert.ok(['native', 'wasix'].includes(input.family));
    assert.ok(input.family !== 'wasix' || input.target === 'wasix-portable');
    const slot = `${input.product}/${input.family}/${input.target}`;
    assert.ok(!leaves[slot], 'duplicate extension final constructor slot');
    const alias = (file: ExtensionFinalInputFile) => {
      const projected = projectOriginalNativeFinalFile(
        file,
        `extension-final-inputs/${input.product}/${input.family}/${input.target}`,
      );
      const ref = JSON.stringify([file.producer, file.member ?? '']);
      assert.ok(!refs.has(ref), 'extension original File repeats across constructor slots');
      refs.add(ref);
      const output = projected.alias.path;
      assert.ok(!files.has(output), 'extension final File alias repeats');
      files.set(output, projected.alias);
      return projected.file;
    };
    const groups = Object.fromEntries(
      (['github', 'npm', 'cargo'] as const).map((name) => {
        const group = input[name];
        assert.ok(Array.isArray(group));
        assert.ok(
          group.length > 0 ||
            (name !== 'github' &&
              input.family === 'native' &&
              /^(android-|ios-)/u.test(input.target)),
          'desktop/WASIX import is missing a public carrier group',
        );
        return [name, group.map(alias)];
      }),
    ) as Pick<ExtensionFinalInput, 'github' | 'npm' | 'cargo'>;
    leaves[slot] = {
      ...input,
      ...groups,
      manifest: alias(input.manifest),
      frozen: alias(input.frozen),
    };
  }
  return { leaves, files: [...files.values()] };
}
