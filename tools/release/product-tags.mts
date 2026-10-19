import { readFileSync } from 'node:fs';
import path from 'node:path';

// Tags depend on release-please's canonical version files, not the build task graph.
const config = JSON.parse(readFileSync('release-please-config.json', 'utf8'));
if (config['include-v-in-tag'] !== true || config['tag-separator'] !== '-')
  throw new Error('release-please must use product-vVERSION tags');
const argv = process.argv.slice(2);
const products = argv[0] === '--products-json' && argv.length === 2 ? JSON.parse(argv[1]) : argv;
if (
  !Array.isArray(products) ||
  !products.every((product) => typeof product === 'string' && product)
)
  throw new Error('products must be a non-empty JSON string array');
if (!products.length) throw new Error('at least one release product is required');
for (const product of [...new Set(products)].sort()) {
  const entry = Object.entries(config.packages).find(([, value]) => value.component === product);
  if (!entry) throw new Error(`unknown release product ${JSON.stringify(product)}`);
  const [packagePath, metadata] = entry;
  const versionFile =
    metadata['version-file'] ??
    (metadata['release-type'] === 'rust'
      ? 'Cargo.toml'
      : ['node', 'expo'].includes(metadata['release-type'])
        ? 'package.json'
        : undefined);
  if (!versionFile || path.isAbsolute(versionFile) || versionFile.split(/[\\/]/u).includes('..'))
    throw new Error(`${product} must declare a version file inside its package`);
  const text = readFileSync(path.join(packagePath, versionFile), 'utf8');
  const basename = path.basename(versionFile);
  const version =
    basename === 'Cargo.toml'
      ? Bun.TOML.parse(text).package.version
      : basename === 'package.json'
        ? JSON.parse(text).version
        : basename === 'gradle.properties'
          ? text.match(/^VERSION_NAME\s*=\s*(\S+)\s*$/mu)?.[1]
          : ['VERSION', 'LIBOLIPHAUNT_VERSION'].includes(basename)
            ? text.trim()
            : undefined;
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(product) || !/^\d+\.\d+\.\d+$/u.test(version))
    throw new Error(`${product} must have a stable x.y.z release version`);
  process.stdout.write(`${product}-v${version}\n`);
}
