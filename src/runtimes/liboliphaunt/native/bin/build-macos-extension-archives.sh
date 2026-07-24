#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="$script_dir/$(basename "${BASH_SOURCE[0]}")"
. "$script_dir/common.sh"
. "$script_dir/icu.sh"
. "$script_dir/mobile-static-extensions.sh"
. "$script_dir/mobile-postgis-extensions.sh"
repo_root="$(oliphaunt_resolve_repo_root "$script_dir")"

oliphaunt_mobile_target="macos-arm64"
pg_version="18.4"
runtime_root="${OLIPHAUNT_MACOS_RUNTIME_ROOT:-${OLIPHAUNT_WORK_ROOT:-$repo_root/target/liboliphaunt-pg18}}"
work_root="${OLIPHAUNT_MACOS_EXTENSION_ARCHIVE_ROOT:-$runtime_root/macos-extension-archives}"
build_dir="$runtime_root/postgresql-$pg_version"
install_dir="$runtime_root/install"
out_dir="$work_root/out"
make_log="$work_root/make.log"
stamp="$out_dir/.macos-extension-archives.inputs.sha256"
mobile_static_dependency_root="$out_dir/dependencies"
export OLIPHAUNT_MOBILE_STATIC_DEPENDENCY_ROOT="$mobile_static_dependency_root"
mobile_static_extensions=()
mobile_static_objects=()
mobile_static_dependency_archives=()
script_mode="${1:-build}"

fail() {
  echo "build-macos-extension-archives.sh: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'MSG'
usage: src/runtimes/liboliphaunt/native/bin/build-macos-extension-archives.sh [--check-current]

Builds arm64 macOS static extension and dependency archives from the same
canonical source inventory and symbol-prefix contract used by the iOS lanes.
OLIPHAUNT_MOBILE_STATIC_EXTENSIONS must contain the selected SQL names.
MSG
}

case "$script_mode" in
  build|--check-current) ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
esac

[ "$(uname -s)" = "Darwin" ] || fail "arm64 macOS extension archives require Darwin"
for cmd in cmake git make nm perl rsync shasum xcrun; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: $cmd"
done

sdk_path="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
clang_path="$(xcrun --find --sdk macosx clang 2>/dev/null || true)"
clangxx_path="$(xcrun --find --sdk macosx clang++ 2>/dev/null || true)"
libtool_path="$(xcrun --find --sdk macosx libtool 2>/dev/null || true)"
ar_path="$(xcrun --find --sdk macosx ar 2>/dev/null || true)"
ranlib_path="$(xcrun --find --sdk macosx ranlib 2>/dev/null || true)"
for value in "$sdk_path" "$clang_path" "$clangxx_path" "$libtool_path" "$ar_path" "$ranlib_path"; do
  [ -n "$value" ] || fail "macOS SDK compiler tools are unavailable"
done

min_macos="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
case "$min_macos" in
  ""|*[!0-9.]*) fail "MACOSX_DEPLOYMENT_TARGET must be a numeric dotted version" ;;
esac
min_ios="${OLIPHAUNT_IOS_MIN_VERSION:-17.0}"
cc=(
  "$clang_path"
  -target "arm64-apple-macos${min_macos}"
  "-mmacosx-version-min=${min_macos}"
  -isysroot "$sdk_path"
)
cxx=(
  "$clangxx_path"
  -target "arm64-apple-macos${min_macos}"
  "-mmacosx-version-min=${min_macos}"
  -isysroot "$sdk_path"
)
ccache_mode="${OLIPHAUNT_CCACHE:-auto}"
if [ "$ccache_mode" != "0" ] && [ "$ccache_mode" != "off" ]; then
  ccache_bin=""
  if [ "$ccache_mode" = "auto" ]; then
    ccache_bin="$(command -v ccache || true)"
  else
    ccache_bin="$ccache_mode"
  fi
  if [ -n "$ccache_bin" ]; then
    cc=("$ccache_bin" "${cc[@]}")
    cxx=("$ccache_bin" "${cxx[@]}")
  fi
fi
cc_string="${cc[*]}"
cxx_string="${cxx[*]}"
native_cflags="$(oliphaunt_native_release_cflags -fPIC "-mmacosx-version-min=$min_macos" -DOLIPHAUNT_EMBEDDED)"
icu_prefix="$runtime_root/icu-macos"
pg_extension_cflags="$native_cflags $(oliphaunt_icu_cflags "$icu_prefix")"
read -r -a native_cflag_args <<< "$native_cflags"
read -r -a pg_extension_cflag_args <<< "$pg_extension_cflags"
jobs="${OLIPHAUNT_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

parse_mobile_static_extensions() {
  local raw="${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS:-}"
  [ -n "$raw" ] || fail "OLIPHAUNT_MOBILE_STATIC_EXTENSIONS must select at least one native extension"
  local extension sql_name
  while IFS= read -r extension; do
    extension="$(printf '%s' "$extension" | xargs)"
    [ -n "$extension" ] || continue
    oliphaunt_mobile_static_extension_spec "$extension" >/dev/null || {
      printf 'supported static extensions: ' >&2
      oliphaunt_mobile_static_supported_extensions | paste -sd ',' - >&2
      fail "unsupported macOS static extension: $extension"
    }
    sql_name="$(oliphaunt_mobile_static_extension_sql_name "$extension")"
    case " ${mobile_static_extensions[*]-} " in
      *" $sql_name "*) fail "duplicate macOS static extension selection: $sql_name" ;;
    esac
    mobile_static_extensions+=("$sql_name")
  done < <(printf '%s\n' "$raw" | tr ',' '\n')
  [ "${#mobile_static_extensions[@]}" -gt 0 ] || fail "no native macOS static extensions were selected"
}

mobile_static_extensions_include() {
  local wanted="$1"
  local extension
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    [ "$extension" = "$wanted" ] && return 0
  done
  return 1
}

mobile_static_dependency_selected() {
  local wanted="$1"
  local extension dependency
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    while IFS= read -r dependency; do
      [ -n "$dependency" ] || continue
      [ "$dependency" = "$wanted" ] && return 0
    done < <(oliphaunt_mobile_static_extension_dependencies_for_target "$extension" macos-arm64)
  done
  return 1
}

selected_dependencies() {
  local extension
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    oliphaunt_mobile_static_extension_dependencies_for_target "$extension" macos-arm64
  done | sed '/^$/d' | LC_ALL=C sort -u
}

hash_mobile_static_extension_sources() {
  local extension file
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      shasum -a 256 "$file"
    done < <(oliphaunt_mobile_static_extension_hash_inputs "$repo_root" "$build_dir" "$extension")
  done
}

desired_hash() {
  {
    printf 'pg_version=%s\n' "$pg_version"
    printf 'sdk_path=%s\n' "$sdk_path"
    printf 'clang_path=%s\n' "$clang_path"
    printf 'clangxx_path=%s\n' "$clangxx_path"
    printf 'min_macos=%s\n' "$min_macos"
    printf 'cc=%s\n' "$cc_string"
    printf 'cxx=%s\n' "$cxx_string"
    printf 'native_cflags=%s\n' "$native_cflags"
    printf 'pg_extension_cflags=%s\n' "$pg_extension_cflags"
    printf 'extensions=%s\n' "${mobile_static_extensions[*]-}"
    printf 'dependencies=%s\n' "$(selected_dependencies | paste -sd ',' -)"
    printf 'postgis_source_date_epoch=%s\n' "$(oliphaunt_postgis_reproducible_epoch)"
    shasum -a 256 "$script_path" "$script_dir/mobile-static-extensions.sh" "$script_dir/mobile-postgis-extensions.sh"
    shasum -a 256 \
      "$repo_root/src/extensions/external/postgis/tools/reproducible-time.sh" \
      "$repo_root/src/extensions/external/postgis/tools/reproducible-bin/date"
    hash_mobile_static_extension_sources
  } | shasum -a 256 | awk '{print $1}'
}

require_runtime_tree() {
  [ -d "$build_dir/src/include" ] || fail "macOS PostgreSQL build tree is missing: $build_dir"
  [ -d "$install_dir/share/postgresql" ] || fail "macOS PostgreSQL install tree is missing: $install_dir"
  [ -d "$icu_prefix/include" ] || fail "macOS ICU build is missing: $icu_prefix"
}

build_openssl_dependency() {
  mobile_static_dependency_selected openssl || return 0
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/openssl"
  local dependency_dir="$mobile_static_dependency_root/openssl"
  local build_root="$work_root/openssl-macos-arm64"
  local install_root="$work_root/openssl-macos-arm64-install"
  local installed_archive=""
  local archive="$dependency_dir/libcrypto.a"
  if [ -f "$archive" ] && [ -d "$dependency_dir/include/openssl" ]; then
    mobile_static_dependency_archives+=("$archive")
    return 0
  fi
  [ -f "$source_dir/Configure" ] || fail "pinned OpenSSL checkout is missing: $source_dir"
  rm -rf "$build_root" "$install_root" "$dependency_dir"
  mkdir -p "$build_root" "$dependency_dir/include"
  rsync -a --delete --exclude .git "$source_dir/" "$build_root/"
  (
    cd "$build_root"
    CC="$cc_string" AR="$ar_path" RANLIB="$ranlib_path" \
      CFLAGS="-O2 -fPIC -mmacosx-version-min=${min_macos}" \
      ./Configure darwin64-arm64-cc \
        no-shared no-tests no-apps no-docs no-engine no-module \
        --prefix="$install_root" \
        --openssldir="$install_root/ssl" >> "$make_log" 2>&1
    make -j"$jobs" build_generated libcrypto.a >> "$make_log" 2>&1
    make install_dev >> "$make_log" 2>&1
  )
  for candidate in "$install_root/lib/libcrypto.a" "$install_root/lib64/libcrypto.a"; do
    if [ -f "$candidate" ]; then
      installed_archive="$candidate"
      break
    fi
  done
  [ -n "$installed_archive" ] || fail "OpenSSL macOS arm64 build did not produce libcrypto.a"
  cp -R "$install_root/include/openssl" "$dependency_dir/include/"
  cp -p "$installed_archive" "$archive"
  mobile_static_dependency_archives+=("$archive")
}

build_uuid_dependency() {
  mobile_static_dependency_selected uuid || return 0
  local source_dir="$repo_root/src/runtimes/liboliphaunt/native/portable-uuid"
  local dependency_dir="$mobile_static_dependency_root/uuid"
  local archive="$dependency_dir/lib/libuuid.a"
  local object="$dependency_dir/portable_uuid.o"
  if [ -f "$archive" ] && [ -d "$dependency_dir/include/uuid" ]; then
    mobile_static_dependency_archives+=("$archive")
    return 0
  fi
  [ -f "$source_dir/portable_uuid.c" ] || fail "portable UUID source is missing: $source_dir"
  rm -rf "$dependency_dir"
  mkdir -p "$dependency_dir/include" "$dependency_dir/lib"
  cp -R "$source_dir/include/uuid" "$dependency_dir/include/"
  "${cc[@]}" "${native_cflag_args[@]}" \
    -I"$source_dir/include" \
    -I"$build_dir/src/include" \
    -I"$build_dir/src/include/port" \
    -c "$source_dir/portable_uuid.c" \
    -o "$object"
  "$libtool_path" -static -o "$archive" "$object"
  [ -s "$archive" ] || fail "portable UUID macOS arm64 build did not produce $archive"
  mobile_static_dependency_archives+=("$archive")
}

build_static_dependencies() {
  mkdir -p "$mobile_static_dependency_root"
  build_openssl_dependency
  build_uuid_dependency
  build_postgis_mobile_static_dependencies
}

archive_mobile_static_extension_objects() {
  local extension="$1"
  local object_dir="$2"
  local objects_file="$3"
  local stem archive object
  local -a archive_objects=()
  stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
  archive="$object_dir/liboliphaunt_extension_$stem.a"
  while IFS= read -r object; do
    [ -n "$object" ] && archive_objects+=("$object")
  done < "$objects_file"
  [ "${#archive_objects[@]}" -gt 0 ] || fail "macOS static extension $extension has no object inputs"
  rm -f "$archive"
  "$libtool_path" -static -o "$archive" "${archive_objects[@]}"
  [ -s "$archive" ] || fail "macOS static extension $extension did not produce $archive"
}

build_static_extension_objects() {
  local extension source source_dir source_rel object object_dir objects_file stem prefix include_dir cflag
  local -a compile_args extension_include_args extension_cflags
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    if [ "$extension" = "postgis" ]; then
      build_postgis_mobile_static_extension_objects "$extension"
      continue
    fi
    stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
    prefix="$(oliphaunt_static_symbol_prefix "$stem")"
    source_dir="$(oliphaunt_mobile_static_extension_source_dir "$repo_root" "$build_dir" "$extension")"
    extension_include_args=()
    while IFS= read -r include_dir; do
      [ -n "$include_dir" ] || continue
      extension_include_args+=("-I$include_dir")
    done < <(oliphaunt_mobile_static_extension_include_dirs "$repo_root" "$build_dir" "$extension")
    extension_cflags=()
    while IFS= read -r cflag; do
      [ -n "$cflag" ] || continue
      extension_cflags+=("$cflag")
    done < <(oliphaunt_mobile_static_extension_cflags "$extension")
    if [ "$(oliphaunt_mobile_static_extension_kind "$extension")" = "contrib" ]; then
      (
        cd "$build_dir"
        make -C "$(oliphaunt_mobile_static_extension_source_rel "$extension")" \
          CC="$cc_string" \
          CFLAGS="$pg_extension_cflags" \
          all >> "$make_log" 2>&1 || true
      )
    fi
    object_dir="$out_dir/extensions/$stem"
    objects_file="$object_dir/objects.list"
    rm -rf "$object_dir"
    mkdir -p "$object_dir"
    : > "$objects_file"
    while IFS= read -r source; do
      [ -n "$source" ] || continue
      [ -f "$source" ] || fail "macOS static extension source is missing: $source"
      source_rel="${source#"$source_dir"/}"
      object="$object_dir/${source_rel%.c}.o"
      mkdir -p "$(dirname "$object")"
      mobile_static_objects+=("$object")
      printf '%s\n' "$object" >> "$objects_file"
      compile_args=(
        "${cc[@]}" "${pg_extension_cflag_args[@]}"
        -DPg_magic_func="${prefix}_Pg_magic_func"
        -D_PG_init="${prefix}__PG_init"
      )
      if [ "${#extension_cflags[@]}" -gt 0 ]; then
        compile_args+=("${extension_cflags[@]}")
      fi
      if [ "${#extension_include_args[@]}" -gt 0 ]; then
        compile_args+=("${extension_include_args[@]}")
      fi
      compile_args+=(
        -I"$build_dir/src/include"
        -I"$build_dir/src/include/port"
        -c "$source"
        -o "$object"
      )
      "${compile_args[@]}"
    done < <(oliphaunt_mobile_static_extension_source_files "$repo_root" "$build_dir" "$extension")
    [ -s "$objects_file" ] || fail "macOS static extension $extension did not produce object inputs"
    archive_mobile_static_extension_objects "$extension" "$object_dir" "$objects_file"
  done
}

defined_c_symbols() {
  local stem="$1"
  local prefix="$2"
  local objects_file="$out_dir/extensions/$stem/objects.list"
  # shellcheck disable=SC2046
  nm -g $(cat "$objects_file") |
    awk '
      $2 == "T" {
        symbol = $3
        sub(/^_/, "", symbol)
        if (symbol == "" || index(symbol, prefix "_") == 1 || symbol == "Pg_magic_func" || symbol == "_PG_init") next
        if (symbol ~ /^[A-Za-z_][A-Za-z0-9_]*$/) print symbol
      }
    ' prefix="$prefix" |
    LC_ALL=C sort -u
}

module_has_c_symbol() {
  local stem="$1"
  local symbol="$2"
  local objects_file="$out_dir/extensions/$stem/objects.list"
  # shellcheck disable=SC2046
  nm -g $(cat "$objects_file") | awk -v wanted="_$symbol" '$3 == wanted { found = 1 } END { exit found ? 0 : 1 }'
}

write_registration_symbol_files() {
  local extension stem prefix symbols_file
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
    prefix="$(oliphaunt_static_symbol_prefix "$stem")"
    symbols_file="$out_dir/extensions/$stem/symbols.list"
    defined_c_symbols "$stem" "$prefix" > "$symbols_file"
    module_has_c_symbol "$stem" "${prefix}_Pg_magic_func" ||
      fail "macOS static extension $extension lacks ${prefix}_Pg_magic_func"
    if [ ! -s "$symbols_file" ] && ! module_has_c_symbol "$stem" "${prefix}__PG_init"; then
      fail "macOS static extension $extension produced neither SQL-visible symbols nor an init hook"
    fi
  done
}

dependency_archive() {
  case "$1" in
    openssl) printf '%s\n' "$mobile_static_dependency_root/openssl/libcrypto.a" ;;
    uuid) printf '%s\n' "$mobile_static_dependency_root/uuid/lib/libuuid.a" ;;
    geos) printf '%s\n' "$mobile_static_dependency_root/geos/lib/libgeos.a" ;;
    geos-c) printf '%s\n' "$mobile_static_dependency_root/geos/lib/libgeos_c.a" ;;
    json-c) printf '%s\n' "$mobile_static_dependency_root/json-c/lib/libjson-c.a" ;;
    libxml2) printf '%s\n' "$mobile_static_dependency_root/libxml2/lib/libxml2.a" ;;
    proj) printf '%s\n' "$mobile_static_dependency_root/proj/lib/libproj.a" ;;
    sqlite) printf '%s\n' "$mobile_static_dependency_root/sqlite/lib/libsqlite3.a" ;;
    *) fail "unsupported macOS extension dependency identity: $1" ;;
  esac
}

artifacts_ready() {
  local extension stem archive dependency
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
    archive="$out_dir/extensions/$stem/liboliphaunt_extension_$stem.a"
    [ -s "$archive" ] || return 1
    [ -s "$out_dir/extensions/$stem/objects.list" ] || return 1
    [ -f "$out_dir/extensions/$stem/symbols.list" ] || return 1
  done
  while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    archive="$(dependency_archive "$dependency")"
    [ -s "$archive" ] || return 1
  done < <(selected_dependencies)
}

write_manifest() {
  local extension stem dependency archive
  {
    printf 'packageLayout=oliphaunt-macos-extension-archives-v1\n'
    printf 'target=macos-arm64\n'
    printf 'minimumMacOS=%s\n' "$min_macos"
    printf 'extensions=%s\n' "$(printf '%s\n' "${mobile_static_extensions[@]}" | LC_ALL=C sort | paste -sd ',' -)"
    printf 'dependencies=%s\n' "$(selected_dependencies | paste -sd ',' -)"
    for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
      stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
      printf 'extension.%s.archive=extensions/%s/liboliphaunt_extension_%s.a\n' "$extension" "$stem" "$stem"
    done
    while IFS= read -r dependency; do
      [ -n "$dependency" ] || continue
      archive="$(dependency_archive "$dependency")"
      printf 'dependency.%s.archive=%s\n' "$dependency" "${archive#"$out_dir"/}"
    done < <(selected_dependencies)
  } > "$out_dir/manifest.properties"
}

parse_mobile_static_extensions
require_runtime_tree
mkdir -p "$out_dir"

if [ "$script_mode" = "--check-current" ]; then
  if artifacts_ready && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(desired_hash)" ]; then
    echo "macOS arm64 extension archives are current"
    exit 0
  fi
  fail "macOS arm64 extension archives are missing or stale"
fi

if artifacts_ready && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(desired_hash)" ]; then
  echo "$out_dir"
  exit 0
fi

rm -rf "$out_dir"
mkdir -p "$out_dir" "$mobile_static_dependency_root"
: > "$make_log"
build_static_dependencies
build_static_extension_objects
write_registration_symbol_files
artifacts_ready || fail "macOS arm64 extension archive set is incomplete"
write_manifest
desired_hash > "$stamp"
echo "$out_dir"
