import { readFile, writeFile } from 'node:fs/promises';

const [manifest, output] = process.argv.slice(2);
if (!manifest || !output) throw new Error('Expected the conventional Gradle plugin manifest and output path');
const source = await readFile(manifest, 'utf8');
const value = (field: string) => {
  const matches = [...source.matchAll(new RegExp(`^\\s*${field} = "([A-Za-z0-9_.]+)"\\s*$`, 'gm'))];
  if (matches.length !== 1) throw new Error(`Expected exactly one literal Gradle plugin ${field}`);
  return matches[0]![1]!;
};
if (value('id') !== 'dev.oliphaunt.android') throw new Error('Unexpected public Gradle plugin identity');
await writeFile(output, `implementation-class=${value('implementationClass')}\n`);
