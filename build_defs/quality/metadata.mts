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

if (import.meta.main) {
  const [manifest, lockfile] = Bun.argv.slice(2);
  if (!manifest || !lockfile) throw new Error('Expected root package.json and bun.lock');
  console.log(
    JSON.stringify(
      importBiomeMetadata(
        JSON.parse(readFileSync(manifest, 'utf8')),
        Bun.JSONC.parse(readFileSync(lockfile, 'utf8')),
      ),
    ),
  );
}
