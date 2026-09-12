#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./tools/release/verify-github-release-attestation-receipt.test.mts
scratch="$(mktemp -d "$PWD/target/receipt-verifier.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
cat > "$scratch/bin/gh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$TEST_ARGS"
cat "$TEST_RESPONSE"
exit "${TEST_STATUS:-0}"
MOCK
chmod +x "$scratch/bin/gh"
export PATH="$scratch/bin:$PATH"
export TEST_ARGS="$scratch/gh-args" TEST_RESPONSE="$scratch/gh-output.json"
export OLIPHAUNT_ATTESTATION_VERIFICATION_DIR="$scratch"
fixture=tools/release/verify-github-release-attestation-receipt.test.mts
bun "$fixture" prepare-verifier "$scratch"
bash tools/release/verify-github-release-attestations.sh --verify-prepared "$scratch"
bun "$fixture" verify-success "$scratch"
status=0
TEST_STATUS=7 bash tools/release/verify-github-release-attestations.sh --verify-prepared "$scratch" || status=$?
[[ "$status" == 7 ]]
bun "$fixture" verify-unavailable "$scratch"
bun "$fixture" prepare-tampered "$scratch"
bash tools/release/verify-github-release-attestations.sh --verify-prepared "$scratch"
bun "$fixture" verify-tampered "$scratch"
echo 'Attestation CLI identity, failed verification invalidation, and signed bundle integrity passed'
