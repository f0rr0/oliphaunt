#!/usr/bin/env sh

# Shared runtime prerequisite checks for runtime/smoke lanes. This file is
# intentionally POSIX-sh compatible because product SDK checks source it from
# both bash and sh scripts.

oliphaunt_runtime_repo_root() {
  oliphaunt_runtime_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$oliphaunt_runtime_root" ]; then
    printf '%s\n' "$oliphaunt_runtime_root"
    return 0
  fi
  if [ -n "${OLIPHAUNT_WORKSPACE_ROOT:-}" ] &&
    [ -f "$OLIPHAUNT_WORKSPACE_ROOT/package.json" ] &&
    [ -d "$OLIPHAUNT_WORKSPACE_ROOT/src" ]; then
    (cd "$OLIPHAUNT_WORKSPACE_ROOT" && pwd -P)
    return 0
  fi
  if [ -f package.json ] && [ -d src ]; then
    pwd -P
    return 0
  fi
  echo "must run inside the Oliphaunt workspace" >&2
  return 1
}

oliphaunt_runtime_host_library_name() {
  case "$(uname -s)" in
    Darwin) printf '%s\n' liboliphaunt.dylib ;;
    MINGW* | MSYS* | CYGWIN*) printf '%s\n' oliphaunt.dll ;;
    *) printf '%s\n' liboliphaunt.so ;;
  esac
}

oliphaunt_runtime_host_library_suffix() {
  case "$(uname -s)" in
    Darwin) printf '%s\n' dylib ;;
    MINGW* | MSYS* | CYGWIN*) printf '%s\n' dll ;;
    *) printf '%s\n' so ;;
  esac
}

oliphaunt_runtime_native_host_target_id() {
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64) printf '%s\n' macos-arm64 ;;
    Darwin:x86_64) printf '%s\n' macos-x64 ;;
    Linux:x86_64 | Linux:amd64) printf '%s\n' linux-x64-gnu ;;
    Linux:aarch64 | Linux:arm64) printf '%s\n' linux-arm64-gnu ;;
    MINGW*:x86_64 | MSYS*:x86_64 | CYGWIN*:x86_64) printf '%s\n' windows-x64-msvc ;;
    *)
      echo "unsupported native host target: $(uname -s)/$(uname -m)" >&2
      return 2
      ;;
  esac
}

oliphaunt_runtime_native_host_work_root() {
  if [ -n "${OLIPHAUNT_WORK_ROOT:-}" ]; then
    printf '%s\n' "$OLIPHAUNT_WORK_ROOT"
    return
  fi

  case "$(uname -s)" in
    Darwin)
      printf '%s\n' "$(oliphaunt_runtime_repo_root)/target/liboliphaunt-pg18"
      ;;
    Linux)
      printf '%s\n' "$(oliphaunt_runtime_repo_root)/target/liboliphaunt-pg18-$(oliphaunt_runtime_native_host_target_id)"
      ;;
    MINGW* | MSYS* | CYGWIN*)
      printf '%s\n' "$(oliphaunt_runtime_repo_root)/target/liboliphaunt-pg18-windows-x64-msvc"
      ;;
    *)
      printf '%s\n' "$(oliphaunt_runtime_repo_root)/target/liboliphaunt-pg18"
      ;;
  esac
}

oliphaunt_runtime_native_host_default_lib() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      printf '%s/out/bin/%s\n' "$(oliphaunt_runtime_native_host_work_root)" "$(oliphaunt_runtime_host_library_name)"
      ;;
    *)
      printf '%s/out/%s\n' "$(oliphaunt_runtime_native_host_work_root)" "$(oliphaunt_runtime_host_library_name)"
      ;;
  esac
}

oliphaunt_runtime_native_host_default_install_dir() {
  printf '%s/install\n' "$(oliphaunt_runtime_native_host_work_root)"
}

oliphaunt_runtime_native_host_default_initdb() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) printf '%s/bin/initdb.exe\n' "$(oliphaunt_runtime_native_host_default_install_dir)" ;;
    *) printf '%s/bin/initdb\n' "$(oliphaunt_runtime_native_host_default_install_dir)" ;;
  esac
}

oliphaunt_runtime_native_host_default_postgres() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) printf '%s/bin/postgres.exe\n' "$(oliphaunt_runtime_native_host_default_install_dir)" ;;
    *) printf '%s/bin/postgres\n' "$(oliphaunt_runtime_native_host_default_install_dir)" ;;
  esac
}

oliphaunt_runtime_native_host_default_pg_config() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) printf '%s/bin/pg_config.exe\n' "$(oliphaunt_runtime_native_host_default_install_dir)" ;;
    *) printf '%s/bin/pg_config\n' "$(oliphaunt_runtime_native_host_default_install_dir)" ;;
  esac
}

oliphaunt_runtime_native_host_lib() {
  printf '%s\n' "${LIBOLIPHAUNT_PATH:-$(oliphaunt_runtime_native_host_default_lib)}"
}

oliphaunt_runtime_native_host_install_dir() {
  printf '%s\n' "${OLIPHAUNT_INSTALL_DIR:-$(oliphaunt_runtime_native_host_default_install_dir)}"
}

oliphaunt_runtime_native_host_initdb() {
  printf '%s\n' "${OLIPHAUNT_INITDB:-$(oliphaunt_runtime_native_host_default_initdb)}"
}

oliphaunt_runtime_native_host_postgres() {
  printf '%s\n' "${OLIPHAUNT_POSTGRES:-$(oliphaunt_runtime_native_host_default_postgres)}"
}

oliphaunt_runtime_native_host_pg_config() {
  printf '%s\n' "${OLIPHAUNT_PG_CONFIG:-$(oliphaunt_runtime_native_host_default_pg_config)}"
}

oliphaunt_runtime_native_host_export_defaults() {
  oliphaunt_runtime_default_lib="$(oliphaunt_runtime_native_host_default_lib)"
  oliphaunt_runtime_default_install="$(oliphaunt_runtime_native_host_default_install_dir)"
  oliphaunt_runtime_default_initdb="$(oliphaunt_runtime_native_host_default_initdb)"
  oliphaunt_runtime_default_postgres="$(oliphaunt_runtime_native_host_default_postgres)"
  oliphaunt_runtime_default_pg_config="$(oliphaunt_runtime_native_host_default_pg_config)"
  oliphaunt_runtime_default_broker="$(oliphaunt_runtime_repo_root)/target/debug/oliphaunt-broker"

  if [ -z "${LIBOLIPHAUNT_PATH:-}" ] && [ -f "$oliphaunt_runtime_default_lib" ]; then
    export LIBOLIPHAUNT_PATH="$oliphaunt_runtime_default_lib"
  fi
  if [ -z "${OLIPHAUNT_INSTALL_DIR:-}" ] && [ -d "$oliphaunt_runtime_default_install" ]; then
    export OLIPHAUNT_INSTALL_DIR="$oliphaunt_runtime_default_install"
  fi
  if [ -z "${OLIPHAUNT_INITDB:-}" ] && [ -x "$oliphaunt_runtime_default_initdb" ]; then
    export OLIPHAUNT_INITDB="$oliphaunt_runtime_default_initdb"
  fi
  if [ -z "${OLIPHAUNT_POSTGRES:-}" ] && [ -x "$oliphaunt_runtime_default_postgres" ]; then
    export OLIPHAUNT_POSTGRES="$oliphaunt_runtime_default_postgres"
  fi
  if [ -z "${OLIPHAUNT_PG_CONFIG:-}" ] && [ -x "$oliphaunt_runtime_default_pg_config" ]; then
    export OLIPHAUNT_PG_CONFIG="$oliphaunt_runtime_default_pg_config"
  fi
  if [ -z "${OLIPHAUNT_POSTGRES_TOOL_DIR:-}" ] && [ -x "$oliphaunt_runtime_default_postgres" ]; then
    export OLIPHAUNT_POSTGRES_TOOL_DIR="$oliphaunt_runtime_default_install/bin"
  fi
  if [ -z "${OLIPHAUNT_BROKER:-}" ] && [ -x "$oliphaunt_runtime_default_broker" ]; then
    export OLIPHAUNT_BROKER="$oliphaunt_runtime_default_broker"
  fi
}

oliphaunt_runtime_native_host_base_ready() {
  [ -f "$(oliphaunt_runtime_native_host_lib)" ] &&
    [ -d "$(oliphaunt_runtime_native_host_install_dir)" ] &&
    [ -x "$(oliphaunt_runtime_native_host_initdb)" ] &&
    [ -x "$(oliphaunt_runtime_native_host_postgres)" ] &&
    [ -x "$(oliphaunt_runtime_native_host_pg_config)" ]
}

oliphaunt_runtime_native_host_has_icu() {
  oliphaunt_runtime_pg_config="$(oliphaunt_runtime_native_host_pg_config)"
  oliphaunt_runtime_install_dir="$(oliphaunt_runtime_native_host_install_dir)"
  [ -x "$oliphaunt_runtime_pg_config" ] || return 1
  case "$("$oliphaunt_runtime_pg_config" --configure 2>/dev/null || true)" in
    *"--with-icu"*) ;;
    *) return 1 ;;
  esac
  [ -f "$oliphaunt_runtime_install_dir/include/pg_config.h" ] || return 1
  grep -Eq '^#define USE_ICU 1\b' "$oliphaunt_runtime_install_dir/include/pg_config.h"
}

oliphaunt_runtime_native_host_can_initdb() {
  oliphaunt_runtime_initdb="$(oliphaunt_runtime_native_host_initdb)"
  [ -x "$oliphaunt_runtime_initdb" ] || return 1

  oliphaunt_runtime_probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-runtime-initdb.XXXXXX")"
  if "$oliphaunt_runtime_initdb" -D "$oliphaunt_runtime_probe_dir/pgdata" --no-sync >/dev/null 2>&1; then
    oliphaunt_runtime_initdb_status=0
  else
    oliphaunt_runtime_initdb_status="$?"
  fi
  rm -rf "$oliphaunt_runtime_probe_dir"
  return "$oliphaunt_runtime_initdb_status"
}

oliphaunt_runtime_native_extension_inventory() {
  oliphaunt_runtime_inventory_script="$(oliphaunt_runtime_repo_root)/src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh"
  [ -x "$oliphaunt_runtime_inventory_script" ] || return 1
  "$oliphaunt_runtime_inventory_script" --print-required-extension-artifacts
}

oliphaunt_runtime_extension_sql_file_exists() {
  for oliphaunt_runtime_sql_path in "$1/$2"--*.sql; do
    [ -f "$oliphaunt_runtime_sql_path" ] && return 0
  done
  return 1
}

oliphaunt_runtime_native_host_extensions_ready() {
  oliphaunt_runtime_verbose="${1:-0}"
  oliphaunt_runtime_install_dir="$(oliphaunt_runtime_native_host_install_dir)"
  oliphaunt_runtime_lib="$(oliphaunt_runtime_native_host_lib)"
  oliphaunt_runtime_out_dir="$(dirname "$oliphaunt_runtime_lib")"
  oliphaunt_runtime_extension_dir="$oliphaunt_runtime_install_dir/share/postgresql/extension"
  oliphaunt_runtime_normal_module_dir="$oliphaunt_runtime_install_dir/lib/postgresql"
  oliphaunt_runtime_embedded_module_dir="$oliphaunt_runtime_out_dir/modules"
  oliphaunt_runtime_module_suffix="$(oliphaunt_runtime_host_library_suffix)"
  oliphaunt_runtime_ok=1

  if ! oliphaunt_runtime_inventory="$(oliphaunt_runtime_native_extension_inventory 2>/dev/null)"; then
    [ "$oliphaunt_runtime_verbose" -eq 0 ] ||
      echo "could not read native extension artifact inventory from liboliphaunt build script" >&2
    return 1
  fi

  while IFS=: read -r oliphaunt_runtime_kind oliphaunt_runtime_name; do
    [ -n "$oliphaunt_runtime_kind" ] || continue
    case "$oliphaunt_runtime_kind" in
      control)
        if [ ! -f "$oliphaunt_runtime_extension_dir/$oliphaunt_runtime_name.control" ]; then
          [ "$oliphaunt_runtime_verbose" -eq 0 ] ||
            echo "missing native extension control: $oliphaunt_runtime_extension_dir/$oliphaunt_runtime_name.control" >&2
          oliphaunt_runtime_ok=0
        fi
        if ! oliphaunt_runtime_extension_sql_file_exists "$oliphaunt_runtime_extension_dir" "$oliphaunt_runtime_name"; then
          [ "$oliphaunt_runtime_verbose" -eq 0 ] ||
            echo "missing native extension SQL: $oliphaunt_runtime_extension_dir/$oliphaunt_runtime_name--*.sql" >&2
          oliphaunt_runtime_ok=0
        fi
        ;;
      module)
        if [ ! -f "$oliphaunt_runtime_normal_module_dir/$oliphaunt_runtime_name.$oliphaunt_runtime_module_suffix" ]; then
          [ "$oliphaunt_runtime_verbose" -eq 0 ] ||
            echo "missing native extension PostgreSQL module: $oliphaunt_runtime_normal_module_dir/$oliphaunt_runtime_name.$oliphaunt_runtime_module_suffix" >&2
          oliphaunt_runtime_ok=0
        fi
        if [ ! -f "$oliphaunt_runtime_embedded_module_dir/$oliphaunt_runtime_name.$oliphaunt_runtime_module_suffix" ]; then
          [ "$oliphaunt_runtime_verbose" -eq 0 ] ||
            echo "missing native extension embedded module: $oliphaunt_runtime_embedded_module_dir/$oliphaunt_runtime_name.$oliphaunt_runtime_module_suffix" >&2
          oliphaunt_runtime_ok=0
        fi
        ;;
      *)
        [ "$oliphaunt_runtime_verbose" -eq 0 ] ||
          echo "unknown native extension artifact inventory row: $oliphaunt_runtime_kind:$oliphaunt_runtime_name" >&2
        oliphaunt_runtime_ok=0
        ;;
    esac
  done <<EOF
$oliphaunt_runtime_inventory
EOF

  [ "$oliphaunt_runtime_ok" -eq 1 ]
}

oliphaunt_runtime_native_host_ready() {
  oliphaunt_runtime_profile="${1:-basic}"
  oliphaunt_runtime_native_host_export_defaults
  oliphaunt_runtime_native_host_base_ready &&
    oliphaunt_runtime_native_host_has_icu &&
    oliphaunt_runtime_native_host_can_initdb || return 1

  case "$oliphaunt_runtime_profile" in
    basic)
      return 0
      ;;
    extensions|full)
      oliphaunt_runtime_native_host_extensions_ready 0
      ;;
    *)
      echo "unknown native runtime profile: $oliphaunt_runtime_profile" >&2
      return 2
      ;;
  esac
}

oliphaunt_runtime_native_host_diagnostics() {
  oliphaunt_runtime_profile="${1:-basic}"
  oliphaunt_runtime_native_host_export_defaults

  if ! oliphaunt_runtime_native_host_base_ready; then
    cat >&2 <<MSG
missing native Oliphaunt runtime artifacts.

Expected:
  LIBOLIPHAUNT_PATH=$(oliphaunt_runtime_native_host_lib)
  OLIPHAUNT_INITDB=$(oliphaunt_runtime_native_host_initdb)
  OLIPHAUNT_POSTGRES=$(oliphaunt_runtime_native_host_postgres)
  OLIPHAUNT_INSTALL_DIR=$(oliphaunt_runtime_native_host_install_dir)
  OLIPHAUNT_PG_CONFIG=$(oliphaunt_runtime_native_host_pg_config)
MSG
  fi
  if oliphaunt_runtime_native_host_base_ready && ! oliphaunt_runtime_native_host_has_icu; then
    cat >&2 <<MSG
native Oliphaunt runtime is incomplete: PostgreSQL was not built with ICU.

Rebuild with:

  cargo run -p xtask -- assets fetch
  src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh

Detected:
  OLIPHAUNT_PG_CONFIG=$(oliphaunt_runtime_native_host_pg_config)
MSG
  fi
  if oliphaunt_runtime_native_host_base_ready &&
    oliphaunt_runtime_native_host_has_icu &&
    ! oliphaunt_runtime_native_host_can_initdb; then
    cat >&2 <<MSG
native Oliphaunt runtime is incomplete: initdb cannot initialize a cluster.

Rebuild with:

  cargo run -p xtask -- assets fetch
  src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh

Detected:
  OLIPHAUNT_INITDB=$(oliphaunt_runtime_native_host_initdb)
MSG
  fi
  case "$oliphaunt_runtime_profile" in
    extensions|full)
      if oliphaunt_runtime_native_host_base_ready && ! oliphaunt_runtime_native_host_extensions_ready 0; then
        cat >&2 <<MSG
native Oliphaunt runtime is incomplete: extension artifacts are missing.

Expected:
  OLIPHAUNT_INSTALL_DIR=$(oliphaunt_runtime_native_host_install_dir)
  embedded modules directory=$(dirname "$(oliphaunt_runtime_native_host_lib)")/modules
MSG
        oliphaunt_runtime_native_host_extensions_ready 1 || true
      fi
      ;;
  esac
}

oliphaunt_runtime_native_host_require() {
  oliphaunt_runtime_profile="${1:-basic}"
  if ! oliphaunt_runtime_native_host_ready "$oliphaunt_runtime_profile"; then
    oliphaunt_runtime_native_host_diagnostics "$oliphaunt_runtime_profile"
    return 1
  fi
}

oliphaunt_runtime_android_arm64_require() {
  oliphaunt_runtime_android_script="$(oliphaunt_runtime_repo_root)/src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh"
  [ -x "$oliphaunt_runtime_android_script" ] || {
    echo "missing Android liboliphaunt build/check script: $oliphaunt_runtime_android_script" >&2
    return 1
  }
  "$oliphaunt_runtime_android_script" --check-current
}

oliphaunt_runtime_ios_simulator_require() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "iOS simulator runtime preflight requires Darwin" >&2
    return 2
  fi
  oliphaunt_runtime_ios_script="$(oliphaunt_runtime_repo_root)/src/runtimes/liboliphaunt/native/bin/check-postgres18-ios-simulator.sh"
  [ -x "$oliphaunt_runtime_ios_script" ] || {
    echo "missing iOS simulator liboliphaunt check script: $oliphaunt_runtime_ios_script" >&2
    return 1
  }
  "$oliphaunt_runtime_ios_script"
}

oliphaunt_runtime_wasm_host_triple() {
  rustc -vV | awk '/^host:/{print $2}'
}

oliphaunt_runtime_wasm_asset_mode() {
  python3 - <<'PY'
import json
from pathlib import Path

manifest = json.loads(Path("target/oliphaunt-wasix/assets/manifest.json").read_text())
has_extensions = bool(manifest.get("extensions"))
has_pg_dump = bool(manifest.get("pg-dump"))
print("full" if has_extensions and has_pg_dump else "core")
PY
}

oliphaunt_runtime_wasm_require() {
  oliphaunt_runtime_mode="${1:-smoke}"
  oliphaunt_runtime_host="$(oliphaunt_runtime_wasm_host_triple)"
  if [ ! -f "target/oliphaunt-wasix/assets/manifest.json" ]; then
    echo "missing generated portable WASIX assets at target/oliphaunt-wasix/assets" >&2
    return 1
  fi
  if [ ! -f "target/oliphaunt-wasix/aot/$oliphaunt_runtime_host/manifest.json" ] &&
    [ ! -f "src/runtimes/liboliphaunt/wasix/crates/aot/$oliphaunt_runtime_host/artifacts/manifest.json" ]; then
    echo "missing host WASIX AOT artifacts for $oliphaunt_runtime_host" >&2
    return 1
  fi

  oliphaunt_runtime_asset_mode="$(oliphaunt_runtime_wasm_asset_mode)"
  if [ "$oliphaunt_runtime_asset_mode" = "core" ]; then
    if [ "$oliphaunt_runtime_mode" = "regression" ]; then
      echo "full WASIX assets are required for liboliphaunt-wasix:regression; core-only assets would skip extension and pg_dump evidence" >&2
      return 1
    fi
    export OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1
  fi
  export OLIPHAUNT_RUNTIME_WASM_ASSET_MODE="$oliphaunt_runtime_asset_mode"
}

oliphaunt_runtime_preflight_main() {
  oliphaunt_runtime_target="${1:-}"
  shift || true
  case "$oliphaunt_runtime_target" in
    native-host)
      oliphaunt_runtime_action="check"
      oliphaunt_runtime_profile="basic"
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --check) oliphaunt_runtime_action="check" ;;
          --require) oliphaunt_runtime_action="require" ;;
          --diagnose) oliphaunt_runtime_action="diagnose" ;;
          --print-env) oliphaunt_runtime_action="print-env" ;;
          --extensions|--full) oliphaunt_runtime_profile="extensions" ;;
          *)
            echo "usage: tools/runtime/preflight.sh native-host [--check|--require|--diagnose|--print-env] [--extensions]" >&2
            return 2
            ;;
        esac
        shift
      done
      case "$oliphaunt_runtime_action" in
        check)
          oliphaunt_runtime_native_host_ready "$oliphaunt_runtime_profile"
          ;;
        require)
          oliphaunt_runtime_native_host_require "$oliphaunt_runtime_profile"
          ;;
        diagnose)
          oliphaunt_runtime_native_host_diagnostics "$oliphaunt_runtime_profile"
          ;;
        print-env)
          oliphaunt_runtime_native_host_export_defaults
          printf 'LIBOLIPHAUNT_PATH=%s\n' "$(oliphaunt_runtime_native_host_lib)"
          printf 'OLIPHAUNT_INSTALL_DIR=%s\n' "$(oliphaunt_runtime_native_host_install_dir)"
          printf 'OLIPHAUNT_INITDB=%s\n' "$(oliphaunt_runtime_native_host_initdb)"
          printf 'OLIPHAUNT_POSTGRES=%s\n' "$(oliphaunt_runtime_native_host_postgres)"
          printf 'OLIPHAUNT_PG_CONFIG=%s\n' "$(oliphaunt_runtime_native_host_pg_config)"
          ;;
      esac
      ;;
    android-arm64)
      oliphaunt_runtime_android_arm64_require
      ;;
    ios-simulator)
      oliphaunt_runtime_ios_simulator_require
      ;;
    wasm)
      oliphaunt_runtime_mode="smoke"
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --mode)
            shift
            oliphaunt_runtime_mode="${1:-}"
            ;;
          smoke|regression)
            oliphaunt_runtime_mode="$1"
            ;;
          *)
            echo "usage: tools/runtime/preflight.sh wasm [--mode smoke|regression]" >&2
            return 2
            ;;
        esac
        shift
      done
      case "$oliphaunt_runtime_mode" in
        smoke|regression) ;;
        *)
          echo "usage: tools/runtime/preflight.sh wasm [--mode smoke|regression]" >&2
          return 2
          ;;
      esac
      oliphaunt_runtime_wasm_require "$oliphaunt_runtime_mode"
      ;;
    *)
      cat >&2 <<'MSG'
usage:
  tools/runtime/preflight.sh native-host [--check|--require|--diagnose|--print-env] [--extensions]
  tools/runtime/preflight.sh android-arm64
  tools/runtime/preflight.sh ios-simulator
  tools/runtime/preflight.sh wasm [--mode smoke|regression]
MSG
      return 2
      ;;
  esac
}

if [ "$(basename "$0")" = "preflight.sh" ]; then
  oliphaunt_runtime_preflight_main "$@"
fi
