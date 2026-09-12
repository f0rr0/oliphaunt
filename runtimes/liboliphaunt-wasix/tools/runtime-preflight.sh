#!/usr/bin/env sh

oliphaunt_runtime_wasm_host_triple() {
  rustc -vV | awk '/^host:/{print $2}'
}

oliphaunt_runtime_wasm_require() {
  oliphaunt_runtime_mode="${1:-smoke}"
  oliphaunt_runtime_host="$(oliphaunt_runtime_wasm_host_triple)"
  [ -f "target/oliphaunt-wasix/assets/manifest.json" ] || {
    echo "missing generated portable WASIX assets at target/oliphaunt-wasix/assets" >&2
    return 1
  }
  [ -f "target/oliphaunt-wasix/aot/$oliphaunt_runtime_host/manifest.json" ] ||
    [ -f "runtimes/liboliphaunt-wasix/crates/aot/$oliphaunt_runtime_host/artifacts/manifest.json" ] || {
    echo "missing host WASIX AOT artifacts for $oliphaunt_runtime_host" >&2
    return 1
  }
}
