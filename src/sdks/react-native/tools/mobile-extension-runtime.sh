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

oliphaunt_dev_normalize_mobile_extensions() {
  local raw="$1"
  local platform="$2"
  local platform_key
  case "$platform" in
    Android*) platform_key="android" ;;
    iOS*) platform_key="ios" ;;
    *) fail "unsupported mobile extension platform: $platform" ;;
  esac

  [ -n "$(printf '%s' "$raw" | tr -d '[:space:],')" ] || return 0
  node - "$(oliphaunt_dev_sdk_extension_json)" "$raw" "$platform" "$platform_key" <<'NODE'
const fs = require('node:fs');
const [metadataPath, requestedRaw, platformLabel, platformKey] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const bySqlName = new Map();
for (const row of metadata.extensions ?? []) {
  if (typeof row['sql-name'] === 'string') {
    bySqlName.set(row['sql-name'], row);
  }
}

function supportsPlatform(row) {
  const explicitSupport = row?.support?.mobile?.[platformKey];
  return row?.['mobile-release-ready'] === true
    && (explicitSupport === undefined || explicitSupport === 'supported');
}
const supported = [...bySqlName.values()]
  .filter(supportsPlatform)
  .map((row) => row['sql-name'])
  .sort();
const ordered = [];
const seen = new Set();
function visit(sqlName) {
  if (seen.has(sqlName)) {
    return;
  }
  const row = bySqlName.get(sqlName);
  if (!supportsPlatform(row)) {
    throw new Error(
      `unsupported mobile extension for ${platformLabel} Expo smoke: ${sqlName} `
      + `(supported: ${supported.join(',')})`,
    );
  }
  seen.add(sqlName);
  const dependencies = row['selected-extension-dependencies'] ?? [];
  if (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== 'string')) {
    throw new Error(`extension ${sqlName} has invalid selected-extension-dependencies metadata`);
  }
  for (const dependency of dependencies) {
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

oliphaunt_dev_mobile_createable_extensions_for_selection() {
  local selected_extensions="$1"
  [ -n "$(printf '%s' "$selected_extensions" | tr -d '[:space:],')" ] || return 0
  node - "$(oliphaunt_dev_sdk_extension_json)" "$selected_extensions" <<'NODE'
const fs = require('node:fs');
const [metadataPath, selectedRaw] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const bySqlName = new Map(
  (metadata.extensions ?? [])
    .filter((row) => typeof row['sql-name'] === 'string')
    .map((row) => [row['sql-name'], row]),
);
const selected = [...new Set(
  selectedRaw.split(',').map((value) => value.trim()).filter(Boolean),
)].sort();
const createable = [];
for (const sqlName of selected) {
  const row = bySqlName.get(sqlName);
  if (row === undefined) {
    throw new Error(`selected mobile extension is missing from generated metadata: ${sqlName}`);
  }
  if (row['creates-extension'] === true) {
    createable.push(sqlName);
  }
}
process.stdout.write(createable.join(','));
NODE
}

oliphaunt_dev_mobile_static_extensions_for_selection() {
  local selected_extensions="$1"
  [ -n "$(printf '%s' "$selected_extensions" | tr -d '[:space:],')" ] || return 0
  node - \
    "$(oliphaunt_dev_sdk_extension_json)" \
    "$(oliphaunt_mobile_static_specs_tsv)" \
    "$selected_extensions" <<'NODE'
const fs = require('node:fs');
const [metadataPath, staticSpecsPath, selectedRaw] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const bySqlName = new Map(
  (metadata.extensions ?? [])
    .filter((row) => typeof row['sql-name'] === 'string')
    .map((row) => [row['sql-name'], row]),
);
const specLines = fs.readFileSync(staticSpecsPath, 'utf8')
  .split(/\r?\n/u)
  .filter((line) => line.length > 0 && !line.startsWith('#'));
const header = specLines.shift()?.split('\t') ?? [];
const sqlNameIndex = header.indexOf('sql-name');
const moduleStemIndex = header.indexOf('native-module-stem');
if (sqlNameIndex === -1 || moduleStemIndex === -1) {
  throw new Error('generated mobile static extension specs are missing identity columns');
}
const staticSpecs = new Map();
for (const line of specLines) {
  const fields = line.split('\t');
  staticSpecs.set(fields[sqlNameIndex], fields[moduleStemIndex]);
}
const selectedStatic = [];
const seen = new Set();
for (const sqlName of selectedRaw.split(',').map((value) => value.trim()).filter(Boolean)) {
  if (seen.has(sqlName)) continue;
  seen.add(sqlName);
  const row = bySqlName.get(sqlName);
  if (!row) {
    throw new Error(`selected mobile extension ${sqlName} is absent from generated React Native metadata`);
  }
  const metadataStem = row['native-module-stem'];
  const staticStem = staticSpecs.get(sqlName);
  if (metadataStem === null) {
    if (staticStem !== undefined) {
      throw new Error(`SQL-only mobile extension ${sqlName} must not have a native static-module spec`);
    }
    continue;
  }
  if (typeof metadataStem !== 'string' || metadataStem.length === 0) {
    throw new Error(`selected mobile extension ${sqlName} has invalid native-module-stem metadata`);
  }
  if (staticStem === undefined) {
    throw new Error(`selected native mobile extension is missing a static-module spec: ${sqlName}`);
  }
  if (staticStem !== metadataStem) {
    throw new Error(
      `selected mobile extension ${sqlName} static-module stem mismatch: `
      + `metadata=${metadataStem}, static-spec=${staticStem}`,
    );
  }
  selectedStatic.push(sqlName);
}
process.stdout.write(selectedStatic.join(','));
NODE
}

oliphaunt_dev_mobile_module_stems_for_selection() {
  local selected_extensions="$1"
  local static_extensions extension stem
  local -a stems=()
  static_extensions="$(oliphaunt_dev_mobile_static_extensions_for_selection "$selected_extensions")"
  while IFS= read -r extension; do
    [ -n "$extension" ] || continue
    stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
    [ -n "$stem" ] && [ "$stem" != "-" ] || continue
    oliphaunt_dev_csv_contains "$stem" ${stems[@]+"${stems[@]}"} || stems+=("$stem")
  done < <(printf '%s\n' "$static_extensions" | tr ',' '\n')
  oliphaunt_dev_join_csv ${stems[@]+"${stems[@]}"}
}

oliphaunt_dev_mobile_module_extensions_for_selection() {
  local selected_extensions="$1"
  local static_extensions extension stem
  local -a extensions=()
  static_extensions="$(oliphaunt_dev_mobile_static_extensions_for_selection "$selected_extensions")"
  while IFS= read -r extension; do
    [ -n "$extension" ] || continue
    stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
    [ -n "$stem" ] && [ "$stem" != "-" ] || continue
    oliphaunt_dev_csv_contains "$extension" ${extensions[@]+"${extensions[@]}"} || extensions+=("$extension")
  done < <(printf '%s\n' "$static_extensions" | tr ',' '\n')
  oliphaunt_dev_join_csv ${extensions[@]+"${extensions[@]}"}
}

oliphaunt_dev_extension_artifact_root() {
  printf '%s\n' "${OLIPHAUNT_EXPO_EXTENSION_ARTIFACT_ROOT:-${OLIPHAUNT_EXPO_MOBILE_EXTENSION_ARTIFACT_ROOT:-$root/target/extension-artifacts}}"
}

oliphaunt_dev_prebuilt_extension_asset_paths_for_selection() {
  local selected_extensions="$1"
  local asset_kind="$2"
  local asset_target="${3:-*}"
  local artifact_root materialize_root
  artifact_root="$(oliphaunt_dev_extension_artifact_root)"
  materialize_root="${OLIPHAUNT_EXPO_EXTENSION_MATERIALIZE_ROOT:-${scratch_root:-$root/target/mobile-extension-artifacts}/extension-members}"
  if [ -z "$selected_extensions" ]; then
    return 0
  fi
  if [ ! -d "$artifact_root" ]; then
    if [ "${OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS:-0}" = "1" ]; then
      fail "selected mobile extension(s) require prebuilt exact-extension artifacts, but $artifact_root does not exist"
    fi
    return 1
  fi

  "$root/tools/dev/bun.sh" "$root/src/sdks/react-native/tools/mobile-extension-artifact-paths.mjs" \
    --root "$root" \
    --artifact-root "$artifact_root" \
    --materialize-root "$materialize_root" \
    --extensions "$selected_extensions" \
    --asset-kind "$asset_kind" \
    --asset-target "$asset_target" \
    --required "${OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS:-0}"
}

oliphaunt_dev_prebuilt_extension_runtime_artifacts_for_selection() {
  oliphaunt_dev_prebuilt_extension_asset_paths_for_selection "$1" runtime "$2"
}

oliphaunt_dev_prebuilt_ios_extension_framework_zips_for_selection() {
  local static_extensions
  static_extensions="$(oliphaunt_dev_mobile_static_extensions_for_selection "$1")"
  [ -n "$static_extensions" ] || return 0
  oliphaunt_dev_prebuilt_extension_asset_paths_for_selection \
    "$static_extensions" ios-xcframework ios-xcframework
}

oliphaunt_dev_prepare_prebuilt_mobile_runtime_resource_package() {
  local platform="$1"
  local runtime_source="$2"
  local initdb_source="$3"
  local selected_extensions="$4"
  local package_root="$5"

  [ -n "$selected_extensions" ] || return 1

  local prebuilt_runtime_artifacts native_runtime_version
  need_cmd cargo
  native_runtime_version="$(tr -d '\r\n' <"$root/src/runtimes/liboliphaunt/native/VERSION")"
  [[ "$native_runtime_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
    fail "liboliphaunt native VERSION must be stable SemVer"
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
    --liboliphaunt-native-version "$native_runtime_version"
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

  local static_extensions
  static_extensions="$(oliphaunt_dev_mobile_static_extensions_for_selection "$selected_extensions")"
  if [ -z "$static_extensions" ]; then
    rm -rf "$dest"
    return 0
  fi

  local framework_zips
  if ! framework_zips="$(oliphaunt_dev_prebuilt_ios_extension_framework_zips_for_selection "$static_extensions")"; then
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
    done < <(printf '%s\n' "$registered" | tr ',' '\n')
  } >"$dest/manifest.properties"
}

oliphaunt_dev_assert_runtime_extension_tree() {
  local runtime_dest="$1"
  local selected_extensions="$2"
  local platform="$3"
  node "$root/src/sdks/react-native/tools/validate-mobile-runtime-files.mjs" \
    --metadata "$(oliphaunt_dev_sdk_extension_json)" \
    --registry "$(oliphaunt_dev_mobile_registry_json)" \
    --selected "$selected_extensions" \
    --platform "$platform" \
    --runtime-root "$runtime_dest"
}

oliphaunt_dev_assert_runtime_file_list() {
  local selected_extensions="$1"
  local platform="$2"
  local file_list
  file_list="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-runtime-file-list.XXXXXX")"
  cat >"$file_list"
  if ! node "$root/src/sdks/react-native/tools/validate-mobile-runtime-files.mjs" \
    --metadata "$(oliphaunt_dev_sdk_extension_json)" \
    --registry "$(oliphaunt_dev_mobile_registry_json)" \
    --selected "$selected_extensions" \
    --platform "$platform" \
    --file-list "$file_list"
  then
    rm -f "$file_list"
    return 1
  fi
  rm -f "$file_list"
}
