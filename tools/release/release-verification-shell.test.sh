#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export TEST_BUN_VERSION="$(bun --version)" CALL_LOG="$scratch/calls"
cat > "$scratch/bun" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == --version ]]; then echo "$TEST_BUN_VERSION"; exit 0; fi
printf '%s\0' "$@" >> "$CALL_LOG"
printf '\n' >> "$CALL_LOG"
[[ "$1" != "${FAIL_GATE:-}" ]] || exit 9
SH
chmod +x "$scratch/bun"
export PATH="$scratch:$PATH"
products='["oliphaunt-js", "oliphaunt-rust"]'
head_commit="$(git rev-parse HEAD)"
args=(--products-json "$products" --head-ref "$head_commit" --publication-lock='lock file.json' \
  --registry-receipts 'registry file.json' --github-release-receipt 'github file.json')
run() { : > "$CALL_LOG"; bash "tools/release/$1" "${@:2}" > "$scratch/output" 2>&1; }
record() { printf '%s\0' "$@"; printf '\n'; }
run release-verify.sh "${args[@]}"
cp "$CALL_LOG" "$scratch/success"
record tools/release/registry-integrity.mts --lock 'lock file.json' --products-json "$products" \
  --verify-receipts 'registry file.json' --sealed-receipts > "$scratch/expected"
head -n 1 "$CALL_LOG" > "$scratch/actual"
cmp "$scratch/expected" "$scratch/actual"
record tools/release/verify_github_release_attestations.mts finalize --publication-lock 'lock file.json' \
  --products-json "$products" --head-ref "$head_commit" --receipt 'github file.json' > "$scratch/expected"
tail -n 1 "$CALL_LOG" > "$scratch/actual"
cmp "$scratch/expected" "$scratch/actual"
index=0
while IFS= read -r gate; do
  index=$((index+1))
  status=0
  FAIL_GATE="$gate" run release-verify.sh "${args[@]}" || status=$?
  [[ "$status" == 2 ]]
  head -n "$index" "$scratch/success" > "$scratch/expected"
  cmp "$scratch/expected" "$CALL_LOG"
done < <(tr '\0' '\t' < "$scratch/success" | cut -f 1)
status=0
run release-verify.sh "${args[@]:0:7}" || status=$?
[[ "$status" == 2 && ! -s "$CALL_LOG" ]]
run release-check-registries.sh --products-json "$products" --require-identities
cp "$CALL_LOG" "$scratch/registry-success"
record tools/release/check_registry_publication.mts --products-json "$products" --require-identities > "$scratch/expected"
tail -n 1 "$CALL_LOG" > "$scratch/actual"
cmp "$scratch/expected" "$scratch/actual"
first_gate="$(tr '\0' '\t' < "$scratch/registry-success" | head -n 1 | cut -f 1)"
status=0
FAIL_GATE="$first_gate" run release-check-registries.sh --products-json "$products" --require-identities || status=$?
[[ "$status" == 2 ]]
head -n 1 "$scratch/registry-success" > "$scratch/expected"
cmp "$scratch/expected" "$CALL_LOG"
echo 'Release verification: receipt arguments preserved and failed gates stop subsequent work'
