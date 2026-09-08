#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
mkdir -p target
stage="$(mktemp -d "$root/target/extension-model.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mode=check
for arg in "$@"; do
  case "$arg" in
    --write) mode=write ;;
    --write-evidence) mode=evidence ;;
    --write-evidence-summary) mode=summary ;;
    --record-wasix-evidence-run) mode=record ;;
  esac
done
identity=(--source-commit "$(git rev-parse 'HEAD^{commit}')" --source-tree "$(git rev-parse 'HEAD^{tree}')")
if [ "$mode" = record ]; then
  bash tools/dev/bun.sh src/extensions/tools/check-extension-model.mts --source-inputs > "$stage/inputs"
  inputs=()
  while IFS= read -r file; do inputs+=("$file"); done < "$stage/inputs"
  if [ -z "$(git status --porcelain=v1 -- "${inputs[@]}")" ]; then identity+=(--clean-inputs); fi
fi
bash tools/dev/bun.sh src/shared/product-metadata/query.mts extension-metadata > "$stage/releases.json"
bash tools/dev/bun.sh src/extensions/tools/check-extension-model.mts --stage "$stage" --release-metadata "$stage/releases.json" "${identity[@]}" "$@" > "$stage/outputs"
# Format staged source before comparing or installing any generated file.
while IFS= read -r file; do
  case "$file" in
    *.rs) rustfmt "$stage/$file" ;;
    *.ts)
      pnpm exec biome format --stdin-file-path "$file" < "$stage/$file" > "$stage/formatted"
      mv "$stage/formatted" "$stage/$file"
      ;;
  esac
done < "$stage/outputs"
while IFS= read -r file; do
  case "$mode:$file" in
    write:*|evidence:src/extensions/evidence/matrix.toml|evidence:src/extensions/generated/docs/extension-evidence.json|summary:src/extensions/generated/docs/extension-evidence.json|record:src/extensions/evidence/*|record:src/extensions/generated/docs/extension-evidence.json) ;;
    *) cmp "$file" "$stage/$file" || { echo "$file is stale; run bash src/extensions/tools/check-extension-model.sh --write" >&2; exit 1; } ;;
  esac
done < "$stage/outputs"
while IFS= read -r file; do
  case "$mode:$file" in
    record:src/extensions/evidence/runs/*)
      # Same-filesystem link publishes a complete record and cannot overwrite history.
      ln "$stage/$file" "$file"
      ;;
    write:*|evidence:src/extensions/evidence/matrix.toml|evidence:src/extensions/generated/docs/extension-evidence.json|summary:src/extensions/generated/docs/extension-evidence.json|record:src/extensions/evidence/matrix.toml|record:src/extensions/generated/docs/extension-evidence.json)
      cp "$stage/$file" "$file"
      ;;
  esac
done < "$stage/outputs"
legal_mode=--check
[ "$mode" != write ] || legal_mode=--write
bash tools/dev/bun.sh src/extensions/tools/android-extension-legal-catalog.mts "$legal_mode"
echo 'extension model checks passed'
