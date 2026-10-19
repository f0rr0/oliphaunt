#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
: "${ORG_GRADLE_PROJECT_signingInMemoryKey:?Maven signing key is required}"
: "${ORG_GRADLE_PROJECT_signingInMemoryKeyId:?Maven signing key ID is required}"
: "${ORG_GRADLE_PROJECT_signingInMemoryKeyPassword:?Maven signing passphrase is required}"
data() { bash tools/dev/bun.sh tools/release/verify-maven-signing-readiness.mts "$@"; }
key_id="$(data --key-id "$ORG_GRADLE_PROJECT_signingInMemoryKeyId")"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/oliphaunt-maven-signing.XXXXXX")"
trap 'gpgconf --homedir "$work" --kill all >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
chmod 700 "$work"
printf '%s' "$ORG_GRADLE_PROJECT_signingInMemoryKey" | gpg --batch --homedir "$work" --import
printf 'oliphaunt Maven signing readiness preflight\n' > "$work/payload"
printf '%s\n' "$ORG_GRADLE_PROJECT_signingInMemoryKeyPassword" | \
  gpg --batch --yes --no-tty --pinentry-mode loopback --passphrase-fd 0 --homedir "$work" \
  --local-user "$key_id" --armor --detach-sign --output "$work/payload.asc" "$work/payload"
gpg --batch --no-auto-key-retrieve --homedir "$work" --status-fd 1 \
  --verify "$work/payload.asc" "$work/payload" > "$work/status"
fingerprint="$(data --signature "$work/status" "$key_id")"
for server in keyserver.ubuntu.com keys.openpgp.org pgp.mit.edu; do
  if [[ "$server" == keys.openpgp.org ]]; then
    url="https://$server/vks/v1/by-fingerprint/$fingerprint"
  else
    url="https://$server/pks/lookup?op=get&options=mr&search=0x$fingerprint"
  fi
  if curl --fail --silent --show-error --max-time 15 --max-filesize 1048576 \
      --proto '=https' -H 'Accept: application/pgp-keys, application/octet-stream;q=0.9, text/plain;q=0.8' \
      --user-agent 'oliphaunt-maven-signing-readiness/1; https://github.com/f0rr0/oliphaunt' \
      --output "$work/public.asc" "$url" &&
    gpg --batch --homedir "$work" --with-colons --import-options show-only \
      --import < "$work/public.asc" > "$work/public-listing" &&
    data --public-key "$work/public-listing" "$fingerprint"; then
    echo "Verified primary Maven signing key $fingerprint locally and on $server"
    exit 0
  fi
done
echo "Primary Maven signing key $fingerprint is not verifiably published on a Central-supported keyserver" >&2
exit 1
