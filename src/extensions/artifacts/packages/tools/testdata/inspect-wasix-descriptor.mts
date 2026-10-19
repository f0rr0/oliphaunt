import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export async function inspectDescriptor(entrypoint) {
  const descriptor = (await import(pathToFileURL(entrypoint).href)).default;
  if (!Object.isFrozen(descriptor) || !Object.isFrozen(descriptor.carriers))
    throw new Error('descriptor is mutable');
  function assertDeepFrozen(value, label) {
    if (value !== null && typeof value === 'object') {
      if (!Object.isFrozen(value)) throw new Error(label + ' is mutable');
      for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, label + '.' + key);
    }
  }
  assertDeepFrozen(descriptor.compatibility, 'compatibility');
  const carriers = descriptor.carriers.map((carrier) => {
    if (!Object.isFrozen(carrier)) throw new Error('carrier is mutable');
    assertDeepFrozen(carrier.install, 'carrier.install');
    const bytes = readFileSync(carrier.source);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== carrier.size || sha256 !== carrier.sha256)
      throw new Error('carrier integrity mismatch');
    return {
      ...carrier,
      source: carrier.source.href,
      actualSha256: sha256,
      actualSize: bytes.length,
    };
  });
  return { descriptor: { ...descriptor, carriers }, frozen: true };
}
if (process.argv[1]?.endsWith('/inspect-wasix-descriptor.mts'))
  await inspectDescriptor(process.argv[2]);
