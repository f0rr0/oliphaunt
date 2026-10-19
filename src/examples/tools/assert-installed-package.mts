import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

const [packageName, expectedVersion, resolverPackage] = process.argv.slice(2);
const resolvePaths = [process.cwd()];
if (resolverPackage) {
  const resolverPackageJson = require.resolve(`${resolverPackage}/package.json`, {
    paths: [process.cwd()],
  });
  resolvePaths.unshift(path.dirname(resolverPackageJson));
}
const packageJson = require.resolve(`${packageName}/package.json`, {
  paths: resolvePaths,
});
const data = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
if (data.version !== expectedVersion) {
  throw new Error(`${packageName} resolved version ${data.version}, expected ${expectedVersion}`);
}
const normalized = packageJson.split(path.sep).join('/');
if (!normalized.includes('/node_modules/')) {
  throw new Error(`${packageName} resolved outside node_modules: ${packageJson}`);
}
