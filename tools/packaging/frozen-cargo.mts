import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractPortableArchiveTree } from './portable-archive.mts';

/** Join actual Cargo compiler messages to the original staged source manifests. */
export function assertCargoSourceArtifacts(
  messages: string,
  sources: { name: string; version: string; manifestPath: string }[],
  requiredNames: string[] = [],
) {
  const expected = new Map(sources.map((source) => [source.name, source]));
  if (expected.size !== sources.length)
    throw new Error('Cargo source artifact names are duplicated');
  const compiled = new Map<string, (typeof sources)[number]>();
  for (const line of messages.split('\n').filter((line) => line.trim())) {
    const message = JSON.parse(line);
    if (message.reason !== 'compiler-artifact') continue;
    if (typeof message.manifest_path !== 'string' || !path.isAbsolute(message.manifest_path))
      throw new Error('Cargo compiler artifact has no absolute manifest path');
    const manifest = Bun.TOML.parse(readFileSync(message.manifest_path, 'utf8'));
    const source = expected.get(manifest.package?.name);
    if (!source) continue;
    if (
      manifest.package?.version !== source.version ||
      realpathSync(message.manifest_path) !== realpathSync(source.manifestPath)
    )
      throw new Error(`Cargo compiled source differs: ${source.name}@${source.version}`);
    compiled.set(source.name, source);
  }
  for (const name of requiredNames)
    if (!compiled.has(name)) throw new Error(`Cargo source was not compiled: ${name}`);
  return [...compiled.values()];
}

export type CargoCarrierInput = {
  file: string;
  name: string;
  version: string;
  sha256: string;
};

/** Stage authenticated final source envelopes without choosing their versions. */
export function stageCargoCarrierInputs(inputs: CargoCarrierInput[], directory: string) {
  const patches: string[] = [];
  const names = new Set<string>();
  for (const input of inputs) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(input.name) ||
      !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(input.version) ||
      names.has(input.name) ||
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      createHash('sha256').update(readFileSync(input.file)).digest('hex') !== input.sha256
    )
      throw new Error(`frozen Cargo input differs: ${input.name}@${input.version}`);
    names.add(input.name);
    const destination = path.join(directory, 'crates', `${input.name}-${input.version}`);
    extractPortableArchiveTree(input.file, destination, `${input.name}-${input.version}`);
    const manifest = Bun.TOML.parse(readFileSync(path.join(destination, 'Cargo.toml'), 'utf8'));
    if (
      manifest.package?.name !== input.name ||
      manifest.package?.version !== input.version ||
      Object.hasOwn(manifest.package?.metadata?.oliphaunt ?? {}, 'qualificationOnly')
    )
      throw new Error(`frozen Cargo identity differs: cargo:${input.name}`);
    patches.push(`${JSON.stringify(input.name)} = { path = ${JSON.stringify(destination)} }`);
  }
  const config = path.join(directory, 'cargo-config.toml');
  mkdirSync(directory, { recursive: true });
  writeFileSync(config, `[patch.crates-io]\n${patches.join('\n')}\n`);
  return config;
}
