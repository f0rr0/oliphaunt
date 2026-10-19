/** Explicit source lifecycle composition; never installed-package evidence. */
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  renderCargoToml,
  resolveCargoWorkspaceInheritance,
} from '../../../../tools/packaging/cargo-manifest.mts';

const SERVER = 'src/wasix/pgwire-server';
const SDK = 'src/wasix/sdks/rust';
const readManifest = (file: string) => Bun.TOML.parse(readFileSync(file, 'utf8'));

export function stageSourceServerQualification(root: string, directory: string) {
  const source = path.join(root, SERVER);
  const original = readManifest(path.join(source, 'Cargo.toml'));
  const workspace = readManifest(path.join(root, 'Cargo.toml'));
  const manifest = resolveCargoWorkspaceInheritance(original, workspace.workspace);
  delete manifest.package.workspace;
  manifest.package.publish = false;
  manifest.workspace = {};
  // Retain the held requirement; Cargo rejects an incompatible source SDK.
  manifest.dependencies['oliphaunt-wasix'].path = path.join(root, SDK);
  const destination = path.join(directory, SERVER);
  mkdirSync(destination, { recursive: true });
  for (const name of ['src', 'tests', 'README.md'])
    cpSync(path.join(source, name), path.join(destination, name), { recursive: true });
  for (const relative of [
    'src/extensions/catalog/extensions.source.json',
    'src/test-fixtures/extensions',
  ]) {
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(root, relative), target, { recursive: true });
  }
  copyFileSync(path.join(root, 'Cargo.lock'), path.join(destination, 'Cargo.lock'));
  const file = path.join(destination, 'Cargo.toml');
  writeFileSync(file, renderCargoToml(manifest));
  return file;
}

export function verifySourceServerResolution(metadata: any, root: string, manifest: string) {
  const packages = metadata.packages;
  const server = packages.find((row: any) => row.manifest_path === manifest);
  if (!server || metadata.resolve?.root !== server.id)
    throw new Error('source server qualification requires its actual resolved root');
  const serverNode = metadata.resolve.nodes.find((row: any) => row.id === server.id);
  const sdkId = serverNode?.deps.find((row: any) => row.name === 'oliphaunt_wasix')?.pkg;
  const sdk = packages.find((row: any) => row.id === sdkId);
  const sdkManifest = path.join(root, SDK, 'Cargo.toml');
  if (
    sdk?.name !== 'oliphaunt-wasix' ||
    sdk.source !== null ||
    realpathSync(sdk.manifest_path) !== realpathSync(sdkManifest)
  )
    throw new Error('source server qualification resolved an installed or different SDK');

  const sdkDeclaration = readManifest(sdkManifest);
  const expected = new Map<string, string>();
  for (const table of [sdkDeclaration, ...Object.values(sdkDeclaration.target ?? {})] as any[])
    for (const [name, declaration] of Object.entries(table.dependencies ?? {}) as [string, any][])
      if (declaration.path)
        expected.set(name, path.resolve(path.dirname(sdkManifest), declaration.path, 'Cargo.toml'));
  for (const row of packages) {
    const expectedManifest = expected.get(row.name);
    if (expectedManifest === undefined) continue;
    if (row.source !== null || realpathSync(row.manifest_path) !== realpathSync(expectedManifest))
      throw new Error(
        `source server qualification resolved an installed or different carrier: ${row.name}`,
      );
  }
}

if (import.meta.main) {
  const [mode, root, directory, metadataFile] = process.argv.slice(2);
  if (mode === 'prepare' && root && directory && !metadataFile)
    console.log(stageSourceServerQualification(root, directory));
  else if (mode === 'verify' && root && directory && metadataFile)
    verifySourceServerResolution(JSON.parse(readFileSync(metadataFile, 'utf8')), root, directory);
  else
    throw new Error(
      'usage: source-server-qualification.mts prepare ROOT DIRECTORY | verify ROOT MANIFEST METADATA',
    );
}
