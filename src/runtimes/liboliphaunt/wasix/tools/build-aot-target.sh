#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine repository root from $script_dir; run this script from a Git checkout" >&2
  exit 1
}
[ -f "$root/package.json" ] && [ -d "$root/src/runtimes/liboliphaunt/wasix" ] || {
  echo "must run inside the Oliphaunt workspace" >&2
  exit 1
}
cd "$root"

target="${AOT_TARGET:-${1:-}}"
if [ -z "$target" ]; then
  target="$(rustc -vV | awk '/^host:/{print $2}')"
fi
package="${AOT_PACKAGE:-liboliphaunt-wasix-aot-${target}}"
host="$(rustc -vV | awk '/^host:/{print $2}')"
if [ "$target" != "$host" ]; then
  echo "target AOT execution requires the builder host $host to match AOT target $target" >&2
  exit 1
fi

cargo run -p xtask -- assets aot --target-triple "$target"
cargo run -p xtask -- assets package-aot --target-triple "$target"
cargo run -p xtask -- assets package-extension-aot --target-triple "$target"
cargo run -p xtask -- assets check-aot --target-triple "$target"
cargo check -p "$package" --locked
cargo run -p xtask -- assets smoke --core-only

# The portable/Linux regression exercises every promoted extension.  Each host
# must also deserialize and execute machine code produced for that exact host,
# including a side module and the split pg_dump/psql tool artifacts.  Keep this
# bounded representative lane on all four AOT builders so cross-host coverage
# does not multiply the exhaustive 39-extension lifecycle suite by four.
proof_root="$root/target/wasix-target-aot-smoke"
rm -rf "$proof_root"
OLIPHAUNT_WASIX_GENERATED_ASSET_ROOT="$root/target/oliphaunt-wasix/assets" \
OLIPHAUNT_WASIX_EXTENSION_AOT_ARTIFACT_ROOT="$root/target/extensions/wasix/aot-artifacts" \
  tools/dev/bun.sh tools/release/build-extension-ci-artifacts.mjs \
    --output-root "$proof_root/extension-artifacts" \
    --require-wasix \
    oliphaunt-extension-contrib-pg18
OLIPHAUNT_WASM_AOT_VERIFY=full \
OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT="$proof_root/extension-artifacts" \
  cargo test -p oliphaunt-wasix --locked --no-default-features \
  --features extension-uuid-ossp,tools \
  --lib candidate_tests::uuid_ossp_candidate \
  -- --nocapture --test-threads=1
