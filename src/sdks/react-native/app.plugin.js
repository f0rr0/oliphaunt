const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const packageMetadata = require('./package.json');
const extensionMetadata = require('./src/generated/extensions.json');
const IOS_PODFILE_START = '# @oliphaunt/react-native begin';
const IOS_PODFILE_END = '# @oliphaunt/react-native end';
const ANDROID_APP_PLUGIN_RE = /id\s*(?:\(\s*)?['"]dev\.oliphaunt\.android['"]/;
const KNOWN_EXTENSION_SQL_NAMES = new Set(
  extensionMetadata.extensions.map((extension) => extension['sql-name']),
);
const MOBILE_RELEASE_READY_EXTENSION_SQL_NAMES = new Set(
  extensionMetadata.extensions
    .filter((extension) => extension['mobile-release-ready'] === true)
    .map((extension) => extension['sql-name']),
);

function normalizeOptions(options = {}) {
  const extensions = Array.isArray(options.extensions) ? options.extensions : [];
  const selected = [...new Set(extensions.map((value) => String(value).trim()).filter(Boolean))].sort();
  for (const extension of selected) {
    if (!EXTENSION_NAME_RE.test(extension)) {
      throw new Error(
        `@oliphaunt/react-native extension '${extension}' must be an exact PostgreSQL extension name`,
      );
    }
    if (!KNOWN_EXTENSION_SQL_NAMES.has(extension)) {
      throw new Error(
        `@oliphaunt/react-native extension '${extension}' is not in the generated exact-extension catalog`,
      );
    }
    if (!MOBILE_RELEASE_READY_EXTENSION_SQL_NAMES.has(extension)) {
      throw new Error(
        `@oliphaunt/react-native extension '${extension}' is known but does not have release-ready iOS/Android artifacts`,
      );
    }
  }
  return {
    extensions: selected,
    icu: Boolean(options.icu),
    liboliphauntVersion: optionalString(options.liboliphauntVersion),
    assetBaseUrl: optionalString(options.assetBaseUrl),
    kotlinPluginVersion: optionalString(options.kotlinPluginVersion) ?? packageMetadata.oliphaunt?.kotlinSdkVersion,
  };
}

function optionalString(value) {
  if (value == null) {
    return undefined;
  }
  const stringValue = String(value).trim();
  return stringValue.length > 0 ? stringValue : undefined;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function mergeProperties(file, entries) {
  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  }
  const keys = new Set(Object.keys(entries));
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      return true;
    }
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    return !keys.has(key);
  });
  for (const [key, value] of Object.entries(entries)) {
    if (value != null && String(value).trim() !== '') {
      kept.push(`${key}=${value}`);
    }
  }
  fs.writeFileSync(file, `${kept.join('\n').replace(/\n+$/, '')}\n`);
}

function iosPodfileBlock(options = {}) {
  const lines = [
    IOS_PODFILE_START,
    "oliphaunt_podspecs_path = File.expand_path('../node_modules/@oliphaunt/react-native/ios/podspecs', __dir__)",
    "pod 'COliphaunt', :podspec => File.join(oliphaunt_podspecs_path, 'COliphaunt.podspec'), :modular_headers => true",
    "pod 'Oliphaunt', :podspec => File.join(oliphaunt_podspecs_path, 'Oliphaunt.podspec')",
  ];
  if (options.icu === true) {
    lines.push(
      "oliphaunt_icu_podspec = File.expand_path('../node_modules/@oliphaunt/icu/OliphauntICU.podspec', __dir__)",
      "pod 'OliphauntICU', :podspec => oliphaunt_icu_podspec",
    );
  }
  lines.push(IOS_PODFILE_END);
  return lines.join('\n');
}

function replaceMarkedBlock(contents, block) {
  const start = contents.indexOf(IOS_PODFILE_START);
  const end = contents.indexOf(IOS_PODFILE_END);
  if (start === -1 && end === -1) {
    return undefined;
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error('ios/Podfile has a partial @oliphaunt/react-native managed block');
  }
  const lineStart = contents.lastIndexOf('\n', start) + 1;
  const indent = contents.slice(lineStart, start).match(/^[ \t]*/)?.[0] ?? '';
  const indentedBlock = block
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
  const afterEnd = end + IOS_PODFILE_END.length;
  return `${contents.slice(0, lineStart)}${indentedBlock}${contents.slice(afterEnd)}`;
}

function insertIosPodfileBlock(contents, options = {}) {
  const block = iosPodfileBlock(options);
  const replaced = replaceMarkedBlock(contents, block);
  if (replaced !== undefined) {
    return `${replaced.replace(/\n+$/, '')}\n`;
  }

  const lines = contents.split(/\r?\n/);
  const anchorIndex = lines.findIndex((line) => /config\s*=\s*use_native_modules!\s*/.test(line));
  const fallbackIndex = lines.findIndex((line) => /^\s*use_expo_modules!\s*$/.test(line));
  const insertAfter = anchorIndex >= 0 ? anchorIndex : fallbackIndex;
  if (insertAfter < 0) {
    throw new Error('ios/Podfile must call use_native_modules! or use_expo_modules! before Oliphaunt can add Swift SDK podspecs');
  }
  const indent = lines[insertAfter].match(/^\s*/)?.[0] ?? '';
  const indentedBlock = block
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
  lines.splice(insertAfter + 1, 0, indentedBlock);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function patchIosPodfile(file, options = {}) {
  if (!fs.existsSync(file)) {
    return false;
  }
  const before = fs.readFileSync(file, 'utf8');
  const after = insertIosPodfileBlock(before, options);
  if (after !== before) {
    fs.writeFileSync(file, after);
  }
  return true;
}

function androidPluginVersion(options) {
  return optionalString(options.kotlinPluginVersion) ?? packageMetadata.oliphaunt?.kotlinSdkVersion;
}

function androidAppPluginLine(version) {
  return `    id 'dev.oliphaunt.android' version '${version}'`;
}

function insertAppGradlePlugin(contents, version) {
  if (ANDROID_APP_PLUGIN_RE.test(contents)) {
    return `${contents.replace(/\n+$/, '')}\n`;
  }
  const lines = contents.split(/\r?\n/);
  const pluginsIndex = lines.findIndex((line) => /^\s*plugins\s*\{\s*$/.test(line));
  if (pluginsIndex < 0) {
    return `plugins {\n${androidAppPluginLine(version)}\n}\n\n${contents.replace(/\n+$/, '')}\n`;
  }
  let insertAt = pluginsIndex + 1;
  while (insertAt < lines.length && lines[insertAt].trim().startsWith('//')) {
    insertAt += 1;
  }
  lines.splice(insertAt, 0, androidAppPluginLine(version));
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function patchAndroidGradle(androidRoot, normalized) {
  const version = androidPluginVersion(normalized);
  if (!version) {
    throw new Error('@oliphaunt/react-native requires oliphaunt.kotlinSdkVersion metadata or kotlinPluginVersion');
  }
  const appBuildGradle = path.join(androidRoot, 'app', 'build.gradle');
  if (fs.existsSync(appBuildGradle)) {
    const before = fs.readFileSync(appBuildGradle, 'utf8');
    const after = insertAppGradlePlugin(before, version);
    if (after !== before) {
      fs.writeFileSync(appBuildGradle, after);
    }
  }
}

function withOliphaunt(config, options = {}) {
  const plugin = require('expo/config-plugins');
  const normalized = normalizeOptions(options);

  config = plugin.withDangerousMod(config, [
    'android',
    (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      const androidRoot = path.join(projectRoot, 'android');
      writeJson(path.join(androidRoot, 'oliphaunt.json'), normalized);
      mergeProperties(path.join(androidRoot, 'gradle.properties'), {
        oliphauntExtensions: normalized.extensions.join(','),
        oliphauntIcu: normalized.icu ? 'true' : undefined,
        oliphauntLiboliphauntVersion: normalized.liboliphauntVersion,
        oliphauntAssetBaseUrl: normalized.assetBaseUrl,
      });
      patchAndroidGradle(androidRoot, normalized);
      return modConfig;
    },
  ]);

  config = plugin.withDangerousMod(config, [
    'ios',
    (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      const iosRoot = path.join(projectRoot, 'ios');
      writeJson(path.join(iosRoot, 'oliphaunt.json'), normalized);
      writeJson(path.join(iosRoot, 'OliphauntExtensions.json'), {
        extensions: normalized.extensions,
        icu: normalized.icu,
        liboliphauntVersion: normalized.liboliphauntVersion,
        assetBaseUrl: normalized.assetBaseUrl,
      });
      patchIosPodfile(path.join(iosRoot, 'Podfile'), normalized);
      return modConfig;
    },
  ]);

  return config;
}

module.exports = withOliphaunt;
module.exports.withOliphaunt = withOliphaunt;
module.exports.normalizeOptions = normalizeOptions;
module.exports.insertIosPodfileBlock = insertIosPodfileBlock;
module.exports.iosPodfileBlock = iosPodfileBlock;
module.exports.insertAppGradlePlugin = insertAppGradlePlugin;
