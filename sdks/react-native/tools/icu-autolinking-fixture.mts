import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { extractPortableArchiveTree } from '../../../tools/packaging/portable-archive.mts';

const [phase, root, ...args] = process.argv.slice(2);
const consumer = path.join(root, 'consumer');
const icuRoot = path.join(consumer, 'node_modules/@oliphaunt/icu');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value));

if (phase === 'prepare') {
  const [reactNativeTarball, icuSource, expoProject] = args;
  const resolver = createRequire(path.join(expoProject, 'package.json'));
  const dependencies = {};
  for (const name of [
    'react-native',
    '@react-native-community/cli',
    '@react-native-community/cli-platform-android',
    '@react-native-community/cli-platform-ios',
  ]) {
    const manifestPath = resolver.resolve(name + '/package.json');
    const manifest = readJson(manifestPath);
    dependencies[name] = manifest.version;
    const destination = path.join(consumer, 'node_modules', name);
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(
      path.dirname(manifestPath),
      destination,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    if (name === '@react-native-community/cli') {
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin['rnc-cli'];
      writeFileSync(path.join(root, 'cli'), path.join(path.dirname(manifestPath), bin));
    }
  }
  writeJson(path.join(consumer, 'package.json'), {
    name: 'oliphaunt-autolinking-consumer',
    private: true,
    dependencies: {
      ...dependencies,
      '@oliphaunt/react-native': '0.0.0',
      '@oliphaunt/icu': '0.0.0',
    },
  });
  extractPortableArchiveTree(
    reactNativeTarball,
    path.join(consumer, 'node_modules/@oliphaunt/react-native'),
    'package',
  );
  const source = path.join(root, 'icu-source');
  mkdirSync(source);
  for (const file of ['package.json', 'OliphauntICU.podspec'])
    cpSync(path.join(icuSource, file), path.join(source, file));
  cpSync(
    path.join(icuSource, 'react-native.config.cts'),
    path.join(source, 'react-native.config.js'),
  );
} else if (phase === 'extract') {
  extractPortableArchiveTree(args[0], icuRoot, 'package');
} else if (phase === 'control') {
  // Discovery must work when the opt-out is removed; an empty autolinker result cannot pass.
  rmSync(path.join(icuRoot, 'react-native.config.js'));
} else if (phase === 'check') {
  const [kind, platform, result] = args;
  const config = readJson(result);
  assert.ok(
    config.dependencies?.['@oliphaunt/react-native']?.platforms?.[platform],
    'React Native carrier must be discoverable',
  );
  const icu = config.dependencies?.['@oliphaunt/icu'];
  if (kind === 'candidate') {
    assert.equal(icu, undefined, 'ICU data package must opt out of native autolinking');
    const resolver = createRequire(path.join(consumer, 'package.json'));
    assert.equal(
      resolver.resolve('@oliphaunt/icu/package.json'),
      path.join(icuRoot, 'package.json'),
    );
  } else {
    assert.ok(
      icu?.platforms?.ios?.podspecPath,
      'ICU control without its opt-out must be discoverable',
    );
  }
} else {
  throw new Error('unknown autolinking fixture phase: ' + phase);
}
