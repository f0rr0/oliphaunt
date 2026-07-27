#!/usr/bin/env bash

# Shared report helpers for React Native Expo mobile runners. Platform runners
# own platform metrics and artifact copying; this file only normalizes runner
# pass/report JSON emitted from Metro logs or Maestro installed-app flows.

require_nonempty_json_file() {
  local file="$1"
  local label="$2"
  if [ ! -s "$file" ]; then
    echo "$label is missing or empty: $file" >&2
    return 1
  fi
  local json_status=0
  node - "$file" <<'NODE' >/dev/null || json_status=$?
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (value === null || typeof value !== 'object' || Array.isArray(value)) {
  throw new Error(`${file} must contain a JSON object`);
}
NODE
  if [ "$json_status" -ne 0 ]; then
    echo "$label is not valid JSON: $file" >&2
    return 1
  fi
}

write_runner_report() {
  local line="$1"
  local reports_dir="$scratch_root/reports"
  local pass_log="$reports_dir/$runner-pass.log"
  local report="$reports_dir/$runner-report.json"
  local receipt="$reports_dir/$runner-extension-receipt.json"
  local pass_tmp=""
  local report_tmp=""
  if ! mkdir -p "$reports_dir"; then
    echo "failed to create $runner report directory: $reports_dir" >&2
    return 1
  fi
  if ! rm -f "$pass_log" "$report" "$receipt"; then
    echo "failed to clear stale $runner report outputs" >&2
    return 1
  fi
  if ! pass_tmp="$(mktemp "$reports_dir/.$runner-pass.XXXXXX")"; then
    echo "failed to create a temporary $runner PASS log" >&2
    return 1
  fi
  if ! printf '%s\n' "$line" >"$pass_tmp"; then
    rm -f "$pass_tmp" || true
    echo "failed to write the temporary $runner PASS log" >&2
    return 1
  fi
  if ! report_tmp="$(mktemp "$reports_dir/.$runner-report.XXXXXX")"; then
    rm -f "$pass_tmp" || true
    echo "failed to create a temporary $runner report" >&2
    return 1
  fi

  local parse_status=0
  OLIPHAUNT_EXPO_LOG_TAG="$success_tag" \
    OLIPHAUNT_EXPO_LOG_LINE="$line" \
    node <<'NODE' >"$report_tmp" || parse_status=$?
const fs = require('fs');
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
NODE
  if [ "$parse_status" -ne 0 ]; then
    rm -f "$pass_tmp" "$report_tmp" "$report" "$receipt" || true
    echo "failed to parse the authoritative $runner PASS payload" >&2
    return 1
  fi
  if ! require_nonempty_json_file "$report_tmp" "$runner report"; then
    rm -f "$pass_tmp" "$report_tmp" "$report" "$receipt" || true
    return 1
  fi
  if ! mv "$report_tmp" "$report"; then
    rm -f "$pass_tmp" "$report_tmp" "$report" "$receipt" || true
    echo "failed to publish the parsed $runner report: $report" >&2
    return 1
  fi
  if [ "$success_tag" = "OLIPHAUNT_EXPO_SMOKE_PASS" ]; then
    if ! verify_mobile_extension_smoke_receipt "${mobile_platform:?mobile runner must define mobile_platform}"; then
      rm -f "$pass_tmp" "$report" "$receipt" || true
      return 1
    fi
    if ! require_nonempty_json_file "$receipt" "$mobile_platform installed-app extension receipt"; then
      rm -f "$pass_tmp" "$report" "$receipt" || true
      return 1
    fi
  fi
  if ! mv "$pass_tmp" "$pass_log"; then
    rm -f "$pass_tmp" "$pass_log" "$report" "$receipt" || true
    echo "failed to publish the validated $runner PASS log: $pass_log" >&2
    return 1
  fi
  echo "$runner report: $report" >&2
}

verify_mobile_extension_smoke_receipt() {
  local platform="$1"
  local reports_dir="$scratch_root/reports"
  local report="$reports_dir/$runner-report.json"
  local receipt="$reports_dir/$runner-extension-receipt.json"
  local metadata="$root/src/extensions/generated/sdk/react-native.json"
  local candidate_sha="${CI_HEAD_SHA:-}"
  local candidate_tree
  local actual_sha
  local receipt_tmp=""
  if [ -z "$candidate_sha" ]; then
    candidate_sha="$(git rev-parse HEAD)" || {
      echo "failed to resolve mobile installed-app receipt candidate" >&2
      return 1
    }
  fi
  actual_sha="$(git rev-parse HEAD)" || {
    echo "failed to resolve current mobile installed-app candidate" >&2
    return 1
  }
  [ "$actual_sha" = "$candidate_sha" ] || {
    echo "mobile installed-app receipt candidate mismatch: expected $candidate_sha, got $actual_sha" >&2
    return 1
  }
  candidate_tree="$(git rev-parse 'HEAD^{tree}')" || {
    echo "failed to resolve mobile installed-app candidate tree" >&2
    return 1
  }
  if ! require_nonempty_json_file "$report" "$platform installed-app PASS report"; then
    return 1
  fi
  if ! receipt_tmp="$(mktemp "$reports_dir/.$runner-extension-receipt.XXXXXX")"; then
    echo "failed to create a temporary $platform installed-app extension receipt" >&2
    return 1
  fi
  local receipt_status=0
  node - "$report" "$metadata" "$platform" "$candidate_sha" "$candidate_tree" <<'NODE' >"$receipt_tmp" || receipt_status=$?
const fs = require('node:fs');
const crypto = require('node:crypto');
const [reportFile, metadataFile, platform, candidateSha, candidateTree] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
if (!/^[0-9a-f]{40}$/.test(candidateSha) || !/^[0-9a-f]{40}$/.test(candidateTree)) {
  throw new Error(`${platform} installed-app receipt requires full candidate commit and tree IDs`);
}
if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  throw new Error(`${platform} app PASS receipt must be a JSON object`);
}
const expectedKeys = [
  'extensionCatalogSha256',
  'extensionCount',
  'extensionProofCount',
  'platform',
  'runner',
  'schema',
].sort();
const actualKeys = Object.keys(payload).sort();
if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
  throw new Error(`${platform} app PASS receipt keys mismatch: expected=${expectedKeys.join(',')}; actual=${actualKeys.join(',')}`);
}
if (payload.schema !== 'oliphaunt-expo-smoke-pass-v1' || payload.runner !== 'smoke' || payload.platform !== platform) {
  throw new Error(`${platform} app PASS receipt schema, runner, or platform identity mismatch`);
}
const passEventBytes = Buffer.byteLength(`OLIPHAUNT_EXPO_SMOKE_PASS ${JSON.stringify(payload)}`);
if (passEventBytes > 768) {
  throw new Error(`${platform} app PASS receipt exceeds the 768-byte unified-log-safe event budget: ${passEventBytes}`);
}
const expected = (metadata.extensions ?? [])
  .filter(row => row['mobile-release-ready'] === true && (
    row.support?.mobile?.[platform] === undefined || row.support.mobile[platform] === 'supported'
  ))
  .map(row => row['sql-name'])
  .sort();
if (expected.length === 0 || new Set(expected).size !== expected.length) {
  throw new Error(`${platform} generated mobile catalog must contain a nonempty unique release extension set`);
}
if (
  payload.extensionCount !== expected.length ||
  payload.extensionProofCount !== expected.length + 1
) {
  throw new Error(`${platform} app PASS receipt must prove the exact derived extension and activation-check counts`);
}
const catalogSha256 = metadata['extension-catalog-sha256'];
if (!/^[0-9a-f]{64}$/.test(catalogSha256) || payload.extensionCatalogSha256 !== catalogSha256) {
  throw new Error(`${platform} app PASS receipt generated-catalog digest mismatch`);
}
const receipt = {
  schema: 'oliphaunt-mobile-installed-extension-proof-v1',
  platform,
  candidateSha,
  candidateTree,
  extensionCount: expected.length,
  extensions: expected,
  extensionCatalogSha256: catalogSha256,
  appPassPayloadSha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
NODE
  if [ "$receipt_status" -ne 0 ]; then
    rm -f "$receipt_tmp" "$receipt" || true
    echo "$platform installed-app extension receipt verification failed" >&2
    return 1
  fi
  if ! require_nonempty_json_file "$receipt_tmp" "$platform installed-app extension receipt"; then
    rm -f "$receipt_tmp" "$receipt" || true
    return 1
  fi
  if ! mv "$receipt_tmp" "$receipt"; then
    rm -f "$receipt_tmp" "$receipt" || true
    echo "failed to publish $platform installed-app extension receipt: $receipt" >&2
    return 1
  fi
  echo "$platform installed-app extension receipt: $receipt" >&2
}

verify_mobile_e2e_smoke_receipt() {
  local platform="$1"
  local scratch="$2"
  local report="$scratch/reports/smoke-report.json"
  local receipt="$scratch/reports/smoke-extension-receipt.json"
  local metadata="$root/src/extensions/generated/sdk/react-native.json"
  local candidate_sha
  local candidate_tree
  candidate_sha="$(git rev-parse HEAD)" || {
    echo "failed to resolve mobile E2E candidate commit" >&2
    return 1
  }
  candidate_tree="$(git rev-parse 'HEAD^{tree}')" || {
    echo "failed to resolve mobile E2E candidate tree" >&2
    return 1
  }
  if ! require_nonempty_json_file "$report" "$platform mobile E2E PASS report"; then
    return 1
  fi
  if ! require_nonempty_json_file "$receipt" "$platform mobile E2E extension receipt"; then
    return 1
  fi

  local verify_status=0
  node - "$report" "$receipt" "$metadata" "$platform" "$candidate_sha" "$candidate_tree" <<'NODE' >/dev/null || verify_status=$?
const fs = require('node:fs');
const crypto = require('node:crypto');
const [reportFile, receiptFile, metadataFile, platform, candidateSha, candidateTree] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
const expectedReportKeys = [
  'extensionCatalogSha256',
  'extensionCount',
  'extensionProofCount',
  'platform',
  'runner',
  'schema',
].sort();
const actualReportKeys = Object.keys(report).sort();
if (JSON.stringify(actualReportKeys) !== JSON.stringify(expectedReportKeys)) {
  throw new Error(`${platform} mobile E2E PASS report keys mismatch`);
}
const expectedKeys = [
  'appPassPayloadSha256',
  'candidateSha',
  'candidateTree',
  'extensionCatalogSha256',
  'extensionCount',
  'extensions',
  'platform',
  'schema',
].sort();
const actualKeys = Object.keys(receipt).sort();
if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
  throw new Error(`${platform} mobile E2E extension receipt keys mismatch`);
}
if (
  receipt.schema !== 'oliphaunt-mobile-installed-extension-proof-v1' ||
  receipt.platform !== platform ||
  receipt.candidateSha !== candidateSha ||
  receipt.candidateTree !== candidateTree
) {
  throw new Error(`${platform} mobile E2E receipt is not bound to the exact candidate commit and tree`);
}
const expected = (metadata.extensions ?? [])
  .filter(row => row['mobile-release-ready'] === true && (
    row.support?.mobile?.[platform] === undefined || row.support.mobile[platform] === 'supported'
  ))
  .map(row => row['sql-name'])
  .sort();
if (
  expected.length === 0 ||
  report.schema !== 'oliphaunt-expo-smoke-pass-v1' ||
  report.runner !== 'smoke' ||
  report.platform !== platform ||
  report.extensionCount !== expected.length ||
  report.extensionProofCount !== expected.length + 1 ||
  report.extensionCatalogSha256 !== metadata['extension-catalog-sha256'] ||
  Buffer.byteLength(`OLIPHAUNT_EXPO_SMOKE_PASS ${JSON.stringify(report)}`) > 768 ||
  receipt.extensionCount !== expected.length ||
  !Array.isArray(receipt.extensions) ||
  JSON.stringify(receipt.extensions) !== JSON.stringify(expected)
) {
  throw new Error(`${platform} mobile E2E receipt does not prove the exact generated extension set`);
}
if (
  !/^[0-9a-f]{64}$/.test(receipt.extensionCatalogSha256) ||
  receipt.extensionCatalogSha256 !== metadata['extension-catalog-sha256'] ||
  !/^[0-9a-f]{64}$/.test(receipt.appPassPayloadSha256) ||
  receipt.appPassPayloadSha256 !== crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex')
) {
  throw new Error(`${platform} mobile E2E report/receipt digest mismatch`);
}
NODE
  if [ "$verify_status" -ne 0 ]; then
    echo "$platform mobile E2E extension receipt failed its outer postcondition: $receipt" >&2
    return 1
  fi
  echo "$platform mobile E2E extension receipt postcondition: $receipt" >&2
}

write_maestro_runner_report() {
  local platform="$1"
  local reports_dir="$scratch_root/reports"
  mkdir -p "$reports_dir"
  OLIPHAUNT_MAESTRO_PLATFORM="$platform" \
    OLIPHAUNT_MAESTRO_APP_ID="$app_id" \
    OLIPHAUNT_MAESTRO_FLOW="$maestro_flow" \
    node <<'NODE' >"$reports_dir/$runner-report.json"
const report = {
  runner: 'maestro',
  platform: process.env.OLIPHAUNT_MAESTRO_PLATFORM,
  appId: process.env.OLIPHAUNT_MAESTRO_APP_ID,
  flow: process.env.OLIPHAUNT_MAESTRO_FLOW,
  passedAt: new Date().toISOString(),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
NODE
  OLIPHAUNT_MAESTRO_PLATFORM="$platform" \
    OLIPHAUNT_MAESTRO_APP_ID="$app_id" \
    OLIPHAUNT_MAESTRO_FLOW="$maestro_flow" \
    node <<'NODE' >"$reports_dir/$runner-pass.log"
const report = {
  runner: 'maestro',
  platform: process.env.OLIPHAUNT_MAESTRO_PLATFORM,
  appId: process.env.OLIPHAUNT_MAESTRO_APP_ID,
  flow: process.env.OLIPHAUNT_MAESTRO_FLOW,
};
process.stdout.write(`OLIPHAUNT_EXPO_MAESTRO_PASS ${JSON.stringify(report)}\n`);
NODE
}

write_mobile_package_size_report() {
  local artifact_size_key="$1"
  local artifact_bytes="$2"
  local rn_package_bytes="$3"
  local reports_dir="$scratch_root/reports"
  mkdir -p "$reports_dir"
  node - "$reports_dir/$runner-package-sizes.json" "$artifact_size_key" "$artifact_bytes" "$rn_package_bytes" <<'NODE'
const fs = require('node:fs');
const [report, artifactSizeKey, artifactBytes, rnPackageBytes] = process.argv.slice(2);
const payload = {
  [artifactSizeKey]: Number(artifactBytes),
  rnPackageBytes: Number(rnPackageBytes),
};
fs.writeFileSync(report, `${JSON.stringify(payload, null, 2)}\n`);
NODE
}

write_mobile_build_artifact_report_json() {
  local report="$1"
  local platform="$2"
  local artifact="$3"
  local artifact_bytes="$4"
  local rn_package="$5"
  local rn_package_bytes="$6"
  local selected_extensions="$7"
  local report_scratch_root="$8"
  shift 8
  node - "$report" "$platform" "$artifact" "$artifact_bytes" "$rn_package" "$rn_package_bytes" "$selected_extensions" "$report_scratch_root" "$@" <<'NODE'
const fs = require('node:fs');
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
] = process.argv.slice(2);

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
NODE
}
