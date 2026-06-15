#!/usr/bin/env bash

# Shared helpers for local React Native mobile smoke resource packaging.
# The public selection model is exact SQL extension names. Runtime/source
# metadata remains owned by src/extensions and the liboliphaunt native build
# scripts; this file only adapts that metadata for smoke-package assertions.

. "$root/src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh"

oliphaunt_dev_mobile_registry_json() {
  printf '%s\n' "$root/src/extensions/generated/mobile/static-registry.json"
}

oliphaunt_dev_sdk_extension_json() {
  printf '%s\n' "$root/src/extensions/generated/sdk/react-native.json"
}

oliphaunt_dev_csv_contains() {
  local needle="$1"
  shift || true
  local value
  for value in "$@"; do
    [ "$value" = "$needle" ] && return 0
  done
  return 1
}

oliphaunt_dev_join_csv() {
  local old_ifs="$IFS"
  IFS=","
  printf '%s' "$*"
  IFS="$old_ifs"
}

oliphaunt_dev_supported_mobile_static_extensions_csv() {
  oliphaunt_mobile_static_supported_extensions | paste -sd ',' -
}

oliphaunt_dev_normalize_mobile_extensions() {
  local raw="$1"
  local platform="$2"
  local extension sql
  local -a requested=()
  while IFS= read -r extension; do
    extension="$(printf '%s' "$extension" | xargs)"
    [ -n "$extension" ] || continue
    if ! oliphaunt_mobile_static_extension_spec "$extension" >/dev/null; then
      fail "unsupported mobile extension for $platform Expo smoke: $extension (supported: $(oliphaunt_dev_supported_mobile_static_extensions_csv))"
    fi
    sql="$(oliphaunt_mobile_static_extension_sql_name "$extension")"
    oliphaunt_dev_csv_contains "$sql" ${requested[@]+"${requested[@]}"} || requested+=("$sql")
  done < <(printf '%s\n' "$raw" | tr ',' '\n')

  [ "${#requested[@]}" -gt 0 ] || return 0
  node - "$(oliphaunt_dev_sdk_extension_json)" "$(oliphaunt_dev_join_csv "${requested[@]}")" <<'NODE'
const fs = require('node:fs');
const [metadataPath, requestedRaw] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const bySqlName = new Map();
for (const row of metadata.extensions ?? []) {
  if (typeof row['sql-name'] === 'string') {
    bySqlName.set(row['sql-name'], row);
  }
}
const ordered = [];
const seen = new Set();
function visit(sqlName) {
  if (seen.has(sqlName)) {
    return;
  }
  const row = bySqlName.get(sqlName);
  if (!row) {
    throw new Error(`extension ${sqlName} is not present in generated React Native extension metadata`);
  }
  seen.add(sqlName);
  for (const dependency of row['selected-extension-dependencies'] ?? []) {
    visit(dependency);
  }
  ordered.push(sqlName);
}
for (const sqlName of requestedRaw.split(',').map((value) => value.trim()).filter(Boolean)) {
  visit(sqlName);
}
process.stdout.write(ordered.join(','));
NODE
}

oliphaunt_dev_mobile_static_extensions_for_selection() {
  local selected_extensions="$1"
  local extension
  while IFS= read -r extension; do
    [ -n "$extension" ] || continue
    oliphaunt_mobile_static_extension_spec "$extension" >/dev/null ||
      fail "selected mobile extension is not static-linkable by the native smoke lane: $extension"
  done < <(printf '%s\n' "$selected_extensions" | tr ',' '\n')
  printf '%s\n' "$selected_extensions"
}

oliphaunt_dev_mobile_module_stems_for_selection() {
  local selected_extensions="$1"
  local extension stem
  local -a stems=()
  while IFS= read -r extension; do
    [ -n "$extension" ] || continue
    stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
    [ -n "$stem" ] && [ "$stem" != "-" ] || continue
    oliphaunt_dev_csv_contains "$stem" ${stems[@]+"${stems[@]}"} || stems+=("$stem")
  done < <(printf '%s\n' "$selected_extensions" | tr ',' '\n')
  oliphaunt_dev_join_csv ${stems[@]+"${stems[@]}"}
}

oliphaunt_dev_mobile_module_extensions_for_selection() {
  local selected_extensions="$1"
  local extension stem
  local -a extensions=()
  while IFS= read -r extension; do
    [ -n "$extension" ] || continue
    stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
    [ -n "$stem" ] && [ "$stem" != "-" ] || continue
    oliphaunt_dev_csv_contains "$extension" ${extensions[@]+"${extensions[@]}"} || extensions+=("$extension")
  done < <(printf '%s\n' "$selected_extensions" | tr ',' '\n')
  oliphaunt_dev_join_csv ${extensions[@]+"${extensions[@]}"}
}

oliphaunt_dev_extension_artifact_root() {
  printf '%s\n' "${OLIPHAUNT_EXPO_EXTENSION_ARTIFACT_ROOT:-${OLIPHAUNT_EXPO_MOBILE_EXTENSION_ARTIFACT_ROOT:-$root/target/extension-artifacts}}"
}

oliphaunt_dev_prebuilt_extension_asset_paths_for_selection() {
  local selected_extensions="$1"
  local asset_kind="$2"
  local asset_target="${3:-*}"
  local artifact_root
  artifact_root="$(oliphaunt_dev_extension_artifact_root)"
  if [ -z "$selected_extensions" ]; then
    return 0
  fi
  if [ ! -d "$artifact_root" ]; then
    if [ "${OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS:-0}" = "1" ]; then
      fail "selected mobile extension(s) require prebuilt exact-extension artifacts, but $artifact_root does not exist"
    fi
    return 1
  fi

  python3 - "$root" "$artifact_root" "$selected_extensions" "$asset_kind" "$asset_target" "${OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS:-0}" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
artifact_root = Path(sys.argv[2])
selected = [item.strip() for item in sys.argv[3].split(",") if item.strip()]
asset_kind = sys.argv[4]
asset_target = sys.argv[5]
required = sys.argv[6] == "1"

manifests = sorted(artifact_root.glob("*/extension-artifacts.json"))
by_sql = {}
for manifest_path in manifests:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    sql_name = manifest.get("sqlName")
    if not isinstance(sql_name, str) or not sql_name:
        raise SystemExit(f"{manifest_path} does not declare sqlName")
    if sql_name in by_sql:
        raise SystemExit(f"duplicate exact-extension artifact package for SQL extension {sql_name}")
    by_sql[sql_name] = (manifest_path, manifest)

def asset_matches(asset):
    if asset.get("family") != "native":
        return False
    if asset_target != "*" and asset.get("target") != asset_target:
        return False
    kind = asset.get("kind")
    if asset_kind == "runtime":
        return kind == "runtime"
    if asset_kind == "ios-xcframework":
        return kind == "ios-xcframework"
    raise SystemExit(f"unknown extension asset kind: {asset_kind}")

paths = []
missing = []
for sql_name in selected:
    entry = by_sql.get(sql_name)
    if entry is None:
        missing.append(f"{sql_name}: package")
        continue
    manifest_path, manifest = entry
    matches = [asset for asset in manifest.get("assets", []) if isinstance(asset, dict) and asset_matches(asset)]
    if not matches:
        missing.append(f"{sql_name}: {asset_kind} asset")
        continue
    if len(matches) != 1:
        raise SystemExit(f"{manifest_path} must contain exactly one {asset_kind} asset for {sql_name}, got {len(matches)}")
    raw_path = matches[0].get("path")
    if not isinstance(raw_path, str) or not raw_path:
        raise SystemExit(f"{manifest_path} {asset_kind} asset for {sql_name} does not declare path")
    path = root / raw_path
    if not path.is_file():
        missing.append(f"{sql_name}: {path}")
        continue
    paths.append(path)

if missing:
    message = "missing exact-extension artifact(s): " + ", ".join(missing)
    if required:
        raise SystemExit(message)
    raise SystemExit(3)

for path in paths:
    print(path)
PY
}

oliphaunt_dev_prebuilt_extension_runtime_artifacts_for_selection() {
  oliphaunt_dev_prebuilt_extension_asset_paths_for_selection "$1" runtime "$2"
}

oliphaunt_dev_prebuilt_ios_extension_framework_zips_for_selection() {
  oliphaunt_dev_prebuilt_extension_asset_paths_for_selection "$1" ios-xcframework ios-xcframework
}

oliphaunt_dev_prepare_prebuilt_mobile_runtime_resource_package() {
  local platform="$1"
  local runtime_source="$2"
  local initdb_source="$3"
  local selected_extensions="$4"
  local package_root="$5"

  [ -n "$selected_extensions" ] || return 1

  local prebuilt_runtime_artifacts
  need_cmd cargo
  local extension_target
  case "$platform" in
    iOS*) extension_target="ios-xcframework" ;;
    Android*)
      if [ -n "${OLIPHAUNT_EXPO_ANDROID_EXTENSION_TARGET:-}" ]; then
        extension_target="$OLIPHAUNT_EXPO_ANDROID_EXTENSION_TARGET"
      else
        case "${OLIPHAUNT_EXPO_ANDROID_ABI:-arm64-v8a}" in
          arm64-v8a) extension_target="android-arm64-v8a" ;;
          x86_64) extension_target="android-x86_64" ;;
          *) fail "unsupported Android extension ABI: ${OLIPHAUNT_EXPO_ANDROID_ABI:-}" ;;
        esac
      fi
      ;;
    *) extension_target="host" ;;
  esac
  if ! prebuilt_runtime_artifacts="$(oliphaunt_dev_prebuilt_extension_runtime_artifacts_for_selection "$selected_extensions" "$extension_target")"; then
    return 1
  fi
  [ -n "$prebuilt_runtime_artifacts" ] || return 1
  local module_stems
  module_stems="$(oliphaunt_dev_mobile_module_stems_for_selection "$selected_extensions")"
  local -a package_args=(
    run -p oliphaunt --bin oliphaunt-resources --locked --
    --mode server
    --output "$package_root"
    --extension-target "$extension_target"
    --force
    --require-mobile-static-registry
  )
  if [ -n "$module_stems" ]; then
    package_args+=(--mobile-static-module "$module_stems")
  fi
  local artifact
  while IFS= read -r artifact; do
    [ -n "$artifact" ] || continue
    package_args+=(--prebuilt-extension "$artifact")
  done < <(printf '%s\n' "$prebuilt_runtime_artifacts")

  local -a resource_env=(OLIPHAUNT_INSTALL_DIR="$runtime_source")
  if [ -n "$initdb_source" ]; then
    resource_env+=(OLIPHAUNT_INITDB="$initdb_source")
  fi

  echo "Preparing $platform runtime resources from exact-extension package artifacts: $selected_extensions" >&2
  if ! env "${resource_env[@]}" cargo "${package_args[@]}" >&2; then
    if [ "${OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS:-0}" = "1" ]; then
      fail "failed to prepare $platform runtime resources from exact-extension package artifacts: $selected_extensions"
    fi
    return 1
  fi
  if [ ! -f "$package_root/oliphaunt/runtime/manifest.properties" ]; then
    if [ "${OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS:-0}" = "1" ]; then
      fail "prebuilt $platform runtime resource package did not produce oliphaunt/runtime/manifest.properties"
    fi
    return 1
  fi
  touch "$package_root/.prepared"
  printf '%s\n' "$package_root"
}

oliphaunt_dev_unpack_ios_extension_frameworks_for_selection() {
  local selected_extensions="$1"
  local dest="$2"
  [ -n "$selected_extensions" ] || return 0

  local framework_zips
  if ! framework_zips="$(oliphaunt_dev_prebuilt_ios_extension_framework_zips_for_selection "$selected_extensions")"; then
    return 1
  fi

  rm -rf "$dest"
  mkdir -p "$dest"
  local archive
  while IFS= read -r archive; do
    [ -n "$archive" ] || continue
    if command -v ditto >/dev/null 2>&1; then
      ditto -x -k "$archive" "$dest"
    else
      unzip -q "$archive" -d "$dest"
    fi
  done < <(printf '%s\n' "$framework_zips")

  find "$dest" -type d -name '*.xcframework' -print -quit | grep -q . ||
    fail "selected iOS extension artifacts did not unpack any XCFrameworks into $dest"

  local expected_file actual_file missing extra
  expected_file="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-ios-extension-frameworks-expected.XXXXXX")"
  actual_file="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-ios-extension-frameworks-actual.XXXXXX")"
  oliphaunt_dev_mobile_module_stems_for_selection "$selected_extensions" |
    tr ',' '\n' |
    sed '/^$/d' |
    sed 's#^#liboliphaunt_extension_#;s#$#.xcframework#' |
    LC_ALL=C sort -u >"$expected_file"
  find "$dest" -type d -name 'liboliphaunt_extension_*.xcframework' -print |
    while IFS= read -r framework; do
      basename "$framework"
    done |
    LC_ALL=C sort -u >"$actual_file"
  missing="$(comm -23 "$expected_file" "$actual_file" | paste -sd ',' -)"
  extra="$(comm -13 "$expected_file" "$actual_file" | paste -sd ',' -)"
  rm -f "$expected_file" "$actual_file"
  [ -z "$missing" ] ||
    fail "selected iOS extension artifacts are missing XCFrameworks: $missing"
  [ -z "$extra" ] ||
    fail "selected iOS extension artifacts unpacked unselected XCFrameworks: $extra"
}

oliphaunt_dev_extension_file_belongs() {
  local extension="$1"
  local file_name="$2"
  case "$file_name" in
    "$extension.control"|"$extension"--*.sql) return 0 ;;
    *) return 1 ;;
  esac
}

oliphaunt_dev_extension_name_for_file() {
  local file_name="$1"
  case "$file_name" in
    *.control) printf '%s\n' "${file_name%.control}" ;;
    *--*.sql) printf '%s\n' "${file_name%%--*}" ;;
    *) return 1 ;;
  esac
}

oliphaunt_dev_extension_default_version() {
  local control_file="$1"
  [ -f "$control_file" ] || return 1
  sed -n "s/^[[:space:]]*default_version[[:space:]]*=[[:space:]]*'\\([^']*\\)'.*/\\1/p" "$control_file" |
    head -1
}

oliphaunt_dev_installed_runtime_extension_complete() {
  local extension_dir="$1"
  local extension="$2"
  local control_file="$extension_dir/$extension.control"
  local default_version

  [ -f "$control_file" ] || return 1
  compgen -G "$extension_dir/$extension--*.sql" >/dev/null || return 1
  default_version="$(oliphaunt_dev_extension_default_version "$control_file")"
  [ -z "$default_version" ] || [ -f "$extension_dir/$extension--$default_version.sql" ]
}

oliphaunt_dev_runtime_extension_files() {
  local runtime_source="$1"
  local extension="$2"
  local extension_dir="$runtime_source/share/postgresql/extension"
  if [ -d "$extension_dir" ] &&
    oliphaunt_dev_installed_runtime_extension_complete "$extension_dir" "$extension"; then
    find "$extension_dir" -maxdepth 1 -type f \( -name "$extension.control" -o -name "$extension--*.sql" \) -print | LC_ALL=C sort
    return 0
  fi

  local source_dir
  source_dir="$(
    oliphaunt_mobile_static_extension_source_dir \
      "$root" \
      "$root/target/liboliphaunt-pg18/build" \
      "$extension"
  )"
  [ -d "$source_dir" ] ||
    fail "selected mobile extension source directory is missing for $extension: $source_dir"

  local control
  control="$(
    find "$source_dir" -type f \( -name "$extension.control" -o -name "$extension.control.in" \) -print |
      LC_ALL=C sort |
      head -1
  )"
  [ -n "$control" ] ||
    fail "selected mobile extension $extension is missing a control file under $source_dir"
  printf '%s\n' "$control"

  local sql_files default_version generated_sql_template default_install_sql
  sql_files="$(
    find "$source_dir" -type f -name "$extension--*.sql" -print | LC_ALL=C sort
  )"
  default_version="$(oliphaunt_dev_extension_default_version "$control" || true)"
  default_install_sql=""
  if [ -n "$default_version" ]; then
    default_install_sql="$source_dir/sql/$extension--$default_version.sql"
    generated_sql_template="$source_dir/sql/$extension.sql"
    if ! printf '%s\n' "$sql_files" | grep -Fxq "$default_install_sql" &&
      [ -f "$generated_sql_template" ]; then
      sql_files="$(
        {
          printf '%s\n' "$sql_files"
          printf '%s\n' "$generated_sql_template"
        } | sed '/^$/d' | LC_ALL=C sort
      )"
    fi
  fi
  [ -n "$sql_files" ] ||
    fail "selected mobile extension $extension is missing SQL files under $source_dir"
  printf '%s\n' "$sql_files"
}

oliphaunt_dev_mobile_registry_data_files() {
  local mode="$1"
  local selected_extensions="${2:-}"
  node - "$(oliphaunt_dev_mobile_registry_json)" "$mode" "$selected_extensions" <<'NODE'
const fs = require('node:fs');
const [registryPath, mode, selectedRaw] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const selected = new Set(
  selectedRaw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const files = new Set();
for (const module of registry.modules ?? []) {
  const sqlName = module['sql-name'];
  if (mode === 'selected' && !selected.has(sqlName)) {
    continue;
  }
  for (const file of module['data-files'] ?? []) {
    if (typeof file === 'string' && file.length > 0) {
      files.add(file);
    }
  }
}
for (const file of [...files].sort()) {
  console.log(file);
}
NODE
}

oliphaunt_dev_hash_mobile_runtime_extension_assets() {
  local runtime_source="$1"
  local extensions="$2"
  local extension file data_file
  while IFS= read -r extension; do
    [ -n "$extension" ] || continue
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      shasum -a 256 "$file"
    done < <(oliphaunt_dev_runtime_extension_files "$runtime_source" "$extension")
  done < <(printf '%s\n' "$extensions" | tr ',' '\n')
  while IFS= read -r data_file; do
    [ -n "$data_file" ] || continue
    [ -f "$runtime_source/$data_file" ] ||
      fail "selected mobile extension data file is missing from runtime source: $runtime_source/$data_file"
    shasum -a 256 "$runtime_source/$data_file"
  done < <(oliphaunt_dev_mobile_registry_data_files selected "$extensions")
}

oliphaunt_dev_copy_mobile_runtime_extension_assets() {
  local runtime_source="$1"
  local runtime_dest="$2"
  local extensions="$3"
  local extension file file_name dest_file data_file default_version
  local extension_dest="$runtime_dest/share/postgresql/extension"
  mkdir -p "$extension_dest"

  while IFS= read -r extension; do
    [ -n "$extension" ] || continue
    default_version=""
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      file_name="$(basename "$file")"
      case "$file_name" in
        "$extension.control"|"$extension.control.in")
          default_version="$(oliphaunt_dev_extension_default_version "$file" || true)"
          [ "$file_name" = "$extension.control.in" ] && file_name="$extension.control"
          ;;
        "$extension.sql")
          if [ -n "$default_version" ]; then
            file_name="$extension--$default_version.sql"
          fi
          ;;
      esac
      rsync -a "$file" "$extension_dest/$file_name"
    done < <(oliphaunt_dev_runtime_extension_files "$runtime_source" "$extension")
  done < <(printf '%s\n' "$extensions" | tr ',' '\n')

  while IFS= read -r data_file; do
    [ -n "$data_file" ] || continue
    [ -f "$runtime_source/$data_file" ] ||
      fail "selected mobile extension data file is missing from runtime source: $runtime_source/$data_file"
    dest_file="$runtime_dest/$data_file"
    mkdir -p "$(dirname "$dest_file")"
    rsync -a "$runtime_source/$data_file" "$dest_file"
  done < <(oliphaunt_dev_mobile_registry_data_files selected "$extensions")
}

oliphaunt_dev_extension_runtime_stats() {
  local runtime_dest="$1"
  local extension="$2"
  local files=0 bytes=0 file size data_file
  local extension_dir="$runtime_dest/share/postgresql/extension"
  while IFS= read -r -d '' file; do
    size="$(wc -c <"$file" | tr -d '[:space:]')"
    files=$((files + 1))
    bytes=$((bytes + size))
  done < <(find "$extension_dir" -maxdepth 1 -type f \( -name "$extension.control" -o -name "$extension--*.sql" \) -print0)
  while IFS= read -r data_file; do
    [ -n "$data_file" ] || continue
    file="$runtime_dest/$data_file"
    [ -f "$file" ] || continue
    size="$(wc -c <"$file" | tr -d '[:space:]')"
    files=$((files + 1))
    bytes=$((bytes + size))
  done < <(oliphaunt_dev_mobile_registry_data_files selected "$extension")
  printf '%s %s\n' "$files" "$bytes"
}

oliphaunt_dev_write_static_registry_manifest() {
  local dest="$1"
  local selected_extensions="$2"
  local source_file="$3"
  local registered="" stems="" state="not-required" source=""
  stems="$(oliphaunt_dev_mobile_module_stems_for_selection "$selected_extensions")"
  if [ -n "$stems" ]; then
    state="complete"
    source="oliphaunt_static_registry.c"
    registered="$(oliphaunt_dev_mobile_module_extensions_for_selection "$selected_extensions")"
    rsync -a "$source_file" "$dest/$source"
  fi

  {
    printf 'packageLayout=oliphaunt-static-registry-v1\n'
    printf 'abiVersion=1\n'
    printf 'state=%s\n' "$state"
    printf 'source=%s\n' "$source"
    printf 'registeredExtensions=%s\n' "$registered"
    printf 'pendingExtensions=\n'
    printf 'nativeModuleStems=%s\n' "$stems"
    printf 'modules=%s\n' "$stems"
    local extension stem
    while IFS= read -r extension; do
    [ -n "$extension" ] || continue
    stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
    [ -n "$stem" ] && [ "$stem" != "-" ] || continue
    printf 'module.%s.extension=%s\n' "$stem" "$extension"
    printf 'module.%s.symbolPrefix=%s\n' "$stem" "$(oliphaunt_static_symbol_prefix "$stem")"
    printf 'module.%s.sqlSymbols=\n' "$stem"
    done < <(printf '%s\n' "$selected_extensions" | tr ',' '\n')
  } >"$dest/manifest.properties"
}

oliphaunt_dev_assert_runtime_extension_tree() {
  local runtime_dest="$1"
  local selected_extensions="$2"
  local platform="$3"
  local extension file_name extension_name matched_sql control_file default_version
  local extension_dir="$runtime_dest/share/postgresql/extension"

  while IFS= read -r extension; do
    [ -n "$extension" ] || continue
    control_file="$extension_dir/$extension.control"
    [ -f "$control_file" ] ||
      fail "$platform runtime is missing selected $extension extension control file"
    matched_sql=0
    if compgen -G "$extension_dir/$extension--*.sql" >/dev/null; then
      matched_sql=1
    fi
    [ "$matched_sql" = "1" ] ||
      fail "$platform runtime is missing selected $extension extension SQL files"
    default_version="$(oliphaunt_dev_extension_default_version "$control_file")"
    if [ -n "$default_version" ] && [ ! -f "$extension_dir/$extension--$default_version.sql" ]; then
      fail "$platform runtime is missing selected $extension extension install script for default_version=$default_version"
    fi
  done < <(printf '%s\n' "$selected_extensions" | tr ',' '\n')

  if [ ! -d "$extension_dir" ]; then
    [ -z "$selected_extensions" ] || fail "$platform runtime extension directory is missing"
    return 0
  fi
  while IFS= read -r -d '' file; do
    file_name="$(basename "$file")"
    extension_name="$(oliphaunt_dev_extension_name_for_file "$file_name" || true)"
    [ -n "$extension_name" ] || continue
    if ! printf '%s\n' "$selected_extensions" | tr ',' '\n' | grep -Fxq "$extension_name"; then
      fail "$platform runtime included unselected PostgreSQL extension asset: $file_name"
    fi
  done < <(find "$extension_dir" -maxdepth 1 -type f -print0)
}

oliphaunt_dev_assert_runtime_data_files() {
  local runtime_dest="$1"
  local selected_extensions="$2"
  local platform="$3"
  local selected_file unselected_file
  local -a selected_files=()

  while IFS= read -r selected_file; do
    [ -n "$selected_file" ] || continue
    selected_files+=("$selected_file")
    [ -e "$runtime_dest/$selected_file" ] ||
      fail "$platform runtime is missing selected extension data file: $selected_file"
  done < <(oliphaunt_dev_mobile_registry_data_files selected "$selected_extensions")

  while IFS= read -r unselected_file; do
    [ -n "$unselected_file" ] || continue
    local selected=0
    for selected_file in ${selected_files[@]+"${selected_files[@]}"}; do
      if [ "$selected_file" = "$unselected_file" ]; then
        selected=1
        break
      fi
    done
    [ "$selected" = "0" ] || continue
    if [ -e "$runtime_dest/$unselected_file" ]; then
      fail "$platform runtime included unselected extension data file: $unselected_file"
    fi
  done < <(oliphaunt_dev_mobile_registry_data_files all)
}

oliphaunt_dev_assert_runtime_file_list() {
  local selected_extensions="$1"
  local platform="$2"
  local file_list
  file_list="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-runtime-file-list.XXXXXX")"
  cat >"$file_list"
  if ! node - "$(oliphaunt_dev_mobile_registry_json)" "$selected_extensions" "$platform" "$file_list" <<'NODE'
const fs = require('node:fs');
const [registryPath, selectedRaw, platform, fileListPath] = process.argv.slice(2);
const selected = new Set(selectedRaw.split(',').map((value) => value.trim()).filter(Boolean));
const lines = fs.readFileSync(fileListPath, 'utf8').split(/\r?\n/).filter(Boolean);
const extensionFiles = lines.filter((line) => line.includes('/runtime/files/share/postgresql/extension/'));
const byExtension = new Map();
for (const line of extensionFiles) {
  const fileName = line.split('/').pop();
  let sqlName = '';
  let kind = '';
  if (fileName.endsWith('.control')) {
    sqlName = fileName.slice(0, -'.control'.length);
    kind = 'control';
  } else if (/--.*\.sql$/.test(fileName)) {
    sqlName = fileName.split('--')[0];
    kind = 'sql';
  } else {
    continue;
  }
  if (!selected.has(sqlName)) {
    throw new Error(`${platform} app includes unselected PostgreSQL extension asset: ${line}`);
  }
  const state = byExtension.get(sqlName) ?? {control: false, sql: false};
  state[kind] = true;
  byExtension.set(sqlName, state);
}
for (const sqlName of selected) {
  const state = byExtension.get(sqlName);
  if (!state?.control) {
    throw new Error(`${platform} app is missing selected ${sqlName} extension control file`);
  }
  if (!state?.sql) {
    throw new Error(`${platform} app is missing selected ${sqlName} extension SQL file`);
  }
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
for (const module of registry.modules ?? []) {
  const sqlName = module['sql-name'];
  for (const dataFile of module['data-files'] ?? []) {
    const present = lines.some((line) => line.endsWith(`/runtime/files/${dataFile}`));
    if (selected.has(sqlName) && !present) {
      throw new Error(`${platform} app is missing selected ${sqlName} extension data file: ${dataFile}`);
    }
    if (!selected.has(sqlName) && present) {
      throw new Error(`${platform} app includes unselected ${sqlName} extension data file: ${dataFile}`);
    }
  }
}
NODE
  then
    rm -f "$file_list"
    return 1
  fi
  rm -f "$file_list"
}
