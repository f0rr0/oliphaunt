#!/usr/bin/env bash
# Shared iOS simulator, physical-device, and signing helpers for the Expo
# installed-app runner. This file is sourced by expo-ios-runner.sh.

select_ios_simulator_udid() {
  if [ -n "$simulator_udid" ]; then
    printf '%s\n' "$simulator_udid"
    return
  fi

  local booted
  booted="$(
    xcrun simctl list devices booted -j |
      node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
for (const devices of Object.values(data.devices || {})) {
  const found = devices.find(device => device.isAvailable && device.state === "Booted");
  if (found) {
    process.stdout.write(found.udid);
    process.exit(0);
  }
}
'
  )"
  if [ -n "$booted" ]; then
    printf '%s\n' "$booted"
    return
  fi

  xcrun simctl list devices available -j |
    OLIPHAUNT_EXPO_IOS_DEVICE_NAME="$simulator_name" node -e '
const fs = require("fs");
const preferredName = process.env.OLIPHAUNT_EXPO_IOS_DEVICE_NAME || "iPhone 15 Pro";
const preferredRuntime = process.env.OLIPHAUNT_EXPO_IOS_RUNTIME || "";
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const candidates = [];
for (const [runtime, devices] of Object.entries(data.devices || {})) {
  if (!runtime.includes("iOS")) {
    continue;
  }
  const versionMatch = runtime.match(/iOS-(\d+)-(\d+)/);
  const major = versionMatch ? Number(versionMatch[1]) : 0;
  const minor = versionMatch ? Number(versionMatch[2]) : 0;
  for (const device of devices) {
    if (!device.isAvailable) {
      continue;
    }
    const exactName = device.name === preferredName ? 1 : 0;
    const iphone = device.name.startsWith("iPhone") ? 1 : 0;
    const runtimeMatch = preferredRuntime && runtime.includes(preferredRuntime) ? 1 : 0;
    candidates.push({device, exactName, iphone, runtimeMatch, major, minor});
  }
}
candidates.sort((left, right) =>
  right.runtimeMatch - left.runtimeMatch ||
  right.exactName - left.exactName ||
  right.iphone - left.iphone ||
  right.major - left.major ||
  right.minor - left.minor ||
  (left.device.name < right.device.name ? -1 : left.device.name > right.device.name ? 1 : 0)
);
if (!candidates.length) {
  process.exit(1);
}
process.stdout.write(candidates[0].device.udid);
'
}

select_ios_physical_device_id() {
  if [ -n "$physical_device_id" ]; then
    printf '%s\n' "$physical_device_id"
    return
  fi

  mkdir -p "$scratch_root"
  local json="$scratch_root/devicectl-devices.json"
  xcrun devicectl list devices --timeout 10 --json-output "$json" >/dev/null 2>&1 ||
    return 1
  node - "$json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const devices = data?.result?.devices ?? [];
const candidates = devices.filter(device => {
  const hardware = device.hardwareProperties ?? {};
  const connection = device.connectionProperties ?? {};
  return hardware.platform === 'iOS' &&
    hardware.reality === 'physical' &&
    connection.pairingState === 'paired';
});
candidates.sort((left, right) => {
  const leftLocal = left.connectionProperties?.transportType === 'localNetwork' ? 1 : 0;
  const rightLocal = right.connectionProperties?.transportType === 'localNetwork' ? 1 : 0;
  const leftName = String(left.deviceProperties?.name ?? '');
  const rightName = String(right.deviceProperties?.name ?? '');
  return rightLocal - leftLocal ||
    (leftName < rightName ? -1 : leftName > rightName ? 1 : 0);
});
if (!candidates.length) {
  process.exit(1);
}
process.stdout.write(candidates[0].identifier || candidates[0].hardwareProperties?.udid);
NODE
}

select_xcode_development_team() {
  {
    defaults read com.apple.dt.Xcode IDEProvisioningTeams 2>/dev/null || true
    defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null || true
  } |
    awk -F'= ' '/teamID =/ { value = $2; gsub(/[;[:space:]]/, "", value); print value }' |
    sort -u |
    awk 'NR == 1 { first = $0 } NR > 1 { multiple = 1 } END { if (!multiple && first != "") print first; else exit 1 }'
}

valid_code_signing_identity_count() {
  security find-identity -v -p codesigning 2>/dev/null |
    awk '/valid identities found/ { print $1; found = 1 } END { if (!found) print 0 }'
}

configure_iphoneos_signing() {
  [ "$sdk" = "iphoneos" ] || return 0

  if is_falsey "$code_signing_allowed"; then
    if is_physical_ios_launch; then
      fail "physical iOS runs require code signing; do not set OLIPHAUNT_EXPO_IOS_CODE_SIGNING_ALLOWED=NO for install/launch benchmarks"
    fi
    echo "iPhoneOS code signing disabled by OLIPHAUNT_EXPO_IOS_CODE_SIGNING_ALLOWED=$code_signing_allowed" >&2
    return 0
  fi

  if [ -z "$development_team" ]; then
    local selected_team
    selected_team="$(select_xcode_development_team || true)"
    if [ -n "$selected_team" ]; then
      development_team="$selected_team"
      echo "Using Xcode development team: $development_team" >&2
    fi
  fi

  [ -n "$development_team" ] ||
    fail "iPhoneOS builds require a development team; set OLIPHAUNT_EXPO_IOS_DEVELOPMENT_TEAM explicitly when Xcode has zero or multiple teams configured"

  if [ -z "$code_sign_style" ]; then
    code_sign_style=Automatic
  fi

  local identity_count
  identity_count="$(valid_code_signing_identity_count)"
  if [ "${identity_count:-0}" -eq 0 ]; then
    if ! is_truthy "$allow_provisioning_updates"; then
      fail "iPhoneOS builds require a local Apple Development signing identity; install one in Xcode or set OLIPHAUNT_EXPO_IOS_ALLOW_PROVISIONING_UPDATES=1 to let xcodebuild create/update signing assets"
    fi
    if [ -z "$allow_device_registration" ]; then
      allow_device_registration=1
    fi
    echo "No valid local code-signing identity found; using xcodebuild automatic provisioning updates" >&2
  fi
}

preflight_physical_ios_device() {
  is_physical_ios_launch || return 0

  local device_id
  device_id="$(select_ios_physical_device_id)" ||
    fail "failed to resolve a paired physical iOS device; set OLIPHAUNT_EXPO_IOS_DEVICE_ID"

  mkdir -p "$scratch_root"
  local json="$scratch_root/devicectl-device-details.json"
  xcrun devicectl device info details \
    --device "$device_id" \
    --timeout 10 \
    --json-output "$json" >/dev/null 2>&1 ||
    fail "failed to inspect physical iOS device with devicectl; device may be locked, untrusted, or unavailable"

  node - "$json" <<'NODE' || exit $?
const fs = require('fs');
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const result = data.result ?? {};
const props = result.deviceProperties ?? {};
const hardware = result.hardwareProperties ?? {};
const name = props.name ?? 'physical iOS device';
const os = props.osVersionNumber ?? 'unknown iOS';
const devMode = props.developerModeStatus ?? 'unknown';
if (devMode !== 'enabled') {
  console.error(`error: physical iOS runs require Developer Mode enabled on ${name}; current developerModeStatus=${devMode}, os=${os}`);
  process.exit(1);
}
if (props.ddiServicesAvailable === false) {
  const product = hardware.productType ?? 'unknown product';
  console.error(`error: physical iOS runs require Developer Disk Image services on ${name}; ddiServicesAvailable=false, product=${product}, os=${os}`);
  process.exit(1);
}
NODE
}

resolve_xcode_destination() {
  if [ -n "$destination" ]; then
    printf '%s\n' "$destination"
    return
  fi
  case "$sdk" in
    iphonesimulator)
      printf 'id=%s\n' "$(select_ios_simulator_udid)"
      ;;
    iphoneos)
      if is_physical_ios_launch; then
        printf 'id=%s\n' "$(select_ios_physical_device_id)"
      else
        printf 'generic/platform=iOS\n'
      fi
      ;;
    *)
      printf 'generic/platform=iOS Simulator\n'
      ;;
  esac
}

boot_ios_simulator() {
  local udid="$1"
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
}
