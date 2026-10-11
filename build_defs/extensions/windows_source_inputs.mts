/** Transform only the explicitly declared pinned extension source files. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { windowsExtensionHeaders, windowsExtensionSource } from './windows_source_portability.mts';

export interface WindowsSourceInputs {
  extension: string;
  files: { name: string; source: string; output: string }[];
  headers: { name: string; output: string }[];
}

export function prepareWindowsSources(spec: WindowsSourceInputs): void {
  if (spec.extension !== 'pg_uuidv7' && spec.extension !== 'pg_textsearch') {
    throw new Error('Windows source preparation requires an existing pinned source adaptation');
  }
  const generated = windowsExtensionHeaders(spec.extension);
  const names = new Set<string>();
  const outputs = new Set<string>();
  const validate = (name: string, output: string) => {
    if (
      typeof name !== 'string' ||
      !name ||
      name.includes('\\') ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('Windows extension source requires a safe relative name');
    }
    if (
      typeof output !== 'string' ||
      !output ||
      names.has(name) ||
      outputs.has(path.resolve(output))
    ) {
      throw new Error('Windows extension source has missing or duplicate declared outputs');
    }
    names.add(name);
    outputs.add(path.resolve(output));
  };
  for (const file of spec.files) validate(file.name, file.output);
  for (const file of spec.headers) validate(file.name, file.output);
  if (
    JSON.stringify(spec.headers.map((file) => file.name).sort()) !==
    JSON.stringify(Object.keys(generated).sort())
  ) {
    throw new Error('Windows compatibility headers differ from the shared source recipe');
  }
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  // Validate every source and transformation before writing any output.
  const transformed = spec.files.map((file) => ({
    ...file,
    text: windowsExtensionSource(spec.extension, file.name, utf8.decode(readFileSync(file.source))),
  }));
  for (const file of [
    ...transformed,
    ...spec.headers.map((file) => ({ ...file, text: generated[file.name] })),
  ]) {
    mkdirSync(path.dirname(file.output), { recursive: true });
    writeFileSync(file.output, file.text);
  }
}

if (import.meta.main) {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length)
    throw new Error('usage: windows_source_inputs.mts DECLARED_INPUTS.json');
  prepareWindowsSources(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file))),
  );
}
