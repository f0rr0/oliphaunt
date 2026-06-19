#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "package-native-extension-assets.sh: unable to determine repository root from $script_dir; run this script from a Git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "package-native-extension-assets.sh: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

source "$root/src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh"
packager="src/extensions/artifacts/native/tools/extension-artifact-packager.mjs"

target_id="${OLIPHAUNT_EXTENSION_TARGET:-${1:-}}"
case "$target_id" in
  macos-arm64|linux-x64-gnu|linux-arm64-gnu|windows-x64-msvc|ios-xcframework|android-arm64-v8a|android-x86_64)
    ;;
  "")
    fail "usage: OLIPHAUNT_EXTENSION_TARGET=<target> $0, where target is macos-arm64, linux-x64-gnu, linux-arm64-gnu, windows-x64-msvc, ios-xcframework, android-arm64-v8a, or android-x86_64"
    ;;
  *)
    fail "unsupported native extension artifact target: $target_id"
    ;;
esac

require awk
require bun

if [ "$target_id" = "ios-xcframework" ]; then
  require ditto
  require rsync
fi

extension_product="${OLIPHAUNT_EXTENSION_PRODUCT:-${2:-}}"
extension_products="${OLIPHAUNT_EXTENSION_PRODUCTS:-}"
if [ -n "$extension_product" ]; then
  if [ -n "$extension_products" ]; then
    extension_products="$extension_products,$extension_product"
  else
    extension_products="$extension_product"
  fi
fi
selected_sql_names=""
if [ -n "$extension_products" ]; then
  selected_sql_names="$(bun "$packager" selected-sql-names "$extension_products")"
fi

version="${OLIPHAUNT_EXTENSION_RELEASE_VERSION:-$(bun "$packager" product-version liboliphaunt-native)}"
default_out_dir="$root/target/extensions/native/release-assets/$target_id"
default_stage_root="$root/target/extensions/native/release-stage/$target_id"
if [ -n "$extension_product" ] && [ -z "${OLIPHAUNT_EXTENSION_PRODUCTS:-}" ]; then
  default_out_dir="$default_out_dir/$extension_product"
  default_stage_root="$default_stage_root/$extension_product"
fi
out_dir="${OLIPHAUNT_EXTENSION_RELEASE_ASSET_DIR:-$default_out_dir}"
stage_root="${OLIPHAUNT_EXTENSION_RELEASE_STAGE_ROOT:-$default_stage_root}"
catalog_file="$stage_root/extension-catalog.tsv"
legacy_extension_index="$out_dir/liboliphaunt-${version}-extension-assets.tsv"
native_asset_index="$out_dir/liboliphaunt-${version}-native-extension-assets.tsv"

rm -rf "$stage_root"
mkdir -p "$out_dir" "$stage_root"

csv_join() {
  paste -sd ',' -
}

catalog_rows() {
  awk -F '\t' 'NR > 1 { print }' "$catalog_file"
}

mobile_module_extensions_csv() {
  catalog_rows | awk -F '\t' -v selected="$selected_sql_names" '
    function selected_match(sql_name, selected, parts, count, i) {
      if (selected == "") {
        return 1
      }
      count = split(selected, parts, ",")
      for (i = 1; i <= count; i++) {
        if (parts[i] == sql_name) {
          return 1
        }
      }
      return 0
    }
    $8 == "yes" && $9 == "yes" && $4 != "-" && selected_match($1, selected) { print $1 }
  ' | csv_join
}

selected_sql_name_matches() {
  local sql_name="$1"
  local selected
  [ -n "$selected_sql_names" ] || return 0
  IFS=',' read -r -a selected <<<"$selected_sql_names"
  local item
  for item in "${selected[@]}"; do
    [ "$item" = "$sql_name" ] && return 0
  done
  return 1
}

require_file() {
  local path="$1"
  local description="$2"
  [ -f "$path" ] || fail "missing $description at $path"
}

require_dir() {
  local path="$1"
  local description="$2"
  [ -d "$path" ] || fail "missing $description at $path"
}

artifact_bytes() {
  local artifact="$1"
  require_file "$out_dir/$artifact" "release artifact $artifact"
  wc -c <"$out_dir/$artifact" | awk '{ print $1 }'
}

artifact_bytes_or_dash() {
  local artifact="${1:-}"
  if [ -z "$artifact" ] || [ "$artifact" = "-" ]; then
    printf '%s\n' '-'
    return 0
  fi
  artifact_bytes "$artifact"
}

write_indexes() {
  printf 'sql_name\tcreates_extension\tnative_module_stem\tdependencies\tshared_preload\tmobile_prebuilt\tmobile_static_archive_targets\truntime_artifact\tios_xcframework_artifact\tandroid_arm64_artifact\tandroid_x86_64_artifact\truntime_artifact_bytes\tios_xcframework_artifact_bytes\tandroid_arm64_artifact_bytes\tandroid_x86_64_artifact_bytes\tdata_files\n' >"$legacy_extension_index"
  printf 'sql_name\ttarget\tkind\tartifact\tartifact_bytes\n' >"$native_asset_index"
}

append_legacy_index_row() {
  local sql_name="$1"
  local creates_extension="$2"
  local stem="$3"
  local dependencies="$4"
  local shared_preload="$5"
  local mobile_prebuilt="$6"
  local mobile_targets="$7"
  local runtime_artifact="$8"
  local ios_artifact="${9:-}"
  local android_arm64_artifact="${10:-}"
  local android_x86_64_artifact="${11:-}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$sql_name" \
    "$creates_extension" \
    "$stem" \
    "$dependencies" \
    "$shared_preload" \
    "$mobile_prebuilt" \
    "$mobile_targets" \
    "${runtime_artifact:--}" \
    "${ios_artifact:--}" \
    "${android_arm64_artifact:--}" \
    "${android_x86_64_artifact:--}" \
    "$(artifact_bytes_or_dash "${runtime_artifact:-}")" \
    "$(artifact_bytes_or_dash "${ios_artifact:-}")" \
    "$(artifact_bytes_or_dash "${android_arm64_artifact:-}")" \
    "$(artifact_bytes_or_dash "${android_x86_64_artifact:-}")" \
    "${12:-}" >>"$legacy_extension_index"
}

append_native_asset_index_row() {
  local sql_name="$1"
  local kind="$2"
  local artifact="$3"
  [ -n "$artifact" ] && [ "$artifact" != "-" ] || return 0
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$sql_name" \
    "$target_id" \
    "$kind" \
    "$artifact" \
    "$(artifact_bytes "$artifact")" >>"$native_asset_index"
}

fetch_extension_source_assets() {
  if [ "${OLIPHAUNT_RELEASE_FETCH_ASSETS:-0}" != "1" ]; then
    echo "==> Source asset fetch handled by the source-inputs Moon dependency; set OLIPHAUNT_RELEASE_FETCH_ASSETS=1 for standalone refresh"
    return 0
  fi
  echo "==> Fetching pinned native runtime and extension source assets"
  bun tools/policy/fetch-sources.mjs native-runtime >/tmp/liboliphaunt-release-extension-assets-fetch.log
}

archive_swiftpm_xcframework() {
  local xcframework="$1"
  local output="$2"
  [ -d "$xcframework" ] || fail "missing SwiftPM XCFramework input at $xcframework"
  rm -f "$output"
  (
    cd "$(dirname "$xcframework")"
    ditto -c -k --keepParent "$(basename "$xcframework")" "$output"
  )
}

mobile_static_dependency_archive() {
  local work_root="$1"
  local dependency="$2"
  local dependency_root="$work_root/out/dependencies"
  local archive
  if archive="$(oliphaunt_mobile_static_dependency_archive_for_root "$dependency_root" "$dependency")"; then
    printf '%s\n' "$archive"
    return 0
  fi
  return 1
}

mobile_dependency_args=()

collect_mobile_static_dependency_archive_args() {
  local target="$1"
  local work_root="$2"
  local sql_name="$3"
  local dependency archive
  mobile_dependency_args=()
  while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    if ! archive="$(mobile_static_dependency_archive "$work_root" "$dependency")"; then
      fail "missing $target static dependency archive for $sql_name dependency $dependency under $work_root/out/dependencies"
    fi
    mobile_dependency_args+=(--mobile-static-dependency-archive "$target:$dependency:$archive")
  done < <(oliphaunt_mobile_static_extension_dependencies_for_target "$sql_name" "$target" || true)
}

module_suffix_for_target() {
  case "$target_id" in
    macos-*|ios-xcframework) printf 'dylib\n' ;;
    android-*) printf 'so\n' ;;
    linux-*) printf 'so\n' ;;
    windows-*) printf 'dll\n' ;;
    *) fail "no module suffix for target $target_id" ;;
  esac
}

host_extension_runtime_root() {
  case "$target_id" in
    macos-arm64)
      printf '%s\n' "${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18-extension-release-$target_id}/install"
      ;;
    linux-x64-gnu|linux-arm64-gnu)
      printf '%s\n' "${OLIPHAUNT_LINUX_WORK_ROOT:-$root/target/liboliphaunt-pg18-$target_id-extension-release}/install"
      ;;
    windows-x64-msvc)
      printf '%s\n' "${OLIPHAUNT_WINDOWS_WORK_ROOT:-$root/target/liboliphaunt-pg18-$target_id-extension-release}/install"
      ;;
    ios-xcframework|android-arm64-v8a|android-x86_64)
      case "$target_id" in
        ios-xcframework)
          printf '%s\n' "${OLIPHAUNT_EXTENSION_HOST_RUNTIME_ROOT:-$root/target/liboliphaunt-pg18-extension-release-$target_id/install}"
          ;;
        android-*)
          printf '%s\n' "${OLIPHAUNT_EXTENSION_HOST_RUNTIME_ROOT:-$root/target/liboliphaunt-pg18-linux-x64-gnu-extension-release/install}"
          ;;
      esac
      ;;
  esac
}

build_desktop_extension_runtime() {
  case "$target_id" in
    macos-arm64)
      [ "$(uname -s)" = "Darwin" ] || fail "$target_id extension artifacts must be built on macOS"
      env \
        OLIPHAUNT_WORK_ROOT="${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18-extension-release-$target_id}" \
        OLIPHAUNT_BUILD_EXTENSIONS=1 \
        OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES="$selected_sql_names" \
        src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh >/tmp/liboliphaunt-release-"$target_id"-extensions.log
      ;;
    linux-x64-gnu|linux-arm64-gnu)
      [ "$(uname -s)" = "Linux" ] || fail "$target_id extension artifacts must be built on Linux"
      env \
        OLIPHAUNT_LINUX_WORK_ROOT="${OLIPHAUNT_LINUX_WORK_ROOT:-$root/target/liboliphaunt-pg18-$target_id-extension-release}" \
        OLIPHAUNT_BUILD_EXTENSIONS=1 \
        OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES="$selected_sql_names" \
        src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh >/tmp/liboliphaunt-release-"$target_id"-extensions.log
      ;;
    windows-x64-msvc)
      env \
        OLIPHAUNT_WINDOWS_WORK_ROOT="${OLIPHAUNT_WINDOWS_WORK_ROOT:-$root/target/liboliphaunt-pg18-$target_id-extension-release}" \
        OLIPHAUNT_BUILD_EXTENSIONS=1 \
        OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES="$selected_sql_names" \
        pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass \
          -File src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 >/tmp/liboliphaunt-release-"$target_id"-extensions.log
      ;;
    *)
      fail "desktop extension runtime builder called for non-desktop target $target_id"
      ;;
  esac
}

build_mobile_host_extension_runtime() {
  case "$target_id" in
    ios-xcframework)
      [ "$(uname -s)" = "Darwin" ] || fail "$target_id host extension runtime must be built on macOS"
      env \
        OLIPHAUNT_WORK_ROOT="${OLIPHAUNT_EXTENSION_MACOS_RUNTIME_ROOT:-$root/target/liboliphaunt-pg18-extension-release-$target_id}" \
        OLIPHAUNT_BUILD_EXTENSIONS=1 \
        OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES="$selected_sql_names" \
        src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh >/tmp/liboliphaunt-release-mobile-host-extensions.log
      ;;
    android-*)
      [ "$(uname -s)" = "Linux" ] || fail "$target_id host extension runtime must be built on Linux"
      env \
        OLIPHAUNT_LINUX_WORK_ROOT="${OLIPHAUNT_EXTENSION_LINUX_RUNTIME_ROOT:-$root/target/liboliphaunt-pg18-linux-x64-gnu-extension-release}" \
        OLIPHAUNT_BUILD_EXTENSIONS=1 \
        OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES="$selected_sql_names" \
        src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh >/tmp/liboliphaunt-release-mobile-host-extensions.log
      ;;
    *)
      fail "mobile host extension runtime requested for non-mobile target $target_id"
      ;;
  esac
}

build_mobile_static_artifacts() {
  local mobile_extensions="$1"
  [ -n "$mobile_extensions" ] || return 0
  case "$target_id" in
    ios-xcframework)
      [ "$(uname -s)" = "Darwin" ] || fail "$target_id extension artifacts must be built on macOS"
      env \
        OLIPHAUNT_IOS_SIMULATOR_ROOT="$root/target/liboliphaunt-mobile-extension-release/$target_id/ios-simulator" \
        OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$mobile_extensions" \
        src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh >/tmp/liboliphaunt-release-ios-simulator-extensions.log
      env \
        OLIPHAUNT_IOS_DEVICE_ROOT="$root/target/liboliphaunt-mobile-extension-release/$target_id/ios-device" \
        OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$mobile_extensions" \
        src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh >/tmp/liboliphaunt-release-ios-device-extensions.log
      env \
        OLIPHAUNT_IOS_SIMULATOR_OUT="$root/target/liboliphaunt-mobile-extension-release/$target_id/ios-simulator/out" \
        OLIPHAUNT_IOS_DEVICE_OUT="$root/target/liboliphaunt-mobile-extension-release/$target_id/ios-device/out" \
        OLIPHAUNT_IOS_EXTENSION_XCFRAMEWORK_ROOT="$root/target/liboliphaunt-mobile-extension-release/$target_id/ios-extension-xcframeworks" \
        OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$mobile_extensions" \
        src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh >/tmp/liboliphaunt-release-ios-extension-xcframeworks.log
      ;;
    android-arm64-v8a)
      env \
        OLIPHAUNT_ANDROID_ARM64_ROOT="$root/target/liboliphaunt-mobile-extension-release/$target_id/android-arm64" \
        OLIPHAUNT_ANDROID_ABI=arm64-v8a \
        OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$mobile_extensions" \
        src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh >/tmp/liboliphaunt-release-android-arm64-extensions.log
      ;;
    android-x86_64)
      env \
        OLIPHAUNT_ANDROID_X86_64_ROOT="$root/target/liboliphaunt-mobile-extension-release/$target_id/android-x86_64" \
        OLIPHAUNT_ANDROID_ABI=x86_64 \
        OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$mobile_extensions" \
        src/runtimes/liboliphaunt/native/bin/build-postgres18-android-x86_64.sh >/tmp/liboliphaunt-release-android-x86_64-extensions.log
      ;;
  esac
}

desktop_runtime_artifact_name() {
  local sql_name="$1"
  printf 'liboliphaunt-%s-extension-%s-%s-runtime.tar.gz\n' "$version" "$sql_name" "$target_id"
}

mobile_runtime_artifact_name() {
  local sql_name="$1"
  printf 'liboliphaunt-%s-extension-%s-%s-runtime.tar.gz\n' "$version" "$sql_name" "$target_id"
}

make_extension_artifact() {
  local runtime="$1"
  local sql_name="$2"
  local creates_extension="$3"
  local stem="$4"
  local dependencies="$5"
  local shared_preload="$6"
  local data_files="$7"
  local output="$8"
  shift 8

  local -a artifact_args=(
    "$packager" create-artifact
    --runtime "$runtime"
    --sql-name "$sql_name"
    --creates-extension "$creates_extension"
    --target "$target_id"
    --output "$out_dir/$output"
    --stage-root "$stage_root"
    --format tar-gz
    --force
  )
  if [ "$stem" != "-" ]; then
    artifact_args+=(--native-module-stem "$stem" --native-module-file "$stem.$(module_suffix_for_target)")
  fi
  if [ "$dependencies" != "-" ]; then
    artifact_args+=(--dependency "$dependencies")
  fi
  if [ "$shared_preload" != "-" ]; then
    artifact_args+=(--shared-preload-library "$shared_preload")
  fi
  if [ "$data_files" != "-" ]; then
    IFS=',' read -r -a data_file_array <<<"$data_files"
    for data_file in "${data_file_array[@]}"; do
      [ -n "$data_file" ] || continue
      artifact_args+=(--data-file "$data_file")
    done
  fi
  if [ "$#" -gt 0 ]; then
    artifact_args+=("$@")
  fi
  bun "${artifact_args[@]}" >/tmp/liboliphaunt-release-extension-artifact-"$target_id"-"$sql_name".log
}

package_desktop_target() {
  local runtime
  build_desktop_extension_runtime
  runtime="$(host_extension_runtime_root)"
  require_dir "$runtime" "$target_id extension runtime"

  local module_suffix
  module_suffix="$(module_suffix_for_target)"
  local sql_name pg_major creates_extension stem dependencies shared_preload desktop_prebuilt mobile_prebuilt mobile_static_required mobile_static_targets data_files artifact_policy runtime_artifact
  while IFS=$'\t' read -r sql_name pg_major creates_extension stem dependencies shared_preload desktop_prebuilt mobile_prebuilt mobile_static_required mobile_static_targets data_files artifact_policy; do
    [ -n "$sql_name" ] || continue
    selected_sql_name_matches "$sql_name" || continue
    [ "$pg_major" = "18" ] || fail "extension catalog row for $sql_name targets PostgreSQL $pg_major"
    [ "$desktop_prebuilt" = "yes" ] || continue
    runtime_artifact="$(desktop_runtime_artifact_name "$sql_name")"
    make_extension_artifact \
      "$runtime" \
      "$sql_name" \
      "$creates_extension" \
      "$stem" \
      "$dependencies" \
      "$shared_preload" \
      "$data_files" \
      "$runtime_artifact"
    append_native_asset_index_row "$sql_name" runtime "$runtime_artifact"
    append_legacy_index_row "$sql_name" "$creates_extension" "$stem" "$dependencies" "$shared_preload" "$mobile_prebuilt" "-" "$runtime_artifact" "-" "-" "-" "$data_files"
  done < <(catalog_rows)
  printf '%s\n' "$module_suffix" >/dev/null
}

package_ios_target() {
  local runtime mobile_extensions ios_sim_root ios_device_root ios_xcframework_root
  build_mobile_host_extension_runtime
  mobile_extensions="$(mobile_module_extensions_csv)"
  build_mobile_static_artifacts "$mobile_extensions"
  runtime="$(host_extension_runtime_root)"
  require_dir "$runtime" "mobile host extension runtime"
  ios_sim_root="$root/target/liboliphaunt-mobile-extension-release/$target_id/ios-simulator"
  ios_device_root="$root/target/liboliphaunt-mobile-extension-release/$target_id/ios-device"
  ios_xcframework_root="$root/target/liboliphaunt-mobile-extension-release/$target_id/ios-extension-xcframeworks"

  local sql_name pg_major creates_extension stem dependencies shared_preload desktop_prebuilt mobile_prebuilt mobile_static_required mobile_static_targets data_files artifact_policy runtime_artifact ios_artifact static_prefix
  while IFS=$'\t' read -r sql_name pg_major creates_extension stem dependencies shared_preload desktop_prebuilt mobile_prebuilt mobile_static_required mobile_static_targets data_files artifact_policy; do
    [ -n "$sql_name" ] || continue
    selected_sql_name_matches "$sql_name" || continue
    [ "$pg_major" = "18" ] || fail "extension catalog row for $sql_name targets PostgreSQL $pg_major"
    [ "$mobile_prebuilt" = "yes" ] || continue

    runtime_artifact="$(mobile_runtime_artifact_name "$sql_name")"
    extra_args=()
    if [ "$stem" != "-" ]; then
      ios_sim_archive="$ios_sim_root/out/extensions/$stem/liboliphaunt_extension_$stem.a"
      ios_device_archive="$ios_device_root/out/extensions/$stem/liboliphaunt_extension_$stem.a"
      static_prefix="$(oliphaunt_static_symbol_prefix "$stem")"
      require_file "$ios_sim_archive" "iOS simulator static archive for $sql_name"
      require_file "$ios_device_archive" "iOS device static archive for $sql_name"
      extra_args+=(
        --mobile-static-archive "ios-simulator:$ios_sim_archive"
        --mobile-static-archive "ios-device:$ios_device_archive"
        --static-symbol-prefix "$static_prefix"
      )
      if [ "$sql_name" = "postgis" ]; then
        extra_args+=(
          --static-symbol-alias "difference:${static_prefix}_difference"
          --static-symbol-alias "pg_finfo_difference:pg_finfo_${static_prefix}_difference"
        )
      fi
      collect_mobile_static_dependency_archive_args ios-simulator "$ios_sim_root" "$sql_name"
      extra_args+=(${mobile_dependency_args[@]+"${mobile_dependency_args[@]}"})
      collect_mobile_static_dependency_archive_args ios-device "$ios_device_root" "$sql_name"
      extra_args+=(${mobile_dependency_args[@]+"${mobile_dependency_args[@]}"})

      stage_ios_extension="$stage_root/liboliphaunt-${version}-ios-extension-$stem"
      rm -rf "$stage_ios_extension"
      mkdir -p "$stage_ios_extension"
      rsync -a --delete \
        "$ios_xcframework_root/out/$stem/liboliphaunt_extension_$stem.xcframework" \
        "$stage_ios_extension/"
      while IFS= read -r dependency; do
        [ -n "$dependency" ] || continue
        dependency_xcframework="$ios_xcframework_root/out/dependencies/$dependency/liboliphaunt_dependency_$dependency.xcframework"
        require_dir "$dependency_xcframework" "iOS dependency XCFramework for $sql_name dependency $dependency"
        mkdir -p "$stage_ios_extension/dependencies/$dependency"
        rsync -a --delete "$dependency_xcframework" "$stage_ios_extension/dependencies/$dependency/"
      done < <(oliphaunt_mobile_static_extension_dependencies_for_target "$sql_name" ios || true)
      archive_swiftpm_xcframework \
        "$stage_ios_extension/liboliphaunt_extension_$stem.xcframework" \
        "$out_dir/liboliphaunt-${version}-apple-spm-extension-$stem.zip"
      ios_artifact="liboliphaunt-${version}-apple-spm-extension-$stem.zip"
    else
      ios_artifact="-"
    fi
    make_extension_artifact "$runtime" "$sql_name" "$creates_extension" "$stem" "$dependencies" "$shared_preload" "$data_files" "$runtime_artifact" ${extra_args[@]+"${extra_args[@]}"}
    append_native_asset_index_row "$sql_name" runtime "$runtime_artifact"
    append_native_asset_index_row "$sql_name" ios-xcframework "$ios_artifact"
    append_legacy_index_row "$sql_name" "$creates_extension" "$stem" "$dependencies" "$shared_preload" "$mobile_prebuilt" "ios-simulator,ios-device" "$runtime_artifact" "$ios_artifact" "-" "-" "$data_files"
  done < <(catalog_rows)
}

package_android_target() {
  local runtime mobile_extensions android_root android_static_target
  build_mobile_host_extension_runtime
  mobile_extensions="$(mobile_module_extensions_csv)"
  build_mobile_static_artifacts "$mobile_extensions"
  runtime="$(host_extension_runtime_root)"
  require_dir "$runtime" "mobile host extension runtime"
  case "$target_id" in
    android-arm64-v8a)
      android_root="$root/target/liboliphaunt-mobile-extension-release/$target_id/android-arm64"
      android_static_target="android-arm64-v8a"
      ;;
    android-x86_64)
      android_root="$root/target/liboliphaunt-mobile-extension-release/$target_id/android-x86_64"
      android_static_target="android-x86_64"
      ;;
    *) fail "Android target packager called for $target_id" ;;
  esac

  local sql_name pg_major creates_extension stem dependencies shared_preload desktop_prebuilt mobile_prebuilt mobile_static_required mobile_static_targets data_files artifact_policy runtime_artifact android_archive static_prefix
  while IFS=$'\t' read -r sql_name pg_major creates_extension stem dependencies shared_preload desktop_prebuilt mobile_prebuilt mobile_static_required mobile_static_targets data_files artifact_policy; do
    [ -n "$sql_name" ] || continue
    selected_sql_name_matches "$sql_name" || continue
    [ "$pg_major" = "18" ] || fail "extension catalog row for $sql_name targets PostgreSQL $pg_major"
    [ "$mobile_prebuilt" = "yes" ] || continue

    runtime_artifact="$(mobile_runtime_artifact_name "$sql_name")"
    extra_args=()
    if [ "$stem" != "-" ]; then
      android_archive="$android_root/out/extensions/$stem/liboliphaunt_extension_$stem.a"
      static_prefix="$(oliphaunt_static_symbol_prefix "$stem")"
      require_file "$android_archive" "Android static archive for $sql_name"
      extra_args+=(
        --mobile-static-archive "$android_static_target:$android_archive"
        --static-symbol-prefix "$static_prefix"
      )
      if [ "$sql_name" = "postgis" ]; then
        extra_args+=(
          --static-symbol-alias "difference:${static_prefix}_difference"
          --static-symbol-alias "pg_finfo_difference:pg_finfo_${static_prefix}_difference"
        )
      fi
      collect_mobile_static_dependency_archive_args "$android_static_target" "$android_root" "$sql_name"
      extra_args+=(${mobile_dependency_args[@]+"${mobile_dependency_args[@]}"})
    fi
    make_extension_artifact "$runtime" "$sql_name" "$creates_extension" "$stem" "$dependencies" "$shared_preload" "$data_files" "$runtime_artifact" ${extra_args[@]+"${extra_args[@]}"}
    append_native_asset_index_row "$sql_name" runtime "$runtime_artifact"
    append_legacy_index_row "$sql_name" "$creates_extension" "$stem" "$dependencies" "$shared_preload" "$mobile_prebuilt" "$android_static_target" "$runtime_artifact" "-" "-" "-" "$data_files"
  done < <(catalog_rows)
}

fetch_extension_source_assets
echo "==> Reading exact extension catalog"
bun "$packager" list-catalog >"$catalog_file"
write_indexes

case "$target_id" in
  macos-arm64|linux-x64-gnu|linux-arm64-gnu|windows-x64-msvc)
    package_desktop_target
    ;;
  ios-xcframework)
    package_ios_target
    ;;
  android-arm64-v8a|android-x86_64)
    package_android_target
    ;;
esac

[ "$(wc -l <"$native_asset_index" | awk '{ print $1 }')" -gt 1 ] ||
  fail "no native exact-extension artifacts were produced for target $target_id${extension_product:+ product $extension_product}"

echo "extensionReleaseAssetDir=$out_dir"
