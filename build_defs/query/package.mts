import { readFile, writeFile } from 'node:fs/promises';
import { tarHeader } from '../../tools/packaging/archive-directory.mts';
import { canonicalGzipSync } from '../../tools/packaging/portable-archive.mts';

type Entries = Record<string, Uint8Array>;

function archivePath(path: string): void {
  const fitsUstar =
    Buffer.byteLength(path) <= 100 ||
    path.split('/').some((_, index, parts) => {
      if (!index) return false;
      return (
        Buffer.byteLength(parts.slice(0, index).join('/')) <= 155 &&
        Buffer.byteLength(parts.slice(index).join('/')) <= 100
      );
    });
  if (
    !path ||
    !fitsUstar ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsupported archive path: ${path}`);
  }
}

/** Fixed ustar headers and gzip metadata make identical inputs produce identical bytes. */
export function archive(entries: Entries): Buffer {
  const chunks: Buffer[] = [];
  for (const [path, bytes] of Object.entries(entries).sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    archivePath(path);
    const content = Buffer.from(bytes);
    const header = tarHeader({ name: path, isDirectory: false }, content.length, 0o644);
    chunks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return canonicalGzipSync(Buffer.concat(chunks));
}

export function crateManifest(original: string, workspace: string): string {
  if (Object.keys(Bun.TOML.parse(original)).some((key) => key !== 'package')) {
    throw new Error('Query source crate supports only its dependency-free package section');
  }
  const values = Bun.TOML.parse(workspace).workspace?.package;
  const normalized = original.replace(/^([\w-]+)\.workspace\s*=\s*true\s*$/gm, (_, key: string) => {
    const value = values?.[key];
    if (typeof value !== 'string') {
      throw new Error(`Missing string workspace.package.${key}`);
    }
    return `${key} = ${JSON.stringify(value)}`;
  });
  for (const [key, value] of Object.entries(Bun.TOML.parse(normalized).package)) {
    if (value && typeof value === 'object' && 'workspace' in value) {
      throw new Error(`Unsupported workspace inheritance syntax for package.${key}`);
    }
  }
  return normalized;
}

function exportPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportPaths);
}

export async function packageEnvelope(
  format: 'npm' | 'crate',
  manifestPath: string,
  mapping: Record<string, string>,
  workspacePath?: string,
): Promise<Buffer> {
  const original = await readFile(manifestPath, 'utf8');
  const manifest = format === 'npm' ? JSON.parse(original) : Bun.TOML.parse(original).package;
  if (!manifest || typeof manifest.name !== 'string' || !/^[\w@/.-]+$/.test(manifest.name)) {
    throw new Error('Missing or invalid package name');
  }
  if (
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)
  ) {
    throw new Error('Missing or invalid package version');
  }
  const prefix = format === 'npm' ? 'package' : `${manifest.name}-${manifest.version}`;
  const entries: Entries = {};
  for (const [destination, source] of Object.entries(mapping)) {
    archivePath(destination);
    entries[`${prefix}/${destination}`] = await readFile(source);
  }
  const manifestName = format === 'npm' ? 'package.json' : 'Cargo.toml';
  if (!entries[`${prefix}/${manifestName}`])
    throw new Error(`Missing ${manifestName} package entry`);
  if (format === 'crate') {
    if (!workspacePath) throw new Error('Source crate requires its workspace manifest');
    entries[`${prefix}/Cargo.toml.orig`] = Buffer.from(original);
    entries[`${prefix}/Cargo.toml`] = Buffer.from(
      crateManifest(original, await readFile(workspacePath, 'utf8')),
    );
  } else {
    for (const path of exportPaths(manifest.exports)) {
      if (!path.startsWith('./') || !entries[`${prefix}/${path.slice(2)}`]) {
        throw new Error(`Missing exported npm entry: ${path}`);
      }
    }
  }
  return archive(entries);
}

if (import.meta.main) {
  const [format, output, manifest, specification, workspace] = process.argv.slice(2);
  if ((format !== 'npm' && format !== 'crate') || !output || !manifest || !specification) {
    throw new Error('Usage: package.mts npm|crate OUTPUT MANIFEST ENTRIES.json [WORKSPACE]');
  }
  const mapping = JSON.parse(await readFile(specification, 'utf8')) as Record<string, string>;
  await writeFile(output, await packageEnvelope(format, manifest, mapping, workspace));
}
