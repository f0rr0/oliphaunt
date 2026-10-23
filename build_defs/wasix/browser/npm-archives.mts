import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function extractNpmPackage(
  source: string,
  destination: string,
  { allowIdenticalAliases = false } = {},
) {
  if (!source.endsWith('.tgz')) {
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
    return;
  }
  const files = await new Bun.Archive(await readFile(source)).files();
  assert(files.size > 0, `empty compiler package ${source}`);
  const prefix = `${files.keys().next().value?.split('/')[0]}/`;
  const names = new Map<string, string>();
  for (const [name, bytes] of files) {
    assert(
      name.startsWith(prefix) && !name.split('/').some((part) => part === '..' || !part),
      `Unsafe npm member ${name} in ${source}`,
    );
    const relative = name
      .slice(prefix.length)
      .split('/')
      .filter((part) => part !== '.')
      .join('/');
    assert(relative, `Empty npm member ${name} in ${source}`);
    const content = await bytes.bytes();
    const previous = names.get(relative);
    if (previous) {
      assert(allowIdenticalAliases, `Duplicate shipping npm member ${name} in ${source}`);
      const original = files.get(previous);
      assert(original);
      assert(
        Buffer.from(content).equals(Buffer.from(await original.bytes())),
        `Conflicting npm member ${name} in ${source}`,
      );
      continue;
    }
    names.set(relative, name);
    const target = join(destination, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o644 });
  }
}

export async function materializeCompilerPackages(
  acquisition: { packages: Record<string, { key: string }> },
  sources: Record<string, string>,
  workspace: string,
) {
  assert.deepEqual(Object.keys(sources).sort(), Object.keys(acquisition.packages).sort());
  for (const [id, row] of Object.entries(acquisition.packages)) {
    assert(
      row.key.startsWith('node_modules/') &&
        !row.key.split('/').some((part) => part === '..' || part === '.'),
    );
    await extractNpmPackage(resolve(sources[id]), join(workspace, row.key), {
      allowIdenticalAliases: true,
    });
  }
}
