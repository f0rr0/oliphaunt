import { readFileSync } from 'node:fs';

type PackageManifest = { name: string; devDependencies?: Record<string, string> };
type LockedPackage = [
  string,
  string,
  { optionalDependencies?: Record<string, string>; os?: string; cpu?: string },
  string,
];
type BunLock = {
  lockfileVersion: number;
  configVersion: number;
  workspaces: Record<string, PackageManifest>;
  packages: Record<string, LockedPackage>;
};

/** Select the native formatter from the same root declaration and Bun lock as Moon. */
export function importBiomeMetadata(root: PackageManifest, lock: BunLock) {
  if (lock.lockfileVersion !== 2 || lock.configVersion !== 1)
    throw new Error('Unsupported Bun lockfile schema');
  const packageName = '@biomejs/biome';
  const requirement = root.devDependencies?.[packageName];
  if (
    !requirement ||
    lock.workspaces['']?.name !== root.name ||
    lock.workspaces[''].devDependencies?.[packageName] !== requirement
  )
    throw new Error('bun.lock has a stale root Biome declaration');
  const record = (name: string, range: string) => {
    const entry = lock.packages[name];
    if (
      !entry?.[0].startsWith(`${name}@`) ||
      entry[1] !== '' ||
      !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry[3] ?? '')
    )
      throw new Error(`Missing integrity-bearing Biome lock entry for ${name}`);
    const version = entry[0].slice(name.length + 1);
    if (!Bun.semver.satisfies(version, range))
      throw new Error(`Locked ${name}@${version} does not satisfy ${range}`);
    return { package: name, version, integrity: entry[3] };
  };
  const wrapper = record(packageName, requirement);
  const platformName = '@biomejs/cli-linux-x64';
  const platformRequirement = lock.packages[packageName][2].optionalDependencies?.[platformName];
  if (platformRequirement !== wrapper.version)
    throw new Error('Biome native binary is not bound to the declared formatter version');
  const platform = record(platformName, platformRequirement);
  if (
    lock.packages[platformName][2].os !== 'linux' ||
    lock.packages[platformName][2].cpu !== 'x64' ||
    platform.version !== wrapper.version
  )
    throw new Error('Biome source checks require the locked Linux x64 binary');
  return { ...platform, wrapper, platform: { os: 'linux', cpu: 'x64' } };
}

type WorkflowToolPin = {
  version: string;
  repository: string;
  assets: { 'linux-amd64': { url: string; sha256: string; binary_path: string } };
};

export function importWorkflowMetadata(manifest: Record<string, WorkflowToolPin>) {
  return Object.fromEntries(
    ['actionlint', 'zizmor', 'shellcheck'].map((name) => {
      const pin = manifest[name];
      const asset = pin?.assets?.['linux-amd64'];
      if (
        !pin ||
        !/^\d+[.]\d+[.]\d+$/u.test(pin.version) ||
        !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u.test(pin.repository) ||
        !asset ||
        !asset.url.startsWith(
          'https://github.com/' + pin.repository + '/releases/download/v' + pin.version + '/',
        ) ||
        !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
        !asset.binary_path ||
        asset.binary_path.split('/').some((part) => !part || part === '.' || part === '..') ||
        asset.binary_path.includes('\\')
      )
        throw new Error('Expected an exact conventional Linux x64 workflow tool pin: ' + name);
      const parts = asset.binary_path.split('/');
      const binary = parts.pop();
      if (binary !== name)
        throw new Error('Workflow tool binary must match its declared identity: ' + name);
      return [
        name,
        {
          version: pin.version,
          url: asset.url,
          sha256: asset.sha256,
          stripPrefix: parts.join('/'),
          binary,
        },
      ];
    }),
  );
}

if (import.meta.main) {
  const [manifest, lockfile, tools] = Bun.argv.slice(2);
  if (!manifest || !lockfile || !tools)
    throw new Error('Expected root package.json, bun.lock and maintainer-tools.toml');
  console.log(
    JSON.stringify({
      biome: importBiomeMetadata(
        JSON.parse(readFileSync(manifest, 'utf8')),
        Bun.JSONC.parse(readFileSync(lockfile, 'utf8')),
      ),
      workflow: importWorkflowMetadata(
        Bun.TOML.parse(readFileSync(tools, 'utf8')) as Record<string, WorkflowToolPin>,
      ),
    }),
  );
}
