import * as fs from 'node:fs';
import * as path from 'node:path';

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'workspace': {
    const [root, scratch, name] = args;
    if (path.resolve(root) === path.resolve(scratch))
      throw new Error('Expo scratch workspace must be outside the source root');
    const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const packages = ['sdks/react-native', 'examples/react-native-expo', 'sdks/ts-query'];
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'package.json'),
      JSON.stringify(
        {
          name,
          private: true,
          packageManager: source.packageManager,
          workspaces: { ...source.workspaces, packages },
          overrides: source.overrides,
          trustedDependencies: source.trustedDependencies,
        },
        null,
        2,
      ) + '\n',
    );
    fs.cpSync(path.join(root, 'sdks/ts-query'), path.join(scratch, 'sdks/ts-query'), {
      recursive: true,
      filter: (file) => path.basename(file) !== 'node_modules',
    });
    // This derived workspace changes the source package to a packed consumer.
    // Reuse resolved versions, allowing Bun to update its own ordinary lockfile.
    if (root !== scratch && fs.existsSync(path.join(root, 'bun.lock'))) {
      fs.copyFileSync(path.join(root, 'bun.lock'), path.join(scratch, 'bun.lock'));
    }
    break;
  }
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
