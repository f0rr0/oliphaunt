#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

base_ref="${EXAMPLE_LOCK_BASE_REF:-}"
if [[ -z "$base_ref" ]]; then
  if git rev-parse --verify -q '@{upstream}' >/dev/null; then
    base_ref='@{upstream}'
  else
    base_ref='origin/main'
  fi
fi

if ! git rev-parse --verify -q "${base_ref}^{commit}" >/dev/null; then
  echo "example lockfile check skipped: ${base_ref} is not available" >&2
  exit 0
fi

changed="$(
	git diff --name-only "${base_ref}...HEAD" -- \
	Cargo.toml \
	Cargo.lock \
	src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml \
	src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml \
	src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml \
	src/runtimes/liboliphaunt/wasix/crates/aot \
	src/runtimes/liboliphaunt/wasix/crates/tools-aot \
	src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml \
	src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.lock \
	examples/tauri/src-tauri/Cargo.toml \
	examples/tauri/src-tauri/Cargo.lock \
	examples/tauri-wasix/src-tauri/Cargo.toml \
	examples/tauri-wasix/src-tauri/Cargo.lock \
	examples/electron-wasix/src-wasix/Cargo.toml \
	examples/electron-wasix/src-wasix/Cargo.lock \
	examples/tools/check-lockfiles.sh \
	tools/release/sync-example-lockfiles.mjs
)"

if [[ -z "$changed" ]]; then
  echo "example lockfile check skipped: no package version or lockfile changes"
  exit 0
fi

tools/release/sync-example-lockfiles.mjs --check
