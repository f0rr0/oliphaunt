#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
export OLIPHAUNT_NATIVE_CARGO_TEST_ROOT OLIPHAUNT_ELF_STRIP OLIPHAUNT_STRIP
OLIPHAUNT_NATIVE_CARGO_TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$OLIPHAUNT_NATIVE_CARGO_TEST_ROOT"' EXIT
root="$OLIPHAUNT_NATIVE_CARGO_TEST_ROOT"
OLIPHAUNT_ELF_STRIP="$root/forbidden-strip"
OLIPHAUNT_STRIP="$OLIPHAUNT_ELF_STRIP"
cat > "$OLIPHAUNT_STRIP" <<'STRIP'
#!/bin/sh
echo 'Carrier assembly must not strip frozen release assets' >&2
exit 99
STRIP
chmod +x "$OLIPHAUNT_STRIP"
bun test --timeout=30000 ./runtimes/liboliphaunt-native/tools/package-liboliphaunt-cargo-artifacts.test.mts
CARGO_HOME="$root/installed-consumer/cargo-home" \
  CARGO_TARGET_DIR="$root/installed-consumer/target" \
  cargo check --offline --manifest-path "$root/installed-consumer/Cargo.toml"
if rustc --crate-name oliphaunt_tools --crate-type lib --edition 2024 \
  --emit metadata -o "$root/unsupported.rmeta" "$root/forced-unsupported-tools.rs" \
  > "$root/unsupported.log" 2>&1; then
  echo 'Unsupported tools target unexpectedly compiled' >&2
  exit 1
fi
grep -Fq 'has no portable fallback' "$root/unsupported.log"
rustc --crate-name oliphaunt_tools --crate-type lib --edition 2024 \
  --emit metadata -o "$root/supported.rmeta" "$root/forced-supported-tools.rs"
