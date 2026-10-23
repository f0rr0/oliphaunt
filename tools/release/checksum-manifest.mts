/** The canonical publication checksum contract, shared by final-family qualification. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function validateChecksumManifest(file: string, payloadFiles: string[], context: string) {
  const declared = new Map<string, string>();
  for (const [index, rawLine] of readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
    if (rawLine.length === 0) continue;
    const match = rawLine.match(/^([0-9a-f]{64}) {2}\.\/([^/\0]+)$/u);
    if (match === null)
      throw new Error(
        `publication-lock: ${context} checksum line ${index + 1} must be '<sha256>  ./<basename>'`,
      );
    const [, digest, name] = match;
    if (declared.has(name))
      throw new Error(
        `publication-lock: ${context} checksum manifest declares ${name} more than once`,
      );
    declared.set(name, digest);
  }
  const expected = new Map(
    payloadFiles.map((payload) => [
      path.basename(payload),
      createHash('sha256').update(readFileSync(payload)).digest('hex'),
    ]),
  );
  const declaredNames = [...declared.keys()].sort();
  const expectedNames = [...expected.keys()].sort();
  if (JSON.stringify(declaredNames) !== JSON.stringify(expectedNames))
    throw new Error(
      `publication-lock: ${context} checksum entries do not exactly cover public payloads: expected=${JSON.stringify(expectedNames)}, actual=${JSON.stringify(declaredNames)}`,
    );
  for (const [name, digest] of expected)
    if (declared.get(name) !== digest)
      throw new Error(
        `publication-lock: ${context} checksum for ${name} does not match its frozen bytes`,
      );
}
