#!/usr/bin/env bash
set -euo pipefail

is_absolute_path() {
  case "$1" in
    /*|[A-Za-z]:/*|[A-Za-z]:\\*|\\\\*) return 0 ;;
    *) return 1 ;;
  esac
}

test_absolute_path_classifier() {
  local candidate
  for candidate in \
    "/tmp/oliphaunt.node" \
    "D:/oliphaunt.node" \
    'D:\oliphaunt.node' \
    "//server/share/oliphaunt.node" \
    '\\server\share\oliphaunt.node' \
    '\\?\D:\oliphaunt.node'; do
    if ! is_absolute_path "$candidate"; then
      echo "absolute cleanup lifecycle path was misclassified: $candidate" >&2
      return 1
    fi
  done
  for candidate in \
    "relative/oliphaunt.node" \
    "./oliphaunt.node" \
    "../oliphaunt.node" \
    "D:relative.node"; do
    if is_absolute_path "$candidate"; then
      echo "relative cleanup lifecycle path was misclassified: $candidate" >&2
      return 1
    fi
  done
}

if [[ "${1:-}" == "--test-path-classifier" ]]; then
  test_absolute_path_classifier
  echo "Node cleanup lifecycle path classifier passed"
  exit 0
fi

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

addon="${1:-${OLIPHAUNT_NODE_ADDON_UNDER_TEST:-}}"
if [[ -z "$addon" ]]; then
  echo "usage: $0 <compiled-oliphaunt_node.node>" >&2
  exit 2
fi
if ! is_absolute_path "$addon"; then
  addon="$root/$addon"
fi
if [[ ! -f "$addon" ]]; then
  echo "compiled Node direct addon does not exist: $addon" >&2
  exit 2
fi

case "$(uname -s)" in
  Darwin)
    platform="macos"
    library_name="libfake_oliphaunt.dylib"
    ;;
  Linux)
    platform="linux"
    library_name="libfake_oliphaunt.so"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    platform="windows"
    library_name="fake_oliphaunt.dll"
    ;;
  *)
    echo "unsupported Node cleanup lifecycle platform: $(uname -s)" >&2
    exit 2
    ;;
esac

out_root="${OLIPHAUNT_NODE_CLEANUP_TEST_OUT_DIR:-$root/target/oliphaunt-node-direct/cleanup-lifecycle/$platform}"
if ! is_absolute_path "$out_root"; then
  out_root="$root/$out_root"
fi
rm -rf "$out_root"
mkdir -p "$out_root"

source_path="$root/src/runtimes/node-direct/native/node-addon/fixtures/fake_liboliphaunt.cc"
include_path="$root/src/runtimes/liboliphaunt/native/include"
library_path="$out_root/$library_name"
cxx="${CXX:-c++}"

case "$platform" in
  macos)
    "$cxx" \
      -std=c++17 \
      -O2 \
      -fPIC \
      -dynamiclib \
      -DOLIPHAUNT_BUILDING_DLL \
      "-I$include_path" \
      "$source_path" \
      -o "$library_path"
    ;;
  linux)
    "$cxx" \
      -std=c++17 \
      -O2 \
      -fPIC \
      -shared \
      -DOLIPHAUNT_BUILDING_DLL \
      "-I$include_path" \
      "$source_path" \
      -o "$library_path"
    ;;
  windows)
    cxx="${CXX:-cl}"
    object_path="$out_root/fake_liboliphaunt.obj"
    import_library_path="$out_root/fake_liboliphaunt.lib"
    if command -v cygpath >/dev/null 2>&1; then
      source_path="$(cygpath -w "$source_path")"
      include_path="$(cygpath -w "$include_path")"
      library_path="$(cygpath -w "$library_path")"
      object_path="$(cygpath -w "$object_path")"
      import_library_path="$(cygpath -w "$import_library_path")"
      addon="$(cygpath -w "$addon")"
    fi
    "$cxx" \
      //nologo \
      //std:c++17 \
      //O2 \
      //EHsc \
      //LD \
      //DOLIPHAUNT_BUILDING_DLL \
      "-I$include_path" \
      "$source_path" \
      //Fo:"$object_path" \
      //link \
      //OUT:"$library_path" \
      //IMPLIB:"$import_library_path"
    ;;
esac

node \
  src/runtimes/node-direct/tools/node-addon-cleanup-lifecycle.test.mjs \
  --addon "$addon" \
  --library "$library_path"
