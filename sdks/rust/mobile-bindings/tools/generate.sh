#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
case "$(uname -s)" in
  Darwin) library=liboliphaunt_mobile_bindings.dylib ;;
  Linux) library=liboliphaunt_mobile_bindings.so ;;
  MINGW*|MSYS*|CYGWIN*) library=oliphaunt_mobile_bindings.dll ;;
  *) echo "unsupported generation host: $(uname -s)" >&2; exit 2 ;;
esac
cargo build --locked -p oliphaunt-mobile-bindings --features bindgen
mkdir -p "$root/target/mobile-bindings"
stage="$(mktemp -d "$root/target/mobile-bindings/generated.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
"${CARGO_TARGET_DIR:-$root/target}/debug/oliphaunt-mobile-bindgen" \
  generate --library "${CARGO_TARGET_DIR:-$root/target}/debug/$library" \
  --config sdks/rust/mobile-bindings/uniffi.toml \
  --language swift --language kotlin --no-format \
  --out-dir "$stage"
rm -rf "$root/target/mobile-bindings/generated"
mv "$stage" "$root/target/mobile-bindings/generated"
