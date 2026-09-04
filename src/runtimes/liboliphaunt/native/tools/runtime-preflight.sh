#!/usr/bin/env sh

# Resolve the native artifact produced by liboliphaunt-native. Consumers source
# this file; behavioral qualification belongs to their smoke tests.

oliphaunt_runtime_repo_root() {
  git rev-parse --show-toplevel
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
    Darwin) printf '%s/target/liboliphaunt-pg18\n' "$(oliphaunt_runtime_repo_root)" ;;
    Linux) printf '%s/target/liboliphaunt-pg18-%s\n' "$(oliphaunt_runtime_repo_root)" "$(oliphaunt_runtime_native_host_target_id)" ;;
    MINGW* | MSYS* | CYGWIN*) printf '%s/target/liboliphaunt-pg18-windows-x64-msvc\n' "$(oliphaunt_runtime_repo_root)" ;;
    *) return 2 ;;
  esac
}

oliphaunt_runtime_native_host_install_dir() {
  printf '%s\n' "${OLIPHAUNT_INSTALL_DIR:-$(oliphaunt_runtime_native_host_work_root)/install}"
}

oliphaunt_runtime_native_host_lib() {
  if [ -n "${LIBOLIPHAUNT_PATH:-}" ]; then
    printf '%s\n' "$LIBOLIPHAUNT_PATH"
    return
  fi
  case "$(uname -s)" in
    Darwin) printf '%s/out/liboliphaunt.dylib\n' "$(oliphaunt_runtime_native_host_work_root)" ;;
    MINGW* | MSYS* | CYGWIN*) printf '%s/out/bin/oliphaunt.dll\n' "$(oliphaunt_runtime_native_host_work_root)" ;;
    *) printf '%s/out/liboliphaunt.so\n' "$(oliphaunt_runtime_native_host_work_root)" ;;
  esac
}

oliphaunt_runtime_native_host_initdb() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) suffix=.exe ;;
    *) suffix= ;;
  esac
  printf '%s\n' "${OLIPHAUNT_INITDB:-$(oliphaunt_runtime_native_host_install_dir)/bin/initdb$suffix}"
}

oliphaunt_runtime_native_host_postgres() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) suffix=.exe ;;
    *) suffix= ;;
  esac
  printf '%s\n' "${OLIPHAUNT_POSTGRES:-$(oliphaunt_runtime_native_host_install_dir)/bin/postgres$suffix}"
}

oliphaunt_runtime_native_host_pg_config() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) suffix=.exe ;;
    *) suffix= ;;
  esac
  printf '%s\n' "${OLIPHAUNT_PG_CONFIG:-$(oliphaunt_runtime_native_host_install_dir)/bin/pg_config$suffix}"
}

oliphaunt_runtime_native_host_export_defaults() {
  LIBOLIPHAUNT_PATH="$(oliphaunt_runtime_native_host_lib)"
  OLIPHAUNT_INSTALL_DIR="$(oliphaunt_runtime_native_host_install_dir)"
  OLIPHAUNT_INITDB="$(oliphaunt_runtime_native_host_initdb)"
  OLIPHAUNT_POSTGRES="$(oliphaunt_runtime_native_host_postgres)"
  OLIPHAUNT_PG_CONFIG="$(oliphaunt_runtime_native_host_pg_config)"
  OLIPHAUNT_POSTGRES_TOOL_DIR="${OLIPHAUNT_POSTGRES_TOOL_DIR:-$OLIPHAUNT_INSTALL_DIR/bin}"
  export LIBOLIPHAUNT_PATH OLIPHAUNT_INSTALL_DIR OLIPHAUNT_INITDB
  export OLIPHAUNT_POSTGRES OLIPHAUNT_PG_CONFIG OLIPHAUNT_POSTGRES_TOOL_DIR
}

oliphaunt_runtime_native_host_require() {
  case "${1:-basic}" in
    basic | extensions | full) ;;
    *) echo "unknown native runtime profile: $1" >&2; return 2 ;;
  esac
  oliphaunt_runtime_native_host_export_defaults
  [ -f "$LIBOLIPHAUNT_PATH" ] &&
    [ -d "$OLIPHAUNT_INSTALL_DIR" ] &&
    [ -x "$OLIPHAUNT_INITDB" ] &&
    [ -x "$OLIPHAUNT_POSTGRES" ] &&
    [ -x "$OLIPHAUNT_PG_CONFIG" ] && return 0

  cat >&2 <<MSG
missing native Oliphaunt runtime artifacts:
  LIBOLIPHAUNT_PATH=$LIBOLIPHAUNT_PATH
  OLIPHAUNT_INSTALL_DIR=$OLIPHAUNT_INSTALL_DIR
  OLIPHAUNT_INITDB=$OLIPHAUNT_INITDB
  OLIPHAUNT_POSTGRES=$OLIPHAUNT_POSTGRES
  OLIPHAUNT_PG_CONFIG=$OLIPHAUNT_PG_CONFIG
MSG
  return 1
}
