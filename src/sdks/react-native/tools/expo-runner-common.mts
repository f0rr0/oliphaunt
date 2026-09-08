import * as fs from 'node:fs';

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'tarball-name': {
    const packageJson = args[0];
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    const name = String(pkg.name || '')
      .replace(/^@/, '')
      .replace(/\//g, '-');
    const version = String(pkg.version || '');
    if (!name || !version) {
      throw new Error(`package name/version is missing from ${packageJson}`);
    }
    process.stdout.write(`${name}-${version}.tgz`);
    break;
  }
  case 'urlencode': {
    process.stdout.write(encodeURIComponent(args[0]));
    break;
  }
  case 'patch-dependency': {
    const [packageJson, dependencySpec] = args;
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    pkg.dependencies ??= {};
    pkg.dependencies['@oliphaunt/react-native'] = dependencySpec;
    fs.writeFileSync(packageJson, `${JSON.stringify(pkg, null, 2)}\n`);
    break;
  }
  default:
    throw new Error('unknown expo-runner-common command: ' + command);
}
