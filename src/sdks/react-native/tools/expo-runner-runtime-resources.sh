#!/usr/bin/env bash

# Shared runtime-resource packaging for React Native Expo mobile runners.
# Platform runners choose platform artifacts and runtime/template sources; this
# helper owns the common mobile resource layout, exact-extension filtering, and
# package metadata.

expo_runner_runtime_resources_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

copy_mobile_runtime_files() {
  local runtime_source="$1"
  local runtime_dest="$2"
  local optional_data_file optional_data_rel
  local -a optional_data_excludes=()

  while IFS= read -r optional_data_file; do
    [ -n "$optional_data_file" ] || continue
    optional_data_rel="${optional_data_file#share/postgresql/}"
    [ "$optional_data_rel" != "$optional_data_file" ] || continue
    optional_data_excludes+=(--exclude "/$optional_data_rel")
  done < <(oliphaunt_dev_mobile_registry_data_files all)

  mkdir -p "$runtime_dest/bin" "$runtime_dest/share/postgresql/extension"
  rsync -a --delete \
    --prune-empty-dirs \
    --exclude '/extension/***' \
    ${optional_data_excludes[@]+"${optional_data_excludes[@]}"} \
    "$runtime_source/share/postgresql/" "$runtime_dest/share/postgresql/"

  # The embedded backend uses argv[0] only as an absolute install-root anchor
  # for deriving share/lib paths. Mobile app resources must not include host
  # postgres binaries or host dynamic libraries.
  printf 'liboliphaunt embedded runtime anchor\n' > "$runtime_dest/bin/postgres"
  chmod 0644 "$runtime_dest/bin/postgres"
}

prepare_mobile_runtime_resource_package() {
  local platform="$1"
  local runtime_source="$2"
  local template_source="$3"
  local static_registry_source="$4"
  local selected_extensions="$5"
  local repackage_assets="$6"
  local package_root="$7"

  need_cmd rsync
  need_cmd shasum

  local selected_module_stems
  selected_module_stems="$(oliphaunt_dev_mobile_module_stems_for_selection "$selected_extensions")"
  if [ -n "$selected_module_stems" ] && [ ! -f "$static_registry_source" ]; then
    fail "$platform mobile extension '$selected_extensions' requires a linked liboliphaunt static registry source"
  fi

  local source_stamp="$package_root/.sources"
  local prepared_stamp="$package_root/.prepared"
  local current_sources
  current_sources="$(
    printf '%s\n%s\nnormalizer=mobile-template-v1\nruntime-layout=mobile-minimal-v1\nwal-segsize-mb=%s\nextensions=%s\n' "$runtime_source" "$template_source" "$wal_segsize_mb" "$selected_extensions"
    [ -n "$static_registry_source" ] && shasum -a 256 "$static_registry_source"
    shasum -a 256 "$root/src/extensions/generated/mobile/static-registry.json"
    oliphaunt_dev_hash_mobile_runtime_extension_assets "$runtime_source" "$selected_extensions"
    shasum -a 256 \
      "$script_path" \
      "$expo_runner_runtime_resources_script" \
      "$root/src/sdks/react-native/tools/mobile-extension-runtime.sh"
  )"
  if [ "$repackage_assets" != "1" ] &&
    [ -f "$prepared_stamp" ] &&
    [ -f "$source_stamp" ] &&
    [ "$current_sources" = "$(cat "$source_stamp")" ] &&
    [ -z "$(find "$runtime_source" "$template_source" -type f -newer "$prepared_stamp" -print)" ]; then
    echo "Reusing $platform runtime resources: $package_root" >&2
    printf '%s\n' "$package_root"
    return
  fi

  local runtime_dest="$package_root/oliphaunt/runtime/files"
  local template_dest="$package_root/oliphaunt/template-pgdata/files"
  local static_registry_dest="$package_root/oliphaunt/static-registry"
  rm -rf "$package_root"
  mkdir -p "$runtime_dest" "$template_dest" "$static_registry_dest"

  copy_mobile_runtime_files "$runtime_source" "$runtime_dest"
  oliphaunt_dev_copy_mobile_runtime_extension_assets "$runtime_source" "$runtime_dest" "$selected_extensions"
  oliphaunt_dev_assert_runtime_extension_tree "$runtime_dest" "$selected_extensions" "$platform"
  oliphaunt_dev_assert_runtime_data_files "$runtime_dest" "$selected_extensions" "$platform"
  rsync -a --delete \
    --exclude postmaster.pid \
    --exclude postmaster.opts \
    --exclude 'pg_stat_tmp/*' \
    "$template_source/" "$template_dest/"
  rm -f "$template_dest/postmaster.pid" "$template_dest/postmaster.opts"
  normalize_template_pgdata "$template_dest"

  local static_registry_files=0 static_registry_bytes=0
  local manifest_extensions="" mobile_static_state="not-required"
  local mobile_static_registered="" native_module_stems="" mobile_static_source=""
  local selected_extension_files=0 selected_extension_bytes=0
  local extension extension_files extension_bytes extension_size_rows
  extension_size_rows="$package_root/.extension-size-rows"
  : >"$extension_size_rows"
  if [ -n "$selected_extensions" ]; then
    manifest_extensions="$selected_extensions"
    native_module_stems="$selected_module_stems"
    if [ -n "$native_module_stems" ]; then
      mobile_static_state="complete"
      mobile_static_registered="$(oliphaunt_dev_mobile_module_extensions_for_selection "$selected_extensions")"
      mobile_static_source="static-registry/oliphaunt_static_registry.c"
      oliphaunt_dev_write_static_registry_manifest "$static_registry_dest" "$selected_extensions" "$static_registry_source"
    else
      oliphaunt_dev_write_static_registry_manifest "$static_registry_dest" "" ""
    fi
    while IFS= read -r extension; do
      [ -n "$extension" ] || continue
      read -r extension_files extension_bytes < <(oliphaunt_dev_extension_runtime_stats "$runtime_dest" "$extension")
      selected_extension_files=$((selected_extension_files + extension_files))
      selected_extension_bytes=$((selected_extension_bytes + extension_bytes))
      printf 'extension\t%s\t-\t%s\t%s\n' "$extension" "$extension_files" "$extension_bytes" >>"$extension_size_rows"
    done < <(printf '%s\n' "$selected_extensions" | tr ',' '\n')
  else
    oliphaunt_dev_write_static_registry_manifest "$static_registry_dest" "" ""
  fi

  local runtime_bytes template_bytes total_bytes runtime_files template_files total_files
  runtime_bytes="$(directory_bytes "$runtime_dest")"
  template_bytes="$(directory_bytes "$template_dest")"
  static_registry_bytes="$(directory_bytes "$static_registry_dest")"
  total_bytes=$((runtime_bytes + template_bytes + static_registry_bytes))
  runtime_files="$(directory_files "$runtime_dest")"
  template_files="$(directory_files "$template_dest")"
  static_registry_files="$(directory_files "$static_registry_dest")"
  total_files=$((runtime_files + template_files + static_registry_files))

  local runtime_key template_key
  runtime_key="$(directory_fingerprint "$runtime_dest")"
  template_key="$(directory_fingerprint "$template_dest")"

  mkdir -p "$package_root/oliphaunt/runtime" "$package_root/oliphaunt/template-pgdata"
  cat >"$package_root/oliphaunt/runtime/manifest.properties" <<MANIFEST
schema=oliphaunt-runtime-resources-v1
cacheKey=$runtime_key
layout=postgres-runtime-files-v1
source=runtime
extensions=$manifest_extensions
sharedPreloadLibraries=
mobileStaticRegistryState=$mobile_static_state
mobileStaticRegistryRegistered=$mobile_static_registered
mobileStaticRegistryPending=
nativeModuleStems=$native_module_stems
mobileStaticRegistrySource=$mobile_static_source
MANIFEST
  cat >"$package_root/oliphaunt/template-pgdata/manifest.properties" <<MANIFEST
schema=oliphaunt-runtime-resources-v1
cacheKey=$template_key
layout=postgres-template-pgdata-v1
source=template-pgdata
walSegmentSizeMB=$wal_segsize_mb
extensions=
sharedPreloadLibraries=
mobileStaticRegistryState=not-required
mobileStaticRegistryRegistered=
mobileStaticRegistryPending=
nativeModuleStems=
mobileStaticRegistrySource=
MANIFEST
  cat >"$package_root/oliphaunt/package-size.tsv" <<REPORT
kind	id	extensions	files	bytes
package	total	-	$total_files	$total_bytes
package	runtime	-	$runtime_files	$runtime_bytes
package	template-pgdata	-	$template_files	$template_bytes
package	static-registry	-	$static_registry_files	$static_registry_bytes
extensions	selected	-	$selected_extension_files	$selected_extension_bytes
REPORT
  cat "$extension_size_rows" >>"$package_root/oliphaunt/package-size.tsv"

  printf '%s' "$current_sources" >"$source_stamp"
  touch "$prepared_stamp"

  printf '%s\n' "$package_root"
}
