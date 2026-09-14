#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/request-refresh.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
cat > "$scratch/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
while [ "$1" != --output ]; do shift; done
printf '%s\n' "$HOOK_RESPONSE" > "$2"
SH
chmod +x "$scratch/bin/curl"
export PATH="$scratch/bin:$PATH"
export VERCEL_DOCS_DEPLOY_HOOK=https://invalid.example/test-only
export HOOK_RESPONSE='{"job":{"id":"accepted-job","state":"PENDING","createdAt":123}}'
bash "$script" "$scratch/receipt.json"
jq -e '.job.id == "accepted-job" and .job.state == "PENDING"' "$scratch/receipt.json" >/dev/null
HOOK_RESPONSE='{}'
if bash "$script" "$scratch/invalid.json"; then
  echo 'Malformed hook acceptance unexpectedly succeeded' >&2; exit 1
fi
if VERCEL_DOCS_DEPLOY_HOOK= bash "$script" "$scratch/missing.json" 2>/dev/null; then
  echo 'Missing hook configuration unexpectedly succeeded' >&2; exit 1
fi
printf 'Docs hook acceptance and failure handling passed (no network requests)\n'
