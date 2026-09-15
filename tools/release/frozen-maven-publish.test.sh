#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./tools/release/frozen-maven-publish.test.mts
scratch="$(mktemp -d "$PWD/target/frozen-maven-signing.XXXXXX")"
signing_home="$scratch/gpg"
cleanup() { gpgconf --homedir "$signing_home" --kill all >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
mkdir -m 700 "$signing_home"
bun tools/release/frozen-maven-publish.test.mts prepare-signing "$scratch"
printf '%s\n' 'fixture password' | gpg --batch --homedir "$signing_home" --pinentry-mode loopback --passphrase-fd 0 --quick-generate-key 'Maven bundle <fixture@example.invalid>' ed25519 sign 0
fingerprint="$(gpg --batch --homedir "$signing_home" --with-colons --list-keys | awk -F: '$1=="fpr" {print $10;exit}')"
export ORG_GRADLE_PROJECT_signingInMemoryKeyId="$fingerprint"
export ORG_GRADLE_PROJECT_signingInMemoryKeyPassword='fixture password'
ORG_GRADLE_PROJECT_signingInMemoryKey="$(printf '%s\n' 'fixture password' | gpg --batch --homedir "$signing_home" --pinentry-mode loopback --passphrase-fd 0 --armor --export-secret-keys "$fingerprint")"
export ORG_GRADLE_PROJECT_signingInMemoryKey
bash tools/release/preflight-maven-central-bundle.sh --sign-staged "$scratch/output"
unset ORG_GRADLE_PROJECT_signingInMemoryKey ORG_GRADLE_PROJECT_signingInMemoryKeyPassword ORG_GRADLE_PROJECT_signingInMemoryKeyId
while IFS= read -r payload; do
  gpg --batch --homedir "$signing_home" --verify "$payload.asc" "$payload"
done < "$scratch/payloads.txt"
bun tools/release/frozen-maven-publish.test.mts verify-signing "$scratch"
echo 'Frozen Maven signing, locked payload bytes, and immutable bundle checks passed'
