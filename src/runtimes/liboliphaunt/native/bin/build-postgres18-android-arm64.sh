#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$script_dir/common.sh"
. "$script_dir/icu.sh"
. "$script_dir/mobile-static-extensions.sh"
. "$script_dir/mobile-postgis-extensions.sh"
script_path="$script_dir/$(basename "$0")"
repo_root="$(oliphaunt_resolve_repo_root "$script_dir")"
pg_version="18.4"
pg_sha256="81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094"
pg_url="https://ftp.postgresql.org/pub/source/v${pg_version}/postgresql-${pg_version}.tar.bz2"
source_manifest="$repo_root/src/runtimes/liboliphaunt/native/postgres18/source.toml"
patch_dir="$repo_root/src/runtimes/liboliphaunt/native/patches/postgresql-${pg_version}"
android_abi="${OLIPHAUNT_ANDROID_ABI:-arm64-v8a}"
case "$android_abi" in
  arm64-v8a)
    android_host="aarch64-linux-android"
    android_readelf_arch_regex="AArch64"
    oliphaunt_mobile_target="android-arm64"
    android_work_root="${OLIPHAUNT_ANDROID_WORK_ROOT:-${OLIPHAUNT_ANDROID_ROOT:-${OLIPHAUNT_ANDROID_ARM64_ROOT:-$repo_root/target/liboliphaunt-pg18-android-arm64}}}"
    ;;
  x86_64)
    android_host="x86_64-linux-android"
    android_readelf_arch_regex="X86-64|Advanced Micro Devices X86-64"
    oliphaunt_mobile_target="android-x86_64"
    android_work_root="${OLIPHAUNT_ANDROID_WORK_ROOT:-${OLIPHAUNT_ANDROID_ROOT:-${OLIPHAUNT_ANDROID_X86_64_ROOT:-$repo_root/target/liboliphaunt-pg18-android-x86_64}}}"
    ;;
  *)
    echo "error: unsupported Android ABI '$android_abi'; expected arm64-v8a or x86_64" >&2
    exit 1
    ;;
esac
work_root="$android_work_root"
source_cache="$work_root/source"
tarball="$source_cache/postgresql-${pg_version}.tar.bz2"
build_dir="$work_root/postgresql-${pg_version}"
install_dir="$work_root/install"
out_dir="$work_root/out"
stamp="$build_dir/.liboliphaunt-android-${android_abi}-build.sha256"
configure_log="$work_root/configure.log"
make_log="$work_root/make.log"
objects_rsp="$out_dir/liboliphaunt-android-${android_abi}-objects.rsp"
lib_out="$out_dir/liboliphaunt.so"
mobile_static_registry_source="$out_dir/liboliphaunt_mobile_static_registry.c"
mobile_static_registry_object="$out_dir/liboliphaunt_mobile_static_registry.o"
script_mode="${1:-build}"
icu_source_dir="$(oliphaunt_icu_source_dir "$repo_root")"
icu_native_build_dir="$work_root/icu-native"
icu_build_dir="$work_root/icu-$oliphaunt_mobile_target-build"
icu_prefix="$work_root/icu-$oliphaunt_mobile_target"
icu_cflags="$(oliphaunt_icu_cflags "$icu_prefix")"
icu_static_libs="$(oliphaunt_icu_static_libs "$icu_prefix")"
icu_cpp_libs="-lc++_static -lc++abi"
icu_libs="$icu_static_libs $icu_cpp_libs"

liboliphaunt_sources=(
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_native.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_runtime.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_protocol.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_bootstrap.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_process.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_trace.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_fs.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_archive.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_archive_tar.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_static_extensions.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_builtin_extensions.c"
)

plpgsql_objects=(
  src/pl/plpgsql/src/pl_comp.o
  src/pl/plpgsql/src/pl_exec.o
  src/pl/plpgsql/src/pl_funcs.o
  src/pl/plpgsql/src/pl_gram.o
  src/pl/plpgsql/src/pl_handler.o
  src/pl/plpgsql/src/pl_scanner.o
)

jit_objects=(
  src/backend/jit/jit.o
)

mobile_static_extensions=()
mobile_static_objects=()
mobile_static_dependency_archives=()
mobile_static_dependency_root="$out_dir/dependencies"
export OLIPHAUNT_MOBILE_STATIC_DEPENDENCY_ROOT="$mobile_static_dependency_root"

fail() {
  echo "error: $*" >&2
  exit 1
}

for cmd in curl git patch perl rg shasum; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: $cmd"
done

if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
[ -n "${ANDROID_HOME:-}" ] || fail "ANDROID_HOME is not set"

ndk_root="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
if [ -z "$ndk_root" ]; then
  ndk_root="$(find "$ANDROID_HOME/ndk" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "$ndk_root" ] && [ -d "$ndk_root" ] || fail "Android NDK not found under ANDROID_HOME=$ANDROID_HOME"

android_ndk_prebuilt_candidates() {
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64 | Darwin:aarch64)
      printf '%s\n' darwin-arm64 darwin-x86_64
      ;;
    Darwin:x86_64)
      printf '%s\n' darwin-x86_64
      ;;
    Linux:x86_64 | Linux:amd64)
      printf '%s\n' linux-x86_64
      ;;
    Linux:aarch64 | Linux:arm64)
      printf '%s\n' linux-aarch64 linux-x86_64
      ;;
    *)
      return 1
      ;;
  esac
}

toolchain_dir=""
while IFS= read -r prebuilt_host; do
  candidate="$ndk_root/toolchains/llvm/prebuilt/$prebuilt_host"
  if [ -d "$candidate/bin" ]; then
    toolchain_dir="$candidate"
    break
  fi
done < <(android_ndk_prebuilt_candidates || true)
[ -n "$toolchain_dir" ] || fail "Android NDK LLVM toolchain not found under $ndk_root for host $(uname -s)/$(uname -m)"

android_api="${OLIPHAUNT_ANDROID_API_LEVEL:-24}"
clang_path="$toolchain_dir/bin/${android_host}${android_api}-clang"
clangxx_path="$toolchain_dir/bin/${android_host}${android_api}-clang++"
cpp_path="$clang_path -E"
llvm_nm="$toolchain_dir/bin/llvm-nm"
llvm_ar="$toolchain_dir/bin/llvm-ar"
llvm_ranlib="$toolchain_dir/bin/llvm-ranlib"
[ -x "$clang_path" ] || fail "Android clang not found: $clang_path"
[ -x "$clangxx_path" ] || fail "Android clang++ not found: $clangxx_path"
[ -x "$llvm_nm" ] || fail "Android llvm-nm not found: $llvm_nm"
[ -x "$llvm_ar" ] || fail "Android llvm-ar not found: $llvm_ar"
[ -x "$llvm_ranlib" ] || fail "Android llvm-ranlib not found: $llvm_ranlib"
oliphaunt_icu_require_source "$icu_source_dir"

cc=("$clang_path")
cxx=("$clangxx_path")
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
postgres_cppflags="-D_GNU_SOURCE"
native_cflags="$(oliphaunt_native_release_cflags -fPIC -DOLIPHAUNT_EMBEDDED -DOLIPHAUNT_EMBEDDED_MOBILE_SHMEM -Wno-unused-command-line-argument)"
liboliphaunt_cflags="$native_cflags -DOLIPHAUNT_BUILTIN_PLPGSQL"
pg_extension_cflags="$native_cflags $postgres_cppflags $icu_cflags"
jobs="${OLIPHAUNT_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

parse_mobile_static_extensions() {
  local raw="${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS:-}"
  [ -n "$raw" ] || return 0
  local extension
  while IFS= read -r extension; do
    extension="$(printf '%s' "$extension" | xargs)"
    [ -n "$extension" ] || continue
    if ! oliphaunt_mobile_static_extension_spec "$extension" >/dev/null; then
      printf 'supported Android mobile static extensions: ' >&2
      oliphaunt_mobile_static_supported_extensions | paste -sd ',' - >&2
      fail "unsupported Android mobile static extension: $extension"
    fi
    mobile_static_extensions+=("$(oliphaunt_mobile_static_extension_sql_name "$extension")")
  done < <(printf '%s\n' "$raw" | tr ',' '\n')
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
    done < <(oliphaunt_mobile_static_extension_dependencies "$extension")
  done
  return 1
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

patch_series() {
  sed -n '/series = \[/,/\]/p' "$source_manifest" |
    sed -n 's/.*"\([^"]*\.patch\)".*/\1/p'
}

patch_series_hash() {
  while IFS= read -r patch_name; do
    [ -n "$patch_name" ] || continue
    shasum -a 256 "$patch_dir/$patch_name"
  done < <(patch_series) | shasum -a 256 | awk '{print $1}'
}

desired_hash() {
  {
    printf 'pg_version=%s\n' "$pg_version"
    printf 'pg_sha256=%s\n' "$pg_sha256"
    printf 'android_abi=%s\n' "$android_abi"
    printf 'android_host=%s\n' "$android_host"
    printf 'ndk_root=%s\n' "$ndk_root"
    printf 'toolchain_dir=%s\n' "$toolchain_dir"
    printf 'android_api=%s\n' "$android_api"
    printf 'cc=%s\n' "$cc_string"
    printf 'cxx=%s\n' "$cxx_string"
    printf 'ar=%s\n' "$llvm_ar"
    printf 'ranlib=%s\n' "$llvm_ranlib"
    printf 'icu_source=%s\n' "$(oliphaunt_icu_source_commit "$icu_source_dir")"
    printf 'icu_script=%s\n' "$(oliphaunt_icu_script_sha256 "$script_dir")"
    printf 'native_cflags=%s\n' "$native_cflags"
    printf 'liboliphaunt_cflags=%s\n' "$liboliphaunt_cflags"
    printf 'pg_extension_cflags=%s\n' "$pg_extension_cflags"
    printf 'mobile_static_extensions=%s\n' "${mobile_static_extensions[*]-}"
    printf 'patch_series_hash=%s\n' "$(patch_series_hash)"
    printf 'liboliphaunt_sources=%s\n' "${liboliphaunt_sources[*]}"
    printf 'plpgsql_objects=%s\n' "${plpgsql_objects[*]}"
    printf 'jit_objects=%s\n' "${jit_objects[*]}"
    printf 'script_sha256=%s\n' "$(shasum -a 256 "$script_path" | awk '{print $1}')"
    shasum -a 256 "$script_dir/mobile-static-extensions.sh" "$script_dir/mobile-postgis-extensions.sh"
    shasum -a 256 "$source_manifest"
    shasum -a 256 "${liboliphaunt_sources[@]}"
    hash_mobile_static_extension_sources
  } | shasum -a 256 | awk '{print $1}'
}

apply_patch_series() {
  local patch_name
  while IFS= read -r patch_name; do
    [ -n "$patch_name" ] || continue
    GIT_CEILING_DIRECTORIES="$work_root" git apply --recount --whitespace=nowarn "$patch_dir/$patch_name" >/dev/null
  done < <(patch_series)
}

patched_source_ready() {
  grep -Fq 'OliphauntEmbeddedIO' "$build_dir/src/include/libpq/libpq-be.h" &&
    grep -Fq 'oliphaunt_embedded_main' "$build_dir/src/backend/tcop/postgres.c" &&
    grep -Fq 'getenv("ICU_DATA")' "$build_dir/src/bin/initdb/initdb.c" &&
    grep -Fq 'oliphaunt_embedded' "$build_dir/meson_options.txt" &&
    grep -Fq 'OLIPHAUNT_EMBEDDED' "$build_dir/meson.build"
}

artifact_ready() {
  [ -f "$lib_out" ] || return 1
  oliphaunt_icu_artifacts_ready "$icu_prefix" || return 1
  "$toolchain_dir/bin/llvm-readelf" -h "$lib_out" 2>/dev/null | rg -q "$android_readelf_arch_regex" || return 1
  local symbols
  symbols="$("$llvm_nm" -D --defined-only "$lib_out" 2>/dev/null || true)"
  local linked_symbols
  linked_symbols="$("$llvm_nm" --defined-only "$lib_out" 2>/dev/null || true)"
  oliphaunt_icu_linked_symbols_ready "$linked_symbols" || return 1
  local undefined_symbols
  undefined_symbols="$("$llvm_nm" -D --undefined-only "$lib_out" 2>/dev/null || true)"
  if printf '%s\n' "$undefined_symbols" | rg -q 'shm(get|ctl|dt)|shm_open|sem(get|ctl|op|open|close|unlink|wait|post|trywait|init|destroy)'; then
    return 1
  fi
  local symbol
  for symbol in \
    oliphaunt_init \
    oliphaunt_exec_protocol \
    oliphaunt_exec_simple_query \
    oliphaunt_exec_protocol_stream \
    oliphaunt_backup \
    oliphaunt_backup_ex \
    oliphaunt_restore \
    oliphaunt_cancel \
    oliphaunt_detach \
    oliphaunt_close \
    oliphaunt_register_static_extensions \
    oliphaunt_last_error \
    oliphaunt_version \
    oliphaunt_capabilities \
    oliphaunt_free_response
  do
    case "$symbols" in *" T $symbol"*|*" D $symbol"*|*" B $symbol"*) ;; *) return 1 ;; esac
  done
  if [ "${#mobile_static_extensions[@]}" -gt 0 ]; then
    case "$symbols" in *" T liboliphaunt_selected_static_extensions"*|*" D liboliphaunt_selected_static_extensions"*|*" B liboliphaunt_selected_static_extensions"*) ;; *) return 1 ;; esac
    local extension stem prefix
    for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
      stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
      prefix="$(oliphaunt_static_symbol_prefix "$stem")"
      [ -f "$out_dir/extensions/$stem/liboliphaunt_extension_$stem.a" ] || return 1
      case "$symbols" in *" T ${prefix}_Pg_magic_func"*|*" D ${prefix}_Pg_magic_func"*|*" B ${prefix}_Pg_magic_func"*) ;; *) return 1 ;; esac
    done
  fi
}

report_artifact_not_ready() {
  echo "Android $android_abi liboliphaunt shared library failed validation" >&2
  if [ ! -f "$lib_out" ]; then
    echo "missing shared library: $lib_out" >&2
    return 0
  fi

  echo "shared library: $lib_out" >&2
  "$toolchain_dir/bin/llvm-readelf" -h "$lib_out" >&2 || true

  local symbols undefined_symbols linked_symbols
  symbols="$("$llvm_nm" -D --defined-only "$lib_out" 2>/dev/null || true)"
  undefined_symbols="$("$llvm_nm" -D --undefined-only "$lib_out" 2>/dev/null || true)"
  linked_symbols="$("$llvm_nm" --defined-only "$lib_out" 2>/dev/null || true)"
  echo "defined Oliphaunt API symbols:" >&2
  printf '%s\n' "$symbols" | rg ' oliphaunt_| liboliphaunt_selected_static_extensions' >&2 || true
  echo "unexpected Android IPC/POSIX shared-memory undefined symbols:" >&2
  printf '%s\n' "$undefined_symbols" | rg 'shm(get|ctl|dt)|shm_open|sem(get|ctl|op|open|close|unlink|wait|post|trywait|init|destroy)' >&2 || true
  if ! oliphaunt_icu_linked_symbols_ready "$linked_symbols"; then
    echo "ICU static link validation failed" >&2
  fi
  if [ -f "$make_log" ]; then
    echo "tail of PostgreSQL Android $android_abi make log:" >&2
    tail -120 "$make_log" >&2 || true
  fi
}

backend_objects_ready() {
  for required in \
    src/backend/tcop/postgres.o \
    src/backend/libpq/be-secure.o \
    src/backend/libpq/pqcomm.o \
    src/backend/port/oliphaunt_embedded_sema.o \
    src/backend/port/oliphaunt_embedded_shmem.o \
    src/common/libpgcommon_srv.a \
    src/port/libpgport_srv.a
  do
    [ -f "$required" ] || return 1
  done
  for objfile in src/backend/*/objfiles.txt; do
    [ -s "$objfile" ] || return 1
  done
  "$llvm_nm" -g src/backend/tcop/postgres.o | rg -q "oliphaunt_embedded_main" || return 1
}

plpgsql_objects_ready() {
  local object
  for object in "${plpgsql_objects[@]}"; do
    [ -f "$object" ] || return 1
  done
  "$llvm_nm" -g src/pl/plpgsql/src/pl_handler.o | rg -q "plpgsql_call_handler" || return 1
}

jit_objects_ready() {
  local object
  for object in "${jit_objects[@]}"; do
    [ -f "$object" ] || return 1
  done
  "$llvm_nm" -g src/backend/jit/jit.o | rg -q "pg_jit_available" || return 1
}

prepare_source() {
  mkdir -p "$source_cache" "$work_root" "$out_dir"

  if [ ! -f "$tarball" ]; then
    curl -L --fail --silent --show-error "$pg_url" -o "$tarball"
  fi
  (
    cd "$source_cache"
    printf '%s  %s\n' "$pg_sha256" "postgresql-${pg_version}.tar.bz2" | shasum -a 256 -c -
  ) >&2

  local wanted
  wanted="$(desired_hash)"
  if [ -d "$build_dir" ] && { [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$wanted" ]; }; then
    rm -rf "$build_dir"
  fi
  if [ ! -d "$build_dir" ]; then
    tar -xjf "$tarball" -C "$work_root"
    (
      cd "$build_dir"
      git init -q
      apply_patch_series
    )
  fi
  patched_source_ready || fail "PostgreSQL embedded patch verification failed"
}

configure_source() {
  export CC="$cc_string"
  export CXX="$cxx_string"
  export CPP="$cpp_path"
  export AR="$llvm_ar"
  export RANLIB="$llvm_ranlib"
  export CFLAGS="$native_cflags"
  export CPPFLAGS="$postgres_cppflags $icu_cflags"
  export LDFLAGS="-L$icu_prefix/lib"
  export ICU_CFLAGS="$icu_cflags"
  export ICU_LIBS="$icu_libs"

  if [ ! -f "$build_dir/config.status" ]; then
    local build_alias
    build_alias="$(sh "$build_dir/config/config.guess")"
    (
      cd "$build_dir"
      ./configure \
        --host="$android_host" \
        --build="$build_alias" \
        --prefix="$install_dir" \
        --without-readline \
        --with-icu \
        --without-llvm \
        --without-pam \
        --with-openssl=no \
        --without-zlib \
        --disable-nls
    ) > "$configure_log" 2>&1
  fi
}

build_icu() {
  oliphaunt_icu_build_target \
    "$icu_source_dir" \
    "$script_dir" \
    "$icu_native_build_dir" \
    "$icu_build_dir" \
    "$icu_prefix" \
    "$jobs" \
    "$oliphaunt_mobile_target" \
    "$android_host" \
    "$cc_string" \
    "$cxx_string" \
    "$llvm_ar" \
    "$llvm_ranlib" \
    "$native_cflags" \
    "$native_cflags" \
    ""
}

build_backend_objects() {
  (
    cd "$build_dir"
    if backend_objects_ready; then
      echo "reusing PostgreSQL Android $android_abi backend objects" >&2
      return
    fi

    : > "$make_log"
    rm -f src/include/nodes/header-stamp src/include/utils/header-stamp
    make -C src/backend generated-headers CC="$cc_string" >> "$make_log" 2>&1

    set +e
    make -j"$jobs" -C src/backend \
      CC="$cc_string" \
      AR="$llvm_ar" \
      RANLIB="$llvm_ranlib" \
      CFLAGS="$native_cflags" \
      postgres >> "$make_log" 2>&1
    local make_status=$?
    set -e

    make -C src/common \
      CC="$cc_string" \
      AR="$llvm_ar" \
      RANLIB="$llvm_ranlib" \
      libpgcommon_srv.a >> "$make_log" 2>&1
    make -C src/port \
      CC="$cc_string" \
      AR="$llvm_ar" \
      RANLIB="$llvm_ranlib" \
      libpgport_srv.a >> "$make_log" 2>&1

    if ! backend_objects_ready; then
      tail -120 "$make_log" >&2 || true
      echo "PostgreSQL Android $android_abi backend objects are incomplete" >&2
      exit 1
    fi
    if [ "$make_status" -ne 0 ]; then
      echo "PostgreSQL Android $android_abi executable/tool build failed after embedded objects were produced; continuing with shared library link" >&2
    fi
  )
}

build_timezone_objects() {
  (
    cd "$build_dir"
    make -C src/timezone \
      CC="$cc_string" \
      AR="$llvm_ar" \
      RANLIB="$llvm_ranlib" \
      CFLAGS="$native_cflags" \
      localtime.o pgtz.o strftime.o >> "$make_log" 2>&1
  )
}

build_plpgsql_objects() {
  (
    cd "$build_dir"
    if plpgsql_objects_ready; then
      echo "reusing PostgreSQL Android $android_abi PL/pgSQL objects" >&2
      return
    fi

    make -C src/pl/plpgsql/src clean >> "$make_log" 2>&1
    make -C src/pl/plpgsql/src \
      CC="$cc_string" \
      AR="$llvm_ar" \
      RANLIB="$llvm_ranlib" \
      CFLAGS="$native_cflags" \
      pl_comp.o pl_exec.o pl_funcs.o pl_gram.o pl_handler.o pl_scanner.o >> "$make_log" 2>&1

    if ! plpgsql_objects_ready; then
      tail -120 "$make_log" >&2 || true
      echo "PostgreSQL Android $android_abi PL/pgSQL objects are incomplete" >&2
      exit 1
    fi
  )
}

build_jit_objects() {
  (
    cd "$build_dir"
    if jit_objects_ready; then
      echo "reusing PostgreSQL Android $android_abi JIT stub objects" >&2
      return
    fi

    make -C src/backend/jit \
      CC="$cc_string" \
      AR="$llvm_ar" \
      RANLIB="$llvm_ranlib" \
      CFLAGS="$native_cflags" \
      jit.o >> "$make_log" 2>&1

    if ! jit_objects_ready; then
      tail -120 "$make_log" >&2 || true
      echo "PostgreSQL Android $android_abi JIT stub objects are incomplete" >&2
      exit 1
    fi
  )
}

build_liboliphaunt_objects() {
  local source object
  liboliphaunt_objects=()
  for source in "${liboliphaunt_sources[@]}"; do
    object="$out_dir/$(basename "${source%.c}").o"
    liboliphaunt_objects+=("$object")
    "${cc[@]}" $liboliphaunt_cflags \
      -I"$repo_root/src/runtimes/liboliphaunt/native/include" \
      -I"$repo_root/src/runtimes/liboliphaunt/native/src" \
      -c "$source" \
      -o "$object"
  done
}

build_openssl_dependency() {
  mobile_static_dependency_selected openssl || return 0
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/openssl"
  local dependency_dir="$mobile_static_dependency_root/openssl"
  local build_root="$work_root/openssl-$oliphaunt_mobile_target"
  local install_root="$work_root/openssl-$oliphaunt_mobile_target-install"
  local installed_archive=""
  local archive="$dependency_dir/libcrypto.a"
  local configure_target

  if [ -f "$archive" ] && [ -d "$dependency_dir/include/openssl" ]; then
    mobile_static_dependency_archives+=("$archive")
    return 0
  fi
  [ -d "$source_dir" ] || fail "OpenSSL checkout is missing: $source_dir"
  case "$android_abi" in
    arm64-v8a) configure_target="android-arm64" ;;
    x86_64) configure_target="android-x86_64" ;;
    *) fail "unsupported Android ABI for OpenSSL: $android_abi" ;;
  esac

  rm -rf "$build_root" "$install_root" "$dependency_dir"
  mkdir -p "$(dirname "$build_root")" "$dependency_dir/include"
  cp -a "$source_dir/." "$build_root/"
  rm -rf "$build_root/.git"
  (
    cd "$build_root"
    PATH="$toolchain_dir/bin:$PATH" \
      ANDROID_NDK_ROOT="$ndk_root" \
      ./Configure "$configure_target" \
        -D__ANDROID_API__="$android_api" \
        no-shared no-tests no-apps no-docs no-engine no-module \
        --prefix="$install_root" \
        --openssldir="$install_root/ssl" >> "$make_log" 2>&1
    PATH="$toolchain_dir/bin:$PATH" make -j"$jobs" build_generated libcrypto.a >> "$make_log" 2>&1
    PATH="$toolchain_dir/bin:$PATH" make install_dev >> "$make_log" 2>&1
  )
  for candidate in "$install_root/lib/libcrypto.a" "$install_root/lib64/libcrypto.a"; do
    if [ -f "$candidate" ]; then
      installed_archive="$candidate"
      break
    fi
  done
  [ -n "$installed_archive" ] || fail "OpenSSL Android $android_abi build did not produce libcrypto.a"
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
  "${cc[@]}" $pg_extension_cflags \
    -I"$source_dir/include" \
    -I"$build_dir/src/include" \
    -I"$build_dir/src/include/port" \
    -c "$source_dir/portable_uuid.c" \
    -o "$object"
  "$llvm_ar" crs "$archive" "$object"
  "$llvm_ranlib" "$archive"
  [ -s "$archive" ] || fail "portable UUID Android $android_abi build did not produce $archive"
  mobile_static_dependency_archives+=("$archive")
}

build_mobile_static_dependencies() {
  build_openssl_dependency
  build_uuid_dependency
  build_postgis_mobile_static_dependencies
}

build_mobile_static_extension_objects() {
  local extension source source_dir source_rel object object_dir objects_file stem prefix
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
          AR="$llvm_ar" \
          RANLIB="$llvm_ranlib" \
          CFLAGS="$pg_extension_cflags" \
          all >> "$make_log" 2>&1 || true
      )
    fi
    object_dir="$out_dir/extensions/$stem"
    objects_file="$object_dir/objects.list"
    mkdir -p "$object_dir"
    : > "$objects_file"
    while IFS= read -r source; do
      [ -n "$source" ] || continue
      source_rel="${source#$source_dir/}"
      object="$object_dir/${source_rel%.c}.o"
      mkdir -p "$(dirname "$object")"
      mobile_static_objects+=("$object")
      printf '%s\n' "$object" >> "$objects_file"
      compile_args=(
        "${cc[@]}" $pg_extension_cflags
        -DPg_magic_func="${prefix}_Pg_magic_func" \
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
    if [ ! -s "$objects_file" ]; then
      fail "mobile static extension $extension did not produce object inputs"
    fi
    archive_mobile_static_extension_objects "$extension" "$object_dir" "$objects_file"
  done
}

archive_mobile_static_extension_objects() {
  local extension="$1"
  local object_dir="$2"
  local objects_file="$3"
  local stem archive
  local -a archive_objects
  stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
  archive="$object_dir/liboliphaunt_extension_$stem.a"
  while IFS= read -r object; do
    [ -n "$object" ] && archive_objects+=("$object")
  done < "$objects_file"
  rm -f "$archive"
  "$llvm_ar" crs "$archive" "${archive_objects[@]}"
  "$llvm_ranlib" "$archive"
  if [ ! -s "$archive" ]; then
    fail "mobile static extension $extension did not produce archive $archive"
  fi
}

defined_c_symbols() {
  local stem="$1"
  local prefix="$2"
  local objects_file="$out_dir/extensions/$stem/objects.list"
  # shellcheck disable=SC2046
  "$llvm_nm" -g --defined-only $(cat "$objects_file") |
    awk '
      $2 == "T" {
        symbol = $3
        if (symbol == "" ||
            index(symbol, prefix "_") == 1 ||
            symbol == "Pg_magic_func" ||
            symbol == "_PG_init") {
          next
        }
        if (symbol ~ /^[A-Za-z_][A-Za-z0-9_]*$/) {
          print symbol
        }
      }
    ' prefix="$prefix" |
    LC_ALL=C sort -u
}

module_has_c_symbol() {
  local stem="$1"
  local symbol="$2"
  local objects_file="$out_dir/extensions/$stem/objects.list"
  # shellcheck disable=SC2046
  "$llvm_nm" -g --defined-only $(cat "$objects_file") | awk -v wanted="$symbol" '$3 == wanted { found = 1 } END { exit found ? 0 : 1 }'
}

write_mobile_static_registry_source() {
  [ "${#mobile_static_extensions[@]}" -gt 0 ] || return 0
  local extension stem prefix symbols_file alias_file init_symbol symbols_expr symbol_count_expr
  {
    cat <<'HEADER'
/* Generated by Oliphaunt mobile build. Do not edit by hand. */
#include <stddef.h>
#include <stdint.h>
#include "oliphaunt.h"

HEADER
    for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
      stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
      prefix="$(oliphaunt_static_symbol_prefix "$stem")"
      symbols_file="$out_dir/extensions/$stem/symbols.list"
      alias_file="$out_dir/extensions/$stem/symbol-aliases.list"
      defined_c_symbols "$stem" "$prefix" > "$symbols_file"
      if [ ! -s "$symbols_file" ] && ! module_has_c_symbol "$stem" "${prefix}__PG_init"; then
        fail "mobile static extension $extension did not produce exported C symbols or an init hook"
      fi
      printf 'extern const void *%s_Pg_magic_func(void);\n' "$prefix"
      if module_has_c_symbol "$stem" "${prefix}__PG_init"; then
        printf 'extern void %s__PG_init(void);\n' "$prefix"
      fi
      while IFS= read -r symbol; do
        printf 'extern void %s(void);\n' "$symbol"
      done < "$symbols_file"
      if [ -s "$alias_file" ]; then
        while IFS=$'\t' read -r _ linked_symbol; do
          [ -n "$linked_symbol" ] || continue
          printf 'extern void %s(void);\n' "$linked_symbol"
        done < "$alias_file"
      fi
      printf '\n'
    done

    for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
      stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
      prefix="$(oliphaunt_static_symbol_prefix "$stem")"
      symbols_file="$out_dir/extensions/$stem/symbols.list"
      alias_file="$out_dir/extensions/$stem/symbol-aliases.list"
      [ -s "$symbols_file" ] || [ -s "$alias_file" ] || continue
      printf 'static const OliphauntStaticExtensionSymbol %s_symbols[] = {\n' "$prefix"
      while IFS= read -r symbol; do
        printf '    { .name = "%s", .address = (void *)%s },\n' "$symbol" "$symbol"
      done < "$symbols_file"
      if [ -s "$alias_file" ]; then
        while IFS=$'\t' read -r sql_symbol linked_symbol; do
          [ -n "$sql_symbol" ] || continue
          [ -n "$linked_symbol" ] || continue
          printf '    { .name = "%s", .address = (void *)%s },\n' "$sql_symbol" "$linked_symbol"
        done < "$alias_file"
      fi
      printf '};\n\n'
    done

    printf 'static const OliphauntStaticExtension liboliphaunt_static_extensions[] = {\n'
    for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
      stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
      prefix="$(oliphaunt_static_symbol_prefix "$stem")"
      symbols_file="$out_dir/extensions/$stem/symbols.list"
      alias_file="$out_dir/extensions/$stem/symbol-aliases.list"
      init_symbol="NULL"
      if module_has_c_symbol "$stem" "${prefix}__PG_init"; then
        init_symbol="${prefix}__PG_init"
      fi
      symbols_expr="NULL"
      symbol_count_expr="0"
      if [ -s "$symbols_file" ] || [ -s "$alias_file" ]; then
        symbols_expr="${prefix}_symbols"
        symbol_count_expr="sizeof(${prefix}_symbols) / sizeof(${prefix}_symbols[0])"
      fi
      cat <<ENTRY
    {
        .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,
        .name = "$stem",
        .magic = ${prefix}_Pg_magic_func,
        .init = $init_symbol,
        .symbols = $symbols_expr,
        .symbol_count = $symbol_count_expr,
        .reserved_flags = 0,
    },
ENTRY
    done
    cat <<'FOOTER'
};

const OliphauntStaticExtension *liboliphaunt_selected_static_extensions(size_t *count) {
    if (count != NULL) {
        *count = sizeof(liboliphaunt_static_extensions) / sizeof(liboliphaunt_static_extensions[0]);
    }
    return liboliphaunt_static_extensions;
}
FOOTER
  } > "$mobile_static_registry_source"
}

build_mobile_static_registry_object() {
  [ "${#mobile_static_extensions[@]}" -gt 0 ] || return 0
  "${cc[@]}" $native_cflags \
    -I"$repo_root/src/runtimes/liboliphaunt/native/include" \
    -c "$mobile_static_registry_source" \
    -o "$mobile_static_registry_object"
  mobile_static_objects+=("$mobile_static_registry_object")
}

write_objects_response_file() {
  (
    cd "$build_dir"
    {
      cat src/backend/*/objfiles.txt
      printf '%s\n' "${jit_objects[@]}"
      printf 'src/timezone/localtime.o src/timezone/pgtz.o src/timezone/strftime.o\n'
      printf '%s\n' "${plpgsql_objects[@]}"
    } | tr '[:space:]' '\n' | sed '/^$/d' | awk '!seen[$0]++' > "$objects_rsp"
  )
}

link_liboliphaunt() {
  local -a postgis_link_args
  local link_arg
  while IFS= read -r link_arg; do
    [ -n "$link_arg" ] && postgis_link_args+=("$link_arg")
  done < <(oliphaunt_postgis_extra_link_args)
  (
    cd "$build_dir"
    set +u
    "${cxx[@]}" -shared \
      -Wl,-soname,liboliphaunt.so \
      -Wl,-z,defs \
      -Wl,-z,max-page-size=16384 \
      -o "$lib_out" \
      "${liboliphaunt_objects[@]}" \
      "${mobile_static_objects[@]}" \
      "${mobile_static_dependency_archives[@]}" \
      @"$objects_rsp" \
      src/common/libpgcommon_srv.a \
      src/port/libpgport_srv.a \
      $icu_libs \
      "${postgis_link_args[@]}" \
      -lm \
      -ldl
    set -u
  )
}

usage() {
  cat >&2 <<'MSG'
usage: src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh [--check-current]

Environment:
  OLIPHAUNT_ANDROID_ABI=arm64-v8a|x86_64
MSG
}

parse_mobile_static_extensions

case "$script_mode" in
  build)
    prepare_source
    build_icu
    configure_source
    if artifact_ready && (cd "$build_dir" && backend_objects_ready && plpgsql_objects_ready && jit_objects_ready) && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(desired_hash)" ]; then
      echo "$lib_out"
      exit 0
    fi
    build_backend_objects
    build_jit_objects
    build_timezone_objects
    build_plpgsql_objects
    build_liboliphaunt_objects
    build_mobile_static_dependencies
    build_mobile_static_extension_objects
    write_mobile_static_registry_source
    build_mobile_static_registry_object
    write_objects_response_file
    link_liboliphaunt
    if ! artifact_ready; then
      report_artifact_not_ready
      exit 1
    fi
    desired_hash > "$stamp"
    echo "$lib_out"
    ;;
  --check-current)
    if artifact_ready && (cd "$build_dir" && backend_objects_ready && plpgsql_objects_ready && jit_objects_ready) && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(desired_hash)" ]; then
      echo "Android $android_abi liboliphaunt shared library is current"
      exit 0
    fi
    report_artifact_not_ready
    echo "Android $android_abi liboliphaunt shared library is missing or stale" >&2
    exit 1
    ;;
  *)
    usage
    exit 2
    ;;
esac
