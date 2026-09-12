#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
: "${ORG_GRADLE_PROJECT_signingInMemoryKey:?Maven signing key is required}"
: "${ORG_GRADLE_PROJECT_signingInMemoryKeyId:?Maven signing key ID is required}"
: "${ORG_GRADLE_PROJECT_signingInMemoryKeyPassword:?Maven signing passphrase is required}"
key_id="$(bash tools/dev/bun.sh tools/release/verify-maven-signing-readiness.mts --key-id "$ORG_GRADLE_PROJECT_signingInMemoryKeyId")"
output="$root/target/release/maven-central/normal-registry-plan"
mkdir -p "$output"
# --sign-staged is also usable locally after stageFrozenMavenBundle. Publication
# still requires a matching lock digest, carrier set, size and bundle hash.
if [[ "${1:-}" == --sign-staged ]]; then
  [[ "$#" == 2 ]] || exit 2
  output="$(cd "$2" && pwd)"
else
  bash tools/dev/bun.sh tools/release/preflight-maven-central-bundle.mts --stage "$output" "$@"
  release_commit="$(jq -r .releaseCommit "$output/context.json")"
  commit="$(git rev-parse --verify --end-of-options "$release_commit^{commit}")"
  tree="$(git rev-parse "$commit^{tree}")"
  [[ "$commit" == "$(jq -r .source.commit "$output/context.json")" && "$tree" == "$(jq -r .source.tree "$output/context.json")" ]] || { echo 'Maven source commit/tree differs from the frozen lock' >&2; exit 1; }
fi
rm -f "$output/prepared.json" "$output/central-bundle.zip"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/oliphaunt-maven-bundle-signing.XXXXXX")"
trap 'gpgconf --homedir "$work" --kill all >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
chmod 700 "$work"
printf '%s' "$ORG_GRADLE_PROJECT_signingInMemoryKey" | gpg --batch --homedir "$work" --import
jq -j '.prepared.payloads[].staged + "\u0000"' "$output/context.json" > "$work/files"
while IFS= read -r -d '' file; do
  printf '%s\n' "$ORG_GRADLE_PROJECT_signingInMemoryKeyPassword" | \
    gpg --batch --yes --no-tty --pinentry-mode loopback --passphrase-fd 0 --homedir "$work" \
    --local-user "$key_id" --armor --detach-sign --output "$file.asc" "$file"
  gpg --batch --no-auto-key-retrieve --homedir "$work" --status-fd 1 --verify "$file.asc" "$file" > "$work/status"
  bash tools/dev/bun.sh tools/release/verify-maven-signing-readiness.mts --signature "$work/status" "$key_id" >/dev/null
done < "$work/files"
(cd "$output/layout" && zip -q -X -r "$output/central-bundle.zip" .)
bash tools/dev/bun.sh tools/release/preflight-maven-central-bundle.mts --record "$output"
