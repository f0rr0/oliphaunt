import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { npmPublishedVersion } from '../../../../tools/release/check_registry_publication.mts';
import { sanitizedPublicEnvironment } from '../../../../tools/release/public-consumer-smoke.mts';

const root = path.resolve(import.meta.dir, '../../../..');
export function publishedConsumerDependencies(
  manifest = JSON.parse(readFileSync(path.join(root, 'sdks/ts/sdk/package.json'), 'utf8')),
) {
  return {
    '@oliphaunt/ts-query': manifest.dependencies['@oliphaunt/ts-query'],
    '@oliphaunt/liboliphaunt-linux-x64-gnu': manifest.oliphaunt.liboliphauntVersion,
    '@oliphaunt/broker-linux-x64-gnu': manifest.oliphaunt.brokerVersion,
    '@oliphaunt/node-direct-linux-x64-gnu': manifest.oliphaunt.nodeDirectAddonVersion,
  };
}

// Only a release of this SDK alone can replace all four candidate dependencies.
// Mixed releases continue to exercise their newly produced dependency artifacts.
export async function publishedConsumerInventory(products) {
  if (products.length !== 1 || products[0] !== 'oliphaunt-js') return null;
  const rows = await Promise.all(
    Object.entries(publishedConsumerDependencies()).map(async ([name, version]) => {
      const metadata = await npmPublishedVersion(name, version);
      if (metadata === undefined) return null;
      const integrity = metadata?.dist?.integrity;
      const tarball = metadata?.dist?.tarball;
      if (
        metadata?.name !== name ||
        metadata?.version !== version ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity ?? '') ||
        typeof tarball !== 'string' ||
        !tarball.startsWith('https://registry.npmjs.org/')
      )
        throw new Error(`invalid published npm dependency metadata: ${name}@${version}`);
      return { name, version, integrity, tarball };
    }),
  );
  return rows.every(Boolean) ? rows : null;
}

export function validPublishedConsumerInventory(inventory, manifest = undefined) {
  const dependencies = publishedConsumerDependencies(manifest);
  return (
    Array.isArray(inventory) &&
    inventory.length === Object.keys(dependencies).length &&
    Object.entries(dependencies).every(
      ([name, version]) =>
        inventory.filter(
          (row) =>
            row !== null &&
            typeof row === 'object' &&
            row.name === name &&
            row.version === version &&
            /^sha512-[A-Za-z0-9+/]{86}==$/.test(row.integrity ?? '') &&
            typeof row.tarball === 'string' &&
            row.tarball.startsWith('https://registry.npmjs.org/'),
        ).length === 1,
    )
  );
}

export function verifyPublishedConsumerInstall(destination, inventory) {
  const manifest = JSON.parse(
    readFileSync(path.join(destination, 'node_modules/@oliphaunt/ts/package.json'), 'utf8'),
  );
  if (!validPublishedConsumerInventory(inventory, manifest))
    throw new Error('published dependency inventory does not match the candidate SDK');
  const lock = Bun.JSONC.parse(readFileSync(path.join(destination, 'bun.lock'), 'utf8'));
  for (const row of inventory) {
    const installed = JSON.parse(
      readFileSync(path.join(destination, 'node_modules', row.name, 'package.json'), 'utf8'),
    );
    const entry = lock.packages?.[row.name];
    if (
      installed.name !== row.name ||
      installed.version !== row.version ||
      entry?.[0] !== `${row.name}@${row.version}` ||
      entry?.[1] !== '' ||
      entry?.[3] !== row.integrity
    )
      throw new Error(`published dependency identity/integrity mismatch: ${row.name}`);
  }
}

export function preparePublishedConsumerEnvironment(destination, inherited = process.env) {
  const home = path.join(destination, 'install-home');
  mkdirSync(home, { recursive: true });
  const userConfig = path.join(home, '.npmrc');
  const globalConfig = path.join(home, 'global.npmrc');
  for (const file of [userConfig, globalConfig])
    writeFileSync(file, 'registry=https://registry.npmjs.org/\nalways-auth=false\n');
  const env = sanitizedPublicEnvironment(
    {
      HOME: home,
      XDG_CONFIG_HOME: home,
      NPM_CONFIG_USERCONFIG: userConfig,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    },
    inherited,
  );
  for (const name of Object.keys(env)) if (/^BUN_|^NODE_OPTIONS$/i.test(name)) delete env[name];
  writeFileSync(
    path.join(destination, 'install-environment'),
    Object.entries(env)
      .map(([name, value]) => `${name}=${value}\0`)
      .join(''),
    { mode: 0o600 },
  );
  return env;
}

if (import.meta.main)
  verifyPublishedConsumerInstall(
    process.argv[2],
    JSON.parse(process.env.OLIPHAUNT_PUBLISHED_DEPENDENCIES ?? 'null'),
  );
