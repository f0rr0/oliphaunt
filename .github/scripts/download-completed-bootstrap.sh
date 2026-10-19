#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
destination="${BOOTSTRAP_LEDGER_PATH:-target/release/bootstrap-ledger}"
mkdir -p "$(dirname "$destination")"
scratch="$(mktemp -d "${destination}.restore.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
bash tools/dev/bun.sh .github/scripts/download-completed-bootstrap.mts discover "$scratch" > "$scratch/source"
{ IFS= read -r source_sha; IFS= read -r controller_sha; } < "$scratch/source"
bash tools/release/publication-controller.sh --changes-only "$source_sha" "$controller_sha" \
  bash tools/dev/bun.sh .github/scripts/download-completed-bootstrap.mts install "$scratch"
