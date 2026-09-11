import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'metadata': {
    const manifest = JSON.parse(require('node:fs').readFileSync(args[0], 'utf8'));
    const values = [
      manifest.oliphaunt?.runtimeVersion,
      manifest.oliphaunt?.addonAbiVersion,
      manifest.oliphaunt?.nodeApiVersion,
    ];
    if (
      !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(values[0] ?? '') ||
      !Number.isSafeInteger(values[1]) ||
      !Number.isSafeInteger(values[2])
    ) {
      throw new Error('WASIX N-API package metadata has an invalid runtime/ABI contract');
    }
    process.stdout.write(values.join('\t'));
    break;
  }
  case 'check-addon': {
    const { readFileSync, statSync } = require('node:fs');
    const { resolve } = require('node:path');

    const [addonPath, expectedRuntime, expectedAbiRaw, expectedNodeApiRaw, buildInputsPath] = args;
    const expectedAbi = Number(expectedAbiRaw);
    const expectedNodeApi = Number(expectedNodeApiRaw);
    const buildInputs = JSON.parse(readFileSync(buildInputsPath, 'utf8'));
    const expectedFunctions = [
      'addonAbiVersion',
      'extensionIdentity',
      'nodeApiVersion',
      'payloadIdentity',
      'restore',
      'restoreDirect',
      'runtimeVersion',
      'supportedProfiles',
    ];
    const expectedDatabaseMethods = [
      'backup',
      'close',
      'execProtocolRaw',
      'execProtocolRawStream',
      'pgDump',
      'psql',
    ];
    const expectedServerMethods = ['close'];
    const addon = require(addonPath);
    for (const name of expectedFunctions) {
      if (typeof addon[name] !== 'function') {
        throw new Error(`${addonPath} is missing function export ${name}`);
      }
    }
    if (
      addon.addonAbiVersion() !== expectedAbi ||
      addon.nodeApiVersion() !== expectedNodeApi ||
      addon.runtimeVersion() !== expectedRuntime ||
      JSON.stringify(addon.supportedProfiles()) !== JSON.stringify(['standard', 'icu'])
    ) {
      throw new Error(`${addonPath} reports an incompatible ABI/runtime/profile contract`);
    }

    function expectedIdentity(record, kind) {
      if (typeof record?.path !== 'string' || !/^[0-9a-f]{64}$/.test(record?.sha256 ?? '')) {
        throw new Error(`${buildInputsPath} has an invalid ${kind} record`);
      }
      const size = statSync(resolve(record.path)).size;
      if (!Number.isSafeInteger(size) || size < 1) {
        throw new Error(`${record.path} has an invalid ${kind} size: ${size}`);
      }
      return `${record.sha256}:${size}`;
    }

    const portableExtensions = (buildInputs.inputs?.extensionArtifacts ?? []).flatMap(
      ({ portableArchives = [] }) => portableArchives,
    );
    const extensionNames = portableExtensions.map(({ sqlName }) => sqlName);
    if (
      extensionNames.length === 0 ||
      extensionNames.some((name) => typeof name !== 'string' || name.length === 0) ||
      new Set(extensionNames).size !== extensionNames.length
    ) {
      throw new Error(`${buildInputsPath} has an invalid portable extension inventory`);
    }
    for (const extension of portableExtensions) {
      const actual = addon.extensionIdentity(extension.sqlName);
      const expected = expectedIdentity(extension, `${extension.sqlName} extension`);
      if (actual !== expected) {
        throw new Error(
          `${addonPath} reports ${extension.sqlName} extension identity ${actual}; expected ${expected}`,
        );
      }
    }
    for (const component of ['runtimeArchive']) {
      const identity = addon.payloadIdentity(component);
      if (!/^[0-9a-f]{64}:[1-9][0-9]*$/.test(identity)) {
        throw new Error(`${addonPath} reports an invalid ${component} identity: ${identity}`);
      }
    }
    for (const constructorName of ['NativeWasixActorDatabase', 'NativeWasixDatabase']) {
      if (typeof addon[constructorName]?.open !== 'function') {
        throw new Error(`${addonPath} is missing ${constructorName}.open`);
      }
      for (const name of expectedDatabaseMethods) {
        if (typeof addon[constructorName].prototype[name] !== 'function') {
          throw new Error(`${addonPath} is missing ${constructorName}.prototype.${name}`);
        }
      }
    }
    if (typeof addon.NativeWasixServer?.open !== 'function') {
      throw new Error(`${addonPath} is missing NativeWasixServer.open`);
    }
    for (const name of expectedServerMethods) {
      if (typeof addon.NativeWasixServer.prototype[name] !== 'function') {
        throw new Error(`${addonPath} is missing NativeWasixServer.prototype.${name}`);
      }
    }
    break;
  }
  default:
    throw Error(`unknown native build data command: ${command}`);
}
