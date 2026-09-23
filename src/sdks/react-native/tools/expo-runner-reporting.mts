import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import assert from 'node:assert/strict';
function extensionReceipt(reportFile, metadataFile, platform, candidateSha, candidateTree) {
  const payload = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(candidateSha) || !/^[0-9a-f]{40}$/.test(candidateTree)) {
    throw new Error(
      `${platform} installed-app receipt requires full candidate commit and tree IDs`,
    );
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${platform} app PASS receipt must be a JSON object`);
  }
  const expectedKeys = [
    'allExtensionsActivated',
    'catalogProfile',
    'extensionCatalogSha256',
    'extensionCatalogComplete',
    'extensionCount',
    'icuRuntimeProof',
    'pgTextsearchEnglishBm25',
    'platform',
    'runner',
    'schema',
  ].sort();
  const actualKeys = Object.keys(payload).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${platform} app PASS receipt keys mismatch: expected=${expectedKeys.join(',')}; actual=${actualKeys.join(',')}`,
    );
  }
  if (
    payload.schema !== 'oliphaunt-expo-smoke-pass-v4' ||
    payload.runner !== 'smoke' ||
    payload.platform !== platform
  ) {
    throw new Error(`${platform} app PASS receipt schema, runner, or platform identity mismatch`);
  }
  const expectedIcu = process.env.OLIPHAUNT_MOBILE_E2E_EXPECT_ICU;
  const expectedCatalogProfile = process.env.OLIPHAUNT_MOBILE_E2E_EXPECT_CATALOG_PROFILE;
  if (expectedIcu !== '0' && expectedIcu !== '1') {
    throw new Error(`${platform} app PASS receipt requires an exact artifact ICU expectation`);
  }
  if (payload.icuRuntimeProof !== (expectedIcu === '1')) {
    throw new Error(
      `${platform} app PASS ICU runtime proof does not match the exact artifact selection`,
    );
  }
  if (
    (expectedCatalogProfile !== 'standard' && expectedCatalogProfile !== 'icu') ||
    payload.catalogProfile !== expectedCatalogProfile
  ) {
    throw new Error(
      `${platform} app PASS catalog profile does not match the selected packaged cluster seed`,
    );
  }
  const passEventBytes = Buffer.byteLength(`OLIPHAUNT_EXPO_SMOKE_PASS ${JSON.stringify(payload)}`);
  if (passEventBytes > 768) {
    throw new Error(
      `${platform} app PASS receipt exceeds the 768-byte unified-log-safe event budget: ${passEventBytes}`,
    );
  }
  const expected = (metadata.extensions ?? []).map((row) => row['sql-name']).sort();
  if (expected.length === 0 || new Set(expected).size !== expected.length) {
    throw new Error(
      `${platform} generated mobile catalog must contain a nonempty unique release extension set`,
    );
  }
  if (
    payload.extensionCount !== expected.length ||
    payload.allExtensionsActivated !== true ||
    payload.extensionCatalogComplete !== true ||
    payload.pgTextsearchEnglishBm25 !== expected.includes('pg_textsearch')
  ) {
    throw new Error(
      `${platform} app PASS receipt must prove exact activation, catalog completeness, and required functional checks`,
    );
  }
  const catalogSha256 = metadata['extension-catalog-sha256'];
  if (!/^[0-9a-f]{64}$/.test(catalogSha256) || payload.extensionCatalogSha256 !== catalogSha256) {
    throw new Error(`${platform} app PASS receipt generated-catalog digest mismatch`);
  }
  const receipt = {
    schema: 'oliphaunt-mobile-installed-extension-proof-v1',
    platform,
    catalogProfile: expectedCatalogProfile,
    candidateSha,
    candidateTree,
    extensionCount: expected.length,
    extensions: expected,
    extensionCatalogSha256: catalogSha256,
    appPassPayloadSha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
  return receipt;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'json-object': {
    const file = args[0];
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${file} must contain a JSON object`);
    }
    break;
  }
  case 'parse-pass': {
    const input = process.env.OLIPHAUNT_EXPO_LOG_LINE || fs.readFileSync(0, 'utf8').trim();
    const tag = process.env.OLIPHAUNT_EXPO_LOG_TAG;
    let payload;

    function escapeRegExp(value) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    try {
      const jsonStart = input.indexOf('{');
      if (jsonStart >= 0) {
        const event = JSON.parse(input.slice(jsonStart));
        if (Array.isArray(event.data)) {
          const index = event.data.indexOf(tag);
          if (index >= 0) {
            payload = event.data[index + 1];
          }
        }
      }
    } catch {}

    if (payload === undefined) {
      const tagIndex = input.indexOf(tag);
      if (tagIndex >= 0) {
        const rest = input.slice(tagIndex + tag.length);
        const jsonStart = rest.indexOf('{');
        if (jsonStart >= 0) {
          payload = rest.slice(jsonStart).trim();
        }
      }
    }

    if (payload === undefined) {
      const reactNativeMatch = input.match(
        new RegExp(`ReactNativeJS:\\s*'${escapeRegExp(tag)}',\\s*'([\\s\\S]*)'\\s*$`),
      );
      if (reactNativeMatch) {
        payload = reactNativeMatch[1];
      }
    }

    if (typeof payload === 'string') {
      payload = payload.trim();
      if (payload.startsWith("'") && payload.endsWith("'")) {
        payload = payload.slice(1, -1);
      } else if (payload.endsWith("'")) {
        payload = payload.slice(0, -1);
      }
      payload = JSON.parse(payload);
    }
    if (payload === undefined) {
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    break;
  }
  case 'extension-receipt': {
    process.stdout.write(JSON.stringify(extensionReceipt(...args), null, 2) + '\n');
    break;
  }
  case 'verify-receipt': {
    const [report, receipt, ...identity] = args;
    assert.deepEqual(
      JSON.parse(fs.readFileSync(receipt, 'utf8')),
      extensionReceipt(report, ...identity),
      'mobile E2E receipt does not match the current report, catalog and candidate',
    );
    break;
  }
  case 'maestro-report': {
    const report = {
      runner: 'maestro',
      platform: process.env.OLIPHAUNT_MAESTRO_PLATFORM,
      appId: process.env.OLIPHAUNT_MAESTRO_APP_ID,
      flow: process.env.OLIPHAUNT_MAESTRO_FLOW,
      passedAt: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    break;
  }
  case 'maestro-pass': {
    const report = {
      runner: 'maestro',
      platform: process.env.OLIPHAUNT_MAESTRO_PLATFORM,
      appId: process.env.OLIPHAUNT_MAESTRO_APP_ID,
      flow: process.env.OLIPHAUNT_MAESTRO_FLOW,
    };
    process.stdout.write(`OLIPHAUNT_EXPO_MAESTRO_PASS ${JSON.stringify(report)}\n`);
    break;
  }
  case 'package-sizes': {
    const [report, artifactSizeKey, artifactBytes, rnPackageBytes] = args;
    const payload = {
      [artifactSizeKey]: Number(artifactBytes),
      rnPackageBytes: Number(rnPackageBytes),
    };
    fs.writeFileSync(report, `${JSON.stringify(payload, null, 2)}\n`);
    break;
  }
  case 'build-artifact': {
    const [
      report,
      platform,
      appArtifact,
      appArtifactBytes,
      rnPackage,
      rnPackageBytes,
      extensions,
      scratchRoot,
      ...metadataArgs
    ] = args;

    if (metadataArgs.length % 2 !== 0) {
      throw new Error('metadata arguments must be key/value pairs');
    }

    const metadata = {};
    for (let index = 0; index < metadataArgs.length; index += 2) {
      metadata[metadataArgs[index]] = metadataArgs[index + 1];
    }

    const payload = {
      schema: 'oliphaunt-react-native-mobile-build-v1',
      platform,
      ...metadata,
      appArtifact,
      appArtifactBytes: Number(appArtifactBytes),
      reactNativePackage: rnPackage,
      reactNativePackageBytes: Number(rnPackageBytes),
      selectedExtensions: extensions ? extensions.split(',').filter(Boolean) : [],
      scratchRoot,
    };
    fs.writeFileSync(report, `${JSON.stringify(payload, null, 2)}\n`);
    break;
  }
  case 'profile': {
    const [file, profile, field] = args;
    process.stdout.write(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[profile][field]);
    break;
  }
  default:
    throw new Error('unknown expo-runner-reporting command: ' + command);
}
