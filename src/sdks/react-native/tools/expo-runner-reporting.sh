#!/usr/bin/env bash

# Shared report helpers for React Native Expo mobile runners. Platform runners
# own platform metrics and artifact copying; this file only normalizes runner
# pass/report JSON emitted from Metro logs or Maestro installed-app flows.

write_runner_report() {
  local line="$1"
  local reports_dir="$scratch_root/reports"
  mkdir -p "$reports_dir"
  printf '%s\n' "$line" >"$reports_dir/$runner-pass.log"
  OLIPHAUNT_EXPO_LOG_TAG="$success_tag" \
    OLIPHAUNT_EXPO_LOG_LINE="$line" \
    node <<'NODE' >"$reports_dir/$runner-report.json" || true
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
  if [ -s "$reports_dir/$runner-report.json" ]; then
    echo "$runner report: $reports_dir/$runner-report.json" >&2
  fi
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
