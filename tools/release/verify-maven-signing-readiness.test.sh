#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./tools/release/verify-maven-signing-readiness.test.mts
scratch="$(mktemp -d)"
cleanup() {
  gpgconf --homedir "$scratch/keys" --kill all >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir -m 700 "$scratch/keys"
mkdir "$scratch/bin" "$scratch/runs"
gpg_fixture() { gpg --batch --homedir "$scratch/keys" "$@"; }
passphrase='fixture password'
printf '%s\n' "$passphrase" | gpg_fixture --pinentry-mode loopback --passphrase-fd 0 \
  --quick-generate-key 'Maven fixture <fixture@example.invalid>' ed25519 sign 0
gpg_fixture --with-colons --list-keys > "$scratch/key-list"
fingerprint="$(bun -e 'import {readFileSync} from "node:fs"; import {publicKeyFingerprints} from "./tools/release/verify-maven-signing-readiness.mts"; console.log(publicKeyFingerprints(readFileSync(process.argv[1],"utf8"))[0])' "$scratch/key-list")"
export ORG_GRADLE_PROJECT_signingInMemoryKey
ORG_GRADLE_PROJECT_signingInMemoryKey="$(printf '%s\n' "$passphrase" | gpg_fixture \
  --pinentry-mode loopback --passphrase-fd 0 --armor --export-secret-keys "$fingerprint")"
gpg_fixture --armor --export "$fingerprint" > "$scratch/public.asc"
cat > "$scratch/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output='' timeout='' limit=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --max-time) timeout="$2"; shift 2 ;;
    --max-filesize) limit="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
[[ "$timeout" == 15 && "$limit" == 1048576 ]] || exit 99
printf '%s\n' "$url" >> "$MAVEN_CURL_LOG"
[[ "$url" != *keyserver.ubuntu.com* ]] || exit 22
[[ "${MAVEN_BAD_KEY:-}" != true ]] || { echo 'wrong public key' > "$output"; exit 0; }
cp "$MAVEN_PUBLIC_KEY" "$output"
SH
chmod +x "$scratch/bin/curl"
export PATH="$scratch/bin:$PATH" RUNNER_TEMP="$scratch/runs"
export MAVEN_CURL_LOG="$scratch/requests" MAVEN_PUBLIC_KEY="$scratch/public.asc"
export ORG_GRADLE_PROJECT_signingInMemoryKeyId="$fingerprint"
export ORG_GRADLE_PROJECT_signingInMemoryKeyPassword="$passphrase"
bash tools/release/verify-maven-signing-readiness.sh > "$scratch/result" 2>&1
rg -q -F "$fingerprint" "$scratch/result"
rg -q -F keys.openpgp.org "$scratch/result"
[[ -z "$(ls -A "$scratch/runs")" ]]
[[ "$(wc -l < "$scratch/requests")" -eq 2 ]]
if MAVEN_BAD_KEY=true bash tools/release/verify-maven-signing-readiness.sh > "$scratch/result" 2>&1; then
  echo 'Invalid public signing key accepted' >&2; exit 1
fi
rg -q 'not verifiably published' "$scratch/result"
[[ -z "$(ls -A "$scratch/runs")" ]]
cp "$scratch/requests" "$scratch/before"
if ORG_GRADLE_PROJECT_signingInMemoryKeyPassword=wrong bash tools/release/verify-maven-signing-readiness.sh > "$scratch/result" 2>&1; then
  echo 'Invalid private key password accepted' >&2; exit 1
fi
cmp "$scratch/before" "$scratch/requests"
[[ -z "$(ls -A "$scratch/runs")" ]]
echo 'Maven signing: real signature, keyserver fallback, invalid keys and cleanup passed'
