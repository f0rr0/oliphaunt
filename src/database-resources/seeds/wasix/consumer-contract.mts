/** One authored WASIX seed consumer choice, shared by acquisition and Bazel. */
import assert from 'node:assert/strict';
export function wasixSeedConsumerDeclaration(
  manifest: any,
  version: string,
  currentVersion: string,
) {
  const authored = manifest?.package?.metadata?.oliphaunt;
  assert.ok(authored && typeof authored === 'object', 'WASIX seed consumer metadata is missing');
  assert.match(
    version,
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u,
    'WASIX consumer version must be exact',
  );
  assert.equal(
    authored['runtime-version'],
    version,
    'WASIX consumer declaration differs from its conventional compatibility pin',
  );
  const source = authored['runtime-source'] ?? 'completed';
  assert.ok(
    source === 'completed' || source === 'current',
    'WASIX runtime-source must be current or completed',
  );
  assert.match(currentVersion, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
  // Current construction can satisfy only the explicitly requested source version.
  // A later source version leaves the conventional pin held; its completed File
  // remains mandatory and independently authenticated by acquisition.
  return Object.freeze({
    source:
      source === 'current' && version === currentVersion
        ? ('current' as const)
        : ('completed' as const),
    version,
  });
}
