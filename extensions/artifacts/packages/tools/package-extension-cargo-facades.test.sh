#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./extensions/artifacts/packages/tools/package-extension-cargo-facades.test.mts
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
host="$(rustc -vV | sed -n 's/^host: //p')"
fixture=extensions/artifacts/packages/tools/package-extension-cargo-facades.test.mts
bun "$fixture" prepare-compiler "$scratch" "$host"
if rustc --crate-name fixture_extension --crate-type lib --edition 2024 --cfg 'feature="native"' "$scratch/forced-unsupported.rs" --out-dir "$scratch" > "$scratch/unsupported.log" 2>&1; then
  echo 'Unsupported native target unexpectedly compiled' >&2
  exit 1
fi
grep -q 'default native feature supports only' "$scratch/unsupported.log"
rustc --crate-name fixture_extension --crate-type lib --edition 2024 --cfg 'feature="wasix"' --emit metadata -o "$scratch/wasix.rmeta" "$scratch/forced-unsupported.rs"
OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD=1 cargo check --manifest-path "$scratch/app/Cargo.toml" --target-dir "$scratch/cargo-target"
bun "$fixture" verify-compiler "$scratch"
echo 'Compiled facade target selection and exact selected Cargo payload propagation passed'
