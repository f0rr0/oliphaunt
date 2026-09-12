#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun tools/packaging/wasix-cargo-payload.test.mts "$scratch"
while IFS=$'\t' read -r crate payload variable external; do
  # A real extracted carrier embeds its own bytes.
  CARGO_TARGET_DIR="$scratch/cargo-target" cargo run --offline --quiet \
    --manifest-path "$crate/Cargo.toml" --example probe
  if [[ "$payload" == artifacts ]]; then
    mkdir "$crate/removed-aot"
    mv "$crate/$payload/"*.zst "$crate/removed-aot/"
    if CARGO_TARGET_DIR="$scratch/cargo-target" cargo check --offline --quiet \
      --manifest-path "$crate/Cargo.toml" --lib > "$scratch/missing-aot.log" 2>&1; then
      echo "Published carrier accepted missing declared AOT files: $crate" >&2
      exit 1
    fi
    rg -q 'missing declared WASIX AOT artifact' "$scratch/missing-aot.log"
    mv "$crate/removed-aot/"*.zst "$crate/$payload/"
  fi
  mv "$crate/$payload" "$crate/removed-payload"
  # Neither a populated ancestor checkout nor an explicit override may repair
  # an incomplete published package, even without the maintainer strict flag.
  if env "$variable=$external" CARGO_TARGET_DIR="$scratch/cargo-target" \
    cargo run --offline --quiet --manifest-path "$crate/Cargo.toml" \
    --example probe > "$scratch/missing.log" 2>&1; then
    echo "Published carrier accepted missing payload: $crate" >&2
    exit 1
  fi
  rg -q 'published WASIX carrier requires package-local' "$scratch/missing.log"
  # The checkout entrypoint deliberately supports the same external inputs.
  printf 'const PACKAGE_LOCAL: bool = false;\ninclude!("build-support.rs");\n' > "$crate/build.rs"
  env "$variable=$external" CARGO_TARGET_DIR="$scratch/cargo-target" \
    cargo run --offline --quiet --manifest-path "$crate/Cargo.toml" --example probe
  mv "$external" "$external.saved"
  CARGO_TARGET_DIR="$scratch/cargo-target" cargo check --offline --quiet \
    --manifest-path "$crate/Cargo.toml" --lib
done < "$scratch/cases.tsv"
printf 'WASIX extracted Cargo carrier payload isolation passed\n'
