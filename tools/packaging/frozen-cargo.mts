import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractPortableArchiveTree } from './portable-archive.mts';

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
