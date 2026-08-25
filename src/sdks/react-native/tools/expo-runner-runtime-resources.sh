#!/usr/bin/env bash

# Shared runtime-resource packaging for React Native Expo mobile runners.
# Platform runners choose platform artifacts and runtime/cluster-seed sources; this
# helper owns the common mobile resource layout, exact-extension filtering, and
# package metadata.

expo_runner_runtime_resources_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

mobile_cluster_seed_target() {
  case "$1" in
    iOS) printf '%s\n' ios-datum64 ;;
    Android) printf '%s\n' android-datum64 ;;
    *) fail "unsupported mobile cluster-seed platform: $1" ;;
  esac
}

require_exact_cluster_seed_manifest_keys() {
  local manifest="$1" actual expected
  actual="$(sed '/^$/d;/^#/d' "$manifest" | sed -n '/^[^=][^=]*=/s/=.*//p' | LC_ALL=C sort)"
  expected="$(printf '%s\n' artifactRole cacheKey catalogProfile compatibilityKey icuDataForm icuDataTreeSha256 icuDataVersion initialSuperuser layout physicalFormat postgresMajor runtimeFeatures schema target | LC_ALL=C sort)"
  [ "$actual" = "$expected" ] &&
    [ "$(sed '/^$/d;/^#/d' "$manifest" | wc -l | tr -d ' ')" = 14 ] ||
    fail "$manifest does not contain the exact canonical cluster-seed fields"
}

require_mobile_runtime_seed_closure() {
  local platform="$1" configured="$2" configured_env="$3" target root receipt expected
  target="$(mobile_cluster_seed_target "$platform")"
  [ -n "$configured" ] ||
    fail "$configured_env must name a target-qualified $target runtime-resource closure; arbitrary host PGDATA is not a supported seed for $platform"
  root="$configured"
  [ -d "$root/oliphaunt" ] && root="$root/oliphaunt"
  receipt="$root/manifest.properties"
  [ -f "$receipt" ] || fail "$configured_env is missing the runtime-carrier receipt: $receipt"
  expected="$(printf 'schema=oliphaunt-native-runtime-carrier-v1\nclusterSeedTarget=%s\nclusterSeedRelativePath=cluster-seed\nicuClusterSeedRelativePath=cluster-seed-icu\n' "$target")"
  [ "$(cat "$receipt")" = "$expected" ] ||
    fail "$configured_env does not contain the exact $target runtime-carrier receipt"
  local name profile role manifest
  for name in cluster-seed cluster-seed-icu; do
    [ "$name" = cluster-seed ] && profile=standard || profile=icu
    role="cluster-seed-$profile"
    manifest="$root/$name/manifest.properties"
    [ -f "$root/$name/files/PG_VERSION" ] && [ -f "$root/$name/files/global/pg_control" ] ||
      fail "$configured_env is missing the complete $name payload"
    require_exact_cluster_seed_manifest_keys "$manifest"
    grep -Fxq "schema=oliphaunt-runtime-resources-v1" "$manifest" &&
      grep -Fxq "layout=oliphaunt-cluster-seed-v1" "$manifest" &&
      grep -Fxq "artifactRole=$role" "$manifest" &&
      grep -Fxq "catalogProfile=$profile" "$manifest" &&
      grep -Fxq "postgresMajor=18" "$manifest" &&
      grep -Fxq "physicalFormat=native-pg18-v1" "$manifest" &&
      grep -Fxq "target=$target" "$manifest" &&
      grep -Fxq "compatibilityKey=native-pg18-$target-v1" "$manifest" &&
    grep -Fxq "initialSuperuser=postgres" "$manifest" ||
      fail "$configured_env contains an incompatible $name manifest"
    grep -Eq '^cacheKey=[A-Za-z0-9._-]{1,128}$' "$manifest" ||
      fail "$configured_env contains an invalid $name cache key"
    ! grep -Eq '^cacheKey=\.{1,2}$' "$manifest" ||
      fail "$configured_env contains an invalid $name cache key"
    if [ "$profile" = icu ]; then
      grep -Fxq runtimeFeatures=icu "$manifest" &&
        grep -Fxq icuDataVersion=76.1 "$manifest" &&
        grep -Fxq icuDataForm=files-le "$manifest" &&
        grep -Eq '^icuDataTreeSha256=[0-9a-f]{64}$' "$manifest" ||
        fail "$configured_env contains an incompatible ICU cluster seed"
    else
      grep -Fxq runtimeFeatures= "$manifest" &&
        grep -Fxq icuDataVersion= "$manifest" &&
        grep -Fxq icuDataForm= "$manifest" &&
        grep -Fxq icuDataTreeSha256= "$manifest" ||
        fail "$configured_env contains an incompatible standard cluster seed"
    fi
  done
  printf '%s\n' "$root"
}

install_mobile_runtime_seed_closure() {
  local package_root="$1" closure="$2"
  rm -rf "$package_root/oliphaunt/cluster-seed" "$package_root/oliphaunt/cluster-seed-icu"
  cp "$closure/manifest.properties" "$package_root/oliphaunt/manifest.properties"
  cp -R "$closure/cluster-seed" "$package_root/oliphaunt/cluster-seed"
  cp -R "$closure/cluster-seed-icu" "$package_root/oliphaunt/cluster-seed-icu"
}

bind_mobile_runtime_manifest_to_seed_closure() {
  local package_root="$1" closure="$2" manifest target features digest seed_digest temporary
  manifest="$package_root/oliphaunt/runtime/manifest.properties"
  target="$(sed -n 's/^clusterSeedTarget=//p' "$closure/manifest.properties")"
  features="$(sed -n 's/^runtimeFeatures=//p' "$manifest")"
  digest="$(sed -n 's/^icuDataTreeSha256=//p' "$manifest")"
  seed_digest="$(sed -n 's/^icuDataTreeSha256=//p' "$closure/cluster-seed-icu/manifest.properties")"
  if [ "$features" = icu ]; then
    [ -n "$digest" ] && [ "$digest" = "$seed_digest" ] ||
      fail "staged mobile ICU runtime does not match the canonical $target ICU cluster seed"
  else
    digest=""
  fi
  temporary="$manifest.tmp.$$"
  sed '/^clusterSeedTarget=/d;/^icuDataTreeSha256=/d' "$manifest" >"$temporary"
  printf 'clusterSeedTarget=%s\nicuDataTreeSha256=%s\n' "$target" "$digest" >>"$temporary"
  mv "$temporary" "$manifest"
}

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
  local seed_closure="$3"
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
    printf '%s\n%s\nruntime-layout=mobile-minimal-v1\nextensions=%s\n' "$runtime_source" "$seed_closure" "$selected_extensions"
    [ -n "$static_registry_source" ] && shasum -a 256 "$static_registry_source"
    shasum -a 256 "$root/src/extensions/generated/mobile/static-registry.json"
    oliphaunt_dev_hash_mobile_runtime_extension_assets "$runtime_source" "$selected_extensions"
    shasum -a 256 \
      "$script_path" \
      "$expo_runner_runtime_resources_script" \
      "$root/src/sdks/react-native/tools/mobile-extension-runtime.sh" \
      "$root/src/sdks/react-native/tools/validate-mobile-runtime-files.mjs"
  )"
  if [ "$repackage_assets" != "1" ] &&
    [ -f "$prepared_stamp" ] &&
    [ -f "$source_stamp" ] &&
    [ "$current_sources" = "$(cat "$source_stamp")" ] &&
    [ -z "$(find "$runtime_source" "$seed_closure" -type f -newer "$prepared_stamp" -print)" ]; then
    echo "Reusing $platform runtime resources: $package_root" >&2
    printf '%s\n' "$package_root"
    return
  fi

  local runtime_dest="$package_root/oliphaunt/runtime/files"
  local static_registry_dest="$package_root/oliphaunt/static-registry"
  rm -rf "$package_root"
  mkdir -p "$runtime_dest" "$static_registry_dest" "$package_root/oliphaunt"
  install_mobile_runtime_seed_closure "$package_root" "$seed_closure"

  copy_mobile_runtime_files "$runtime_source" "$runtime_dest"
  oliphaunt_dev_copy_mobile_runtime_extension_assets "$runtime_source" "$runtime_dest" "$selected_extensions"
  oliphaunt_dev_assert_runtime_extension_tree "$runtime_dest" "$selected_extensions" "$platform"
  local static_registry_files=0 static_registry_bytes=0
  local manifest_selected_extensions="" manifest_extensions="" mobile_static_state="not-required"
  local mobile_static_registered="" native_module_stems="" mobile_static_source=""
  local selected_extension_files=0 selected_extension_bytes=0
  local extension extension_files extension_bytes extension_size_rows
  extension_size_rows="$package_root/.extension-size-rows"
  : >"$extension_size_rows"
  if [ -n "$selected_extensions" ]; then
    manifest_selected_extensions="$(
      printf '%s\n' "$selected_extensions" |
        tr ',' '\n' |
        sed '/^$/d' |
        LC_ALL=C sort -u |
        paste -sd, -
    )"
    manifest_extensions="$(oliphaunt_dev_mobile_createable_extensions_for_selection "$selected_extensions")"
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

  local runtime_bytes standard_seed_bytes icu_seed_bytes total_bytes runtime_files standard_seed_files icu_seed_files total_files
  runtime_bytes="$(directory_bytes "$runtime_dest")"
  standard_seed_bytes="$(directory_bytes "$package_root/oliphaunt/cluster-seed/files")"
  icu_seed_bytes="$(directory_bytes "$package_root/oliphaunt/cluster-seed-icu/files")"
  static_registry_bytes="$(directory_bytes "$static_registry_dest")"
  total_bytes=$((runtime_bytes + standard_seed_bytes + icu_seed_bytes + static_registry_bytes))
  runtime_files="$(directory_files "$runtime_dest")"
  standard_seed_files="$(directory_files "$package_root/oliphaunt/cluster-seed/files")"
  icu_seed_files="$(directory_files "$package_root/oliphaunt/cluster-seed-icu/files")"
  static_registry_files="$(directory_files "$static_registry_dest")"
  total_files=$((runtime_files + standard_seed_files + icu_seed_files + static_registry_files))

  local runtime_key cluster_seed_target
  runtime_key="$(directory_fingerprint "$runtime_dest")"
  cluster_seed_target="$(sed -n 's/^clusterSeedTarget=//p' "$seed_closure/manifest.properties")"

  mkdir -p "$package_root/oliphaunt/runtime"
  cat >"$package_root/oliphaunt/runtime/manifest.properties" <<MANIFEST
schema=oliphaunt-runtime-resources-v1
cacheKey=$runtime_key
layout=postgres-runtime-files-v1
artifactRole=runtime
catalogProfile=
clusterSeedTarget=$cluster_seed_target
icuDataTreeSha256=
mode=native-direct
selectedExtensions=$manifest_selected_extensions
extensions=$manifest_extensions
runtimeFeatures=
sharedPreloadLibraries=
mobileStaticRegistryState=$mobile_static_state
mobileStaticRegistryRegistered=$mobile_static_registered
mobileStaticRegistryPending=
nativeModuleStems=$native_module_stems
mobileStaticRegistrySource=$mobile_static_source
MANIFEST
  cat >"$package_root/oliphaunt/package-size.tsv" <<REPORT
kind	id	extensions	files	bytes
package	total	-	$total_files	$total_bytes
package	runtime	-	$runtime_files	$runtime_bytes
package	cluster-seed	-	$standard_seed_files	$standard_seed_bytes
package	cluster-seed-icu	-	$icu_seed_files	$icu_seed_bytes
package	static-registry	-	$static_registry_files	$static_registry_bytes
extensions	selected	-	$selected_extension_files	$selected_extension_bytes
REPORT
  cat "$extension_size_rows" >>"$package_root/oliphaunt/package-size.tsv"

  printf '%s' "$current_sources" >"$source_stamp"
  touch "$prepared_stamp"

  printf '%s\n' "$package_root"
}
