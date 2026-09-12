import * as fs from 'node:fs';
import * as path from 'node:path';

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'check-query-dependency': {
    const { readPortableArchiveEntries } = await import(
      '../../../tools/packaging/portable-archive.mts'
    );
    const manifests = args.map((archive) => {
      const entry = readPortableArchiveEntries(archive).get('package/package.json');
      if (!entry?.isFile || entry.isSymbolicLink)
        throw new Error(`missing regular package/package.json in ${archive}`);
      return JSON.parse(Buffer.from(entry.data()).toString('utf8'));
    });
    const [rn, query] = manifests;
    const requirement = rn.dependencies?.['@oliphaunt/ts-query'];
    if (rn.name !== '@oliphaunt/react-native' || query.name !== '@oliphaunt/ts-query')
      throw new Error('packed Expo consumer requires React Native and query package artifacts');
    if (typeof requirement !== 'string' || !Bun.semver.satisfies(query.version, requirement))
      throw new Error(
        `query candidate ${query.version} does not satisfy packed RN dependency ${requirement}`,
      );
    break;
  }
  case 'workspace': {
    const [root, scratch, name, queryArtifact] = args;
    if (path.resolve(root) === path.resolve(scratch))
      throw new Error('Expo scratch workspace must be outside the source root');
    const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (queryArtifact && !fs.statSync(queryArtifact).isFile())
      throw new Error(`query package artifact is not a file: ${queryArtifact}`);
    if (queryArtifact && !fs.existsSync(path.join(root, 'bun.lock')))
      throw new Error('packed Expo consumer requires the repository Bun lockfile');
    const packages = queryArtifact
      ? ['examples/react-native-expo']
      : ['sdks/react-native', 'examples/react-native-expo', 'sdks/ts-query'];
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'package.json'),
      JSON.stringify(
        {
          name,
          private: true,
          packageManager: source.packageManager,
          workspaces: { ...source.workspaces, packages },
          overrides: {
            ...source.overrides,
            ...(queryArtifact
              ? { '@oliphaunt/ts-query': `file:${path.resolve(queryArtifact)}` }
              : {}),
          },
          trustedDependencies: source.trustedDependencies,
        },
        null,
        2,
      ) + '\n',
    );
    if (queryArtifact) {
      fs.rmSync(path.join(scratch, 'sdks/ts-query'), { recursive: true, force: true });
    } else {
      fs.cpSync(path.join(root, 'sdks/ts-query'), path.join(scratch, 'sdks/ts-query'), {
        recursive: true,
        filter: (file) => path.basename(file) !== 'node_modules',
      });
    }
    // This derived workspace changes the source package to a packed consumer.
    // Reuse resolved versions, allowing Bun to update its own ordinary lockfile.
    if (root !== scratch && fs.existsSync(path.join(root, 'bun.lock'))) {
      if (queryArtifact) {
        // Bun cannot reconcile absent checkout workspace locators. Retain the
        // locked registry resolutions; Bun owns the candidate file dependency
        // records and the resulting consumer lockfile.
        const lock = Bun.JSONC.parse(fs.readFileSync(path.join(root, 'bun.lock'), 'utf8'));
        const checkoutPackages = new Set(
          Object.entries(lock.packages)
            .filter(([, row]) => (row as string[])[0].includes('@workspace:'))
            .map(([name]) => name),
        );
        lock.workspaces = Object.fromEntries(
          Object.entries(lock.workspaces).filter(
            ([directory]) => directory === '' || packages.includes(directory),
          ),
        );
        for (const workspace of Object.values(lock.workspaces)) {
          for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            if (!workspace[kind]) continue;
            workspace[kind] = Object.fromEntries(
              Object.entries(workspace[kind]).filter(([name]) => !checkoutPackages.has(name)),
            );
          }
        }
        lock.packages = Object.fromEntries(
          Object.entries(lock.packages).filter(
            ([, row]) => !(row as string[])[0].includes('@workspace:'),
          ),
        );
        fs.writeFileSync(path.join(scratch, 'bun.lock'), `${JSON.stringify(lock, null, 2)}\n`);
      } else {
        fs.copyFileSync(path.join(root, 'bun.lock'), path.join(scratch, 'bun.lock'));
      }
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
