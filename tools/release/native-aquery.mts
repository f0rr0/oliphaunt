/** Standard stock Bazel protobuf decoding at the captured File boundary. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export function nativeAqueryType(bazelVersion: string) {
  const snapshot = JSON.parse(
    readFileSync(new URL('./bazel-8.8.1/sources.json', import.meta.url), 'utf8'),
  );
  if (snapshot.bazelVersion !== bazelVersion)
    throw new Error('native aquery schema differs from the producing Bazel version');
  // The publisher's standalone full bundle preserves CommonJS.
  const protobuf = createRequire(import.meta.url)('protobufjs/dist/protobuf.js');
  const root = new protobuf.Root();
  for (const source of snapshot.files) {
    protobuf.parse(
      readFileSync(new URL(`./bazel-8.8.1/${source.file}`, import.meta.url), 'utf8'),
      root,
      { keepCase: false },
    );
  }
  root.resolveAll();
  return root.lookupType('analysis.ActionGraphContainer');
}

/** The format comes from the canonical query BEP, never from the filename. */
export function readNativeAquery(
  file: string,
  format: 'jsonproto' | 'proto',
  bazelVersion: string,
): unknown {
  if (format === 'jsonproto') return JSON.parse(readFileSync(file, 'utf8'));
  if (format !== 'proto') throw new Error('unsupported native aquery format');
  const type = nativeAqueryType(bazelVersion);
  return type.toObject(type.decode(readFileSync(file)), {
    defaults: false,
    arrays: false,
    objects: false,
    oneofs: false,
    longs: String,
    enums: String,
    bytes: String,
    json: true,
  });
}
