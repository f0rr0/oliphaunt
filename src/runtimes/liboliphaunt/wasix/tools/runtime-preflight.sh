#!/usr/bin/env sh

oliphaunt_runtime_wasm_host_triple() {
  rustc -vV | awk '/^host:/{print $2}'
}

oliphaunt_runtime_wasm_asset_mode() {
  command -v bun >/dev/null 2>&1 || {
    echo "Bun is required to inspect target/oliphaunt-wasix/assets/manifest.json" >&2
    return 1
  }
  bun --eval '
const manifest = await Bun.file("target/oliphaunt-wasix/assets/manifest.json").json();
const present = (value) => value !== null && value !== undefined && value !== false
  && (!Array.isArray(value) || value.length > 0)
  && (typeof value !== "string" || value.length > 0)
  && (typeof value !== "number" || value !== 0)
  && (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 0);
console.log(present(manifest.extensions) && present(manifest["pg-dump"]) && present(manifest.psql) ? "full" : "core");
'
}

oliphaunt_runtime_wasm_require() {
  oliphaunt_runtime_mode="${1:-smoke}"
  oliphaunt_runtime_host="$(oliphaunt_runtime_wasm_host_triple)"
  [ -f "target/oliphaunt-wasix/assets/manifest.json" ] || {
    echo "missing generated portable WASIX assets at target/oliphaunt-wasix/assets" >&2
    return 1
  }
  [ -f "target/oliphaunt-wasix/aot/$oliphaunt_runtime_host/manifest.json" ] ||
    [ -f "src/runtimes/liboliphaunt/wasix/crates/aot/$oliphaunt_runtime_host/artifacts/manifest.json" ] || {
      echo "missing host WASIX AOT artifacts for $oliphaunt_runtime_host" >&2
      return 1
    }
  oliphaunt_runtime_asset_mode="$(oliphaunt_runtime_wasm_asset_mode)"
  if [ "$oliphaunt_runtime_asset_mode" = "core" ]; then
    [ "$oliphaunt_runtime_mode" != "regression" ] || {
      echo "full WASIX assets are required for liboliphaunt-wasix:regression" >&2
      return 1
    }
    export OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1
  fi
  export OLIPHAUNT_RUNTIME_WASM_ASSET_MODE="$oliphaunt_runtime_asset_mode"
}
