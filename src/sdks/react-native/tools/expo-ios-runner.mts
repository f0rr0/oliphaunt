import * as fs from 'node:fs';
import * as path from 'node:path';

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'configure-resource-dependencies': {
    const [workspaceFile, exampleFile, ...archives] = args;
    const { readPortableArchiveEntries } = await import(
      '../../../../tools/packaging/portable-archive.mts'
    );
    const candidates = archives.map((archive) => {
      const entry = readPortableArchiveEntries(archive).get('package/package.json');
      if (!entry?.isFile || entry.isSymbolicLink)
        throw new Error(`missing package manifest: ${archive}`);
      return {
        ...JSON.parse(Buffer.from(entry.data()).toString('utf8')),
        archive: path.resolve(archive),
      };
    });
    const [seed, icu] = candidates;
    if (
      !/^@oliphaunt\/seed-native-ios-datum64-(standard|icu)$/.test(seed?.name ?? '') ||
      candidates.length !== (seed.name.endsWith('-icu') ? 2 : 1)
    ) {
      throw new Error('iOS requires exactly the selected seed and its optional ICU carrier');
    }
    if (
      icu &&
      (icu.name !== '@oliphaunt/icu' ||
        !Bun.semver.satisfies(icu.version, seed.dependencies?.['@oliphaunt/icu'] ?? ''))
    ) {
      throw new Error('ICU candidate does not satisfy the selected seed dependency');
    }
    const workspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
    const example =
      path.resolve(workspaceFile) === path.resolve(exampleFile)
        ? workspace
        : JSON.parse(fs.readFileSync(exampleFile, 'utf8'));
    workspace.overrides ??= {};
    example.dependencies ??= {};
    for (const name of [
      '@oliphaunt/icu',
      '@oliphaunt/seed-native-ios-datum64-standard',
      '@oliphaunt/seed-native-ios-datum64-icu',
    ]) {
      delete workspace.overrides[name];
      delete example.dependencies[name];
    }
    for (const candidate of candidates) {
      const spec = `file:${candidate.archive}`;
      workspace.overrides[candidate.name] = spec;
      example.dependencies[candidate.name] = spec;
    }
    fs.writeFileSync(workspaceFile, `${JSON.stringify(workspace, null, 2)}\n`);
    fs.writeFileSync(exampleFile, `${JSON.stringify(example, null, 2)}\n`);
    break;
  }
  case 'configure-plugin': {
    const file = args[0];
    const extensions = args[1]
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const icu = ['1', 'true', 'yes'].includes(args[2].toLowerCase());
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const plugins = Array.isArray(value.expo?.plugins) ? value.expo.plugins : [];
    value.expo.plugins = plugins.filter((entry) => {
      const name = Array.isArray(entry) ? entry[0] : entry;
      return name !== '@oliphaunt/react-native';
    });
    value.expo.plugins.push([
      '@oliphaunt/react-native',
      { extensions, icu, seedProfile: icu ? 'icu' : 'standard' },
    ]);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    break;
  }
  case 'validate-pod-source': {
    const [lockfile, expectedRoot] = args;
    const document = Bun.YAML.parse(fs.readFileSync(lockfile, 'utf8'));
    const sources = document?.['EXTERNAL SOURCES'];
    const payload = sources?.OliphauntReactNativePayload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof payload[':path'] !== 'string' ||
      !payload[':path']
    )
      throw new Error('OliphauntReactNativePayload must be an app-owned path pod');
    if (
      [':git', ':http', ':tag', ':branch', ':commit', ':podspec'].some((key) =>
        Object.hasOwn(payload, key),
      )
    )
      throw new Error('app-owned payload must not declare a remote or podspec source');
    if (path.resolve(path.dirname(lockfile), payload[':path']) !== path.resolve(expectedRoot))
      throw new Error('app-owned payload resolved to the wrong directory');
    break;
  }
  case 'patch-weak-references': {
    for (const entry of fs.readdirSync(args[0], { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.swift')) continue;
      const file = path.join(entry.parentPath, entry.name);
      const before = fs.readFileSync(file, 'utf8');
      const after = before.replace(
        /\b(nonisolated\(unsafe\)\s+)?weak\s+(let|var)\b/g,
        'nonisolated(unsafe) weak var',
      );
      if (after !== before) fs.writeFileSync(file, after);
    }
    break;
  }
  default:
    throw Error('unknown iOS runner data command: ' + command);
}
