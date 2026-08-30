#!/usr/bin/env bash
set -euo pipefail

mode="${1:-check-static}"
workspace_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$workspace_root"

product="src/runtimes/wasix-napi"

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "missing required WASIX N-API file: $1" >&2
    exit 1
  fi
}

check_static() {
  for file in \
    "$product/Cargo.toml" \
    "$product/build.rs" \
    "$product/src/lib.rs" \
    "$product/package.json" \
    "$product/README.md" \
    "$product/CHANGELOG.md" \
    "$product/release.toml" \
    "$product/moon.yml" \
    "$product/tools/build-native.sh" \
    "$product/tools/check-build-inputs.mjs" \
    "$product/tools/check-package-metadata.test.mjs" \
    "$product/tools/package-contract.test.mjs" \
    "$product/tools/detect-linux-libc.mjs" \
    "$product/tools/detect-linux-libc.test.mjs" \
    "$product/tools/package-platform.mjs" \
    "$product/tools/portable-command.mjs" \
    "$product/tools/portable-command.test.mjs" \
    "$product/tools/smoke-packaged-addon.mjs" \
    "$product/tools/check-package-metadata.mjs" \
    "tools/release/build-linux-wasix-napi-baseline.sh"; do
    require_file "$file"
  done
  for carrier in darwin-arm64 linux-arm64-gnu linux-x64-gnu win32-x64-msvc; do
    require_file "$product/packages/$carrier/package.json"
    require_file "$product/packages/$carrier/README.md"
  done
  tools/dev/bun.sh "$product/tools/check-package-metadata.mjs"
  tools/dev/bun.sh test \
    "$product/tools/check-package-metadata.test.mjs" \
    "$product/tools/detect-linux-libc.test.mjs" \
    "$product/tools/package-contract.test.mjs" \
    "$product/tools/portable-command.test.mjs"
  node --check "$product/tools/smoke-packaged-addon.mjs"
  cargo fmt --manifest-path "$product/Cargo.toml" --check
  cargo check --manifest-path "$product/Cargo.toml" --locked --no-default-features
  cargo test --manifest-path "$product/Cargo.toml" \
    --locked \
    --no-default-features \
    --features test-noop \
    --lib
}

case "$mode" in
  check-static|test-unit)
    check_static
    ;;
  package-shape)
    check_static
    if ! grep -Fq '"src/runtimes/wasix-napi/packages/*"' pnpm-workspace.yaml; then
      echo "pnpm workspace must include WASIX N-API optional platform packages" >&2
      exit 1
    fi
    ;;
  *)
    echo "unknown WASIX N-API check mode: $mode" >&2
    exit 2
    ;;
esac

echo "oliphaunt-wasix-napi $mode passed"
