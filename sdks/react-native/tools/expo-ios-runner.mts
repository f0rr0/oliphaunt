import * as fs from 'node:fs';
import * as path from 'node:path';

const [command, ...args] = process.argv.slice(2);
switch (command) {
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
    value.expo.plugins.push(['@oliphaunt/react-native', { extensions, icu }]);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    break;
  }
  case 'validate-pod-source': {
    const [lockfile, expectedRoot, requireIcu] = args;
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
    const pods = (document.PODS ?? [])
      .map((entry) => (typeof entry === 'object' && entry !== null ? Object.keys(entry)[0] : entry))
      .filter(Boolean)
      .map((entry) => String(entry).split(/[\s(]/)[0]);
    if (
      requireIcu === '1' &&
      (pods.includes('OliphauntICU') ||
        Object.hasOwn(document['SPEC CHECKSUMS'] ?? {}, 'OliphauntICU') ||
        Object.hasOwn(sources, 'OliphauntICU'))
    )
      throw new Error('OliphauntICU must not be linked separately from the app-owned ICU payload');
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
