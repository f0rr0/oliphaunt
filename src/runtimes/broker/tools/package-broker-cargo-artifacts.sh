#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
helper=src/runtimes/broker/tools/package_broker_cargo_artifacts.mts
mkdir -p target/oliphaunt-broker/cargo-package-runs
scratch="$(mktemp -d "$PWD/target/oliphaunt-broker/cargo-package-runs/run-XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
bun "$helper" prepare "$scratch" "$@"
while IFS= read -r -d '' manifest; do
  OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD=1 cargo package \
    --manifest-path "$manifest" --target-dir "$scratch/cargo-target" --allow-dirty
done < "$scratch/manifests"
bun "$helper" finish "$scratch"
