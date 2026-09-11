#!/usr/bin/env bash

# Shared report helpers for React Native Expo mobile runners. Platform runners
# own platform metrics and artifact copying; this file only normalizes runner
# pass/report JSON emitted from Metro logs or Maestro installed-app flows.

configure_mobile_catalog_profile_probe() {
  local profile="$1"
  local fixture="$root/database-resources/contracts/profile-probe.json"
  case "$profile" in
    standard | icu) ;;
    *)
      echo "unsupported mobile catalog profile: $profile" >&2
      return 1
      ;;
  esac
  [ -s "$fixture" ] || {
    echo "mobile catalog profile probe is missing: $fixture" >&2
    return 1
  }
  export EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE="$profile"
  export EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_SQL="$({
    bun "$root/sdks/react-native/tools/expo-runner-reporting.mts" profile "$fixture" "$profile" sql
  })"
  export EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_EXPECTED="$({
    bun "$root/sdks/react-native/tools/expo-runner-reporting.mts" profile "$fixture" "$profile" expected
  })"
}

require_nonempty_json_file() {
  local file="$1"
  local label="$2"
  if [ ! -s "$file" ]; then
    echo "$label is missing or empty: $file" >&2
    return 1
  fi
  local json_status=0
  bun "$root/sdks/react-native/tools/expo-runner-reporting.mts" json-object "$file" >/dev/null || json_status=$?
  if [ "$json_status" -ne 0 ]; then
    echo "$label is not valid JSON: $file" >&2
    return 1
  fi
}

export_mobile_e2e_icu_expectation_from_manifest() {
  local manifest="$1"
  local label="$2"
  local runtime_feature_rows runtime_features seed_manifest other_seed_manifest catalog_profile
  [ -s "$manifest" ] || {
    echo "$label runtime manifest is missing or empty: $manifest" >&2
    return 1
  }
  runtime_feature_rows="$(grep -c '^runtimeFeatures=' "$manifest" || true)"
  [ "$runtime_feature_rows" = "1" ] || {
    echo "$label runtime manifest must contain exactly one runtimeFeatures property" >&2
    return 1
  }
  runtime_features="$(
    awk -F= '$1 == "runtimeFeatures" { print substr($0, index($0, "=") + 1) }' "$manifest" |
      tr -d '\r'
  )"
  if printf '%s\n' "$runtime_features" | tr ',' '\n' | grep -Fxq icu; then
    export OLIPHAUNT_MOBILE_E2E_EXPECT_ICU=1
    catalog_profile=icu
    seed_manifest="$(dirname "$(dirname "$manifest")")/cluster-seed-icu/manifest.properties"
    other_seed_manifest="$(dirname "$(dirname "$manifest")")/cluster-seed/manifest.properties"
  else
    export OLIPHAUNT_MOBILE_E2E_EXPECT_ICU=0
    catalog_profile=standard
    seed_manifest="$(dirname "$(dirname "$manifest")")/cluster-seed/manifest.properties"
    other_seed_manifest="$(dirname "$(dirname "$manifest")")/cluster-seed-icu/manifest.properties"
  fi
  [ ! -e "$other_seed_manifest" ] || {
    echo "$label includes a cluster seed incompatible with catalogProfile=$catalog_profile" >&2
    return 1
  }
  # This is the assembled app's resource manifest. ICU selection determines the
  # expected catalog, but reopening an existing database does not require a seed.
  # Runners creating a new database separately require their requested seed.
  if [ -e "$seed_manifest" ]; then
    if [ "$(grep -c '^catalogProfile=' "$seed_manifest" || true)" != "1" ] ||
      ! grep -Fxq "catalogProfile=$catalog_profile" "$seed_manifest"; then
      echo "$label selected cluster seed does not declare catalogProfile=$catalog_profile" >&2
      return 1
    fi
  fi
  export OLIPHAUNT_MOBILE_E2E_EXPECT_CATALOG_PROFILE="$catalog_profile"
}

export_mobile_e2e_icu_expectation_from_android_apk() {
  local apk="$1"
  local label="$2"
  local extracted manifest member
  [ -f "$apk" ] || {
    echo "$label is missing: $apk" >&2
    return 1
  }
  extracted="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-android-runtime-manifests.XXXXXX")" || {
    echo "failed to create temporary $label runtime manifests" >&2
    return 1
  }
  manifest="$extracted/runtime/manifest.properties"
  mkdir -p "$extracted/runtime"
  local extract_status=0
  unzip -p "$apk" "assets/oliphaunt/runtime/manifest.properties" >"$manifest" ||
    extract_status=$?
  zipinfo -1 "$apk" >"$extracted/members" || extract_status=$?
  for member in cluster-seed cluster-seed-icu; do
    if grep -Fxq "assets/oliphaunt/$member/manifest.properties" "$extracted/members"; then
      mkdir -p "$extracted/$member"
      unzip -p "$apk" "assets/oliphaunt/$member/manifest.properties" >"$extracted/$member/manifest.properties" || extract_status=$?
    fi
  done
  if [ "$extract_status" -ne 0 ]; then
    rm -rf "$extracted"
    echo "$label resource manifests could not be read: $apk" >&2
    return 1
  fi
  local expectation_status=0
  export_mobile_e2e_icu_expectation_from_manifest "$manifest" "$label" ||
    expectation_status=$?
  rm -rf "$extracted"
  return "$expectation_status"
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
    bun "$root/sdks/react-native/tools/expo-runner-reporting.mts" parse-pass >"$report_tmp" || parse_status=$?
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
  local metadata="$root/extensions/generated/sdk/extensions.json"
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
  bun "$root/sdks/react-native/tools/expo-runner-reporting.mts" extension-receipt "$report" "$metadata" "$platform" "$candidate_sha" "$candidate_tree" >"$receipt_tmp" || receipt_status=$?
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
  local metadata="$root/extensions/generated/sdk/extensions.json"
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
  bun "$root/sdks/react-native/tools/expo-runner-reporting.mts" verify-receipt "$report" "$receipt" "$metadata" "$platform" "$candidate_sha" "$candidate_tree" >/dev/null || verify_status=$?
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
    bun "$root/sdks/react-native/tools/expo-runner-reporting.mts" maestro-report >"$reports_dir/$runner-report.json"
  OLIPHAUNT_MAESTRO_PLATFORM="$platform" \
    OLIPHAUNT_MAESTRO_APP_ID="$app_id" \
    OLIPHAUNT_MAESTRO_FLOW="$maestro_flow" \
    bun "$root/sdks/react-native/tools/expo-runner-reporting.mts" maestro-pass >"$reports_dir/$runner-pass.log"
}

write_mobile_package_size_report() {
  local artifact_size_key="$1"
  local artifact_bytes="$2"
  local rn_package_bytes="$3"
  local reports_dir="$scratch_root/reports"
  mkdir -p "$reports_dir"
  bun "$root/sdks/react-native/tools/expo-runner-reporting.mts" package-sizes "$reports_dir/$runner-package-sizes.json" "$artifact_size_key" "$artifact_bytes" "$rn_package_bytes"
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
  bun "$root/sdks/react-native/tools/expo-runner-reporting.mts" build-artifact "$report" "$platform" "$artifact" "$artifact_bytes" "$rn_package" "$rn_package_bytes" "$selected_extensions" "$report_scratch_root" "$@"
}
