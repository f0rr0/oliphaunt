/** Resolve only the actual declared installed-test tools; never construct an application. */
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function regularFile(value: string) {
  assert(path.isAbsolute(value), 'Installed replay tools require absolute declared Files');
  const file = realpathSync(value);
  assert(lstatSync(file).isFile(), 'Installed replay tools require regular declared Files');
  return file;
}

export function installedToolManifest(args: string[], bun = process.execPath) {
  const descriptor = JSON.parse(readFileSync(regularFile(args[0]), 'utf8'));
  assert.deepEqual(
    Object.keys(descriptor).sort(),
    ['schema', 'platform', 'toolSpec', 'runnerRunfile', 'fileCount'].sort(),
  );
  assert.equal(descriptor.schema, 'oliphaunt-installed-mobile-tools-v1');
  assert(['android', 'ios'].includes(descriptor.platform));
  assert(Number.isSafeInteger(descriptor.fileCount) && descriptor.fileCount > 0);
  const prefix = descriptor.platform === 'android' ? 4 : 3;
  assert.equal(
    args.length,
    prefix + descriptor.fileCount + 3,
    'Installed replay tools require only their declared Files and --output destination',
  );
  const root = args[prefix + descriptor.fileCount];
  assert(path.isAbsolute(root));
  const relative = descriptor.runnerRunfile;
  assert(
    typeof relative === 'string' &&
      relative.length > 0 &&
      !path.isAbsolute(relative) &&
      !relative.includes('\\') &&
      relative.split('/').every((part) => part && part !== '.' && part !== '..'),
  );
  const files = args.slice(prefix, prefix + descriptor.fileCount).map(regularFile);
  const toolSpec = descriptor.toolSpec;
  assert(toolSpec && typeof toolSpec === 'object' && !Array.isArray(toolSpec));
  assert.deepEqual(
    Object.keys(toolSpec).sort(),
    (descriptor.platform === 'android'
      ? ['helpers', 'sdkFiles', 'java']
      : ['helpers', 'tools']
    ).sort(),
  );
  const index = (value: unknown) =>
    assert(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < files.length);
  for (const key of ['helpers', ...(descriptor.platform === 'android' ? ['sdkFiles'] : [])]) {
    assert(Array.isArray(toolSpec[key]));
    const names = new Set<string>();
    for (const row of toolSpec[key]) {
      assert.deepEqual(Object.keys(row).sort(), ['index', 'relative']);
      assert(
        typeof row.relative === 'string' &&
          row.relative.length > 0 &&
          !path.isAbsolute(row.relative) &&
          !row.relative.includes('\\') &&
          row.relative.split('/').every((part: string) => part && part !== '.' && part !== '..'),
      );
      assert(!names.has(row.relative));
      names.add(row.relative);
      index(row.index);
    }
  }
  if (descriptor.platform === 'android') index(toolSpec.java);
  else {
    assert(toolSpec.tools && typeof toolSpec.tools === 'object' && !Array.isArray(toolSpec.tools));
    assert.deepEqual(Object.keys(toolSpec.tools).sort(), ['plutil', 'xcrun']);
    Object.values(toolSpec.tools).forEach(index);
  }
  assert.equal(args.at(-2), '--output');
  const output = args[args.length - 1];
  assert(
    path.isAbsolute(output),
    'Installed replay tools require an absolute --output destination',
  );
  return {
    output,
    manifest: {
      schema: descriptor.schema,
      platform: descriptor.platform,
      toolSpec,
      files,
      bun: regularFile(bun),
      node: regularFile(args[1]),
      runner: regularFile(path.join(root, relative)),
      ...(descriptor.platform === 'android'
        ? { emulatorMetadata: regularFile(args[2]), adb: regularFile(args[3]) }
        : { receipt: regularFile(args[2]) }),
    },
  };
}

if (import.meta.main) {
  const { output, manifest } = installedToolManifest(process.argv.slice(2));
  writeFileSync(output, `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
}
