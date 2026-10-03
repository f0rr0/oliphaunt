#!/usr/bin/env bash
set -euo pipefail
admission="$1"
transport_timeout="$2"
tarball="$(jq -r .tarball "$admission")"
registry="$(jq -r .registry "$admission")"
seconds="$(jq -r '.timeout / 1000 | floor' "$admission")"
status=0
NPM_CONFIG_FETCH_RETRIES=0 "$transport_timeout" --kill-after=5s "${seconds}s" \
  npm publish "$tarball" --access public --provenance --registry "$registry" 2>&1 | tee "$admission.log" || status=$?
# An authorization rejection cannot become visible by waiting. The caller still
# reconciles successful uploads and ambiguous transport outcomes against the lock.
if [[ "$status" != 0 ]] && grep -Eq '^npm (error|ERR!) code (ENEEDAUTH|E401|E403|EOTP)([[:space:]]|$)' "$admission.log"; then
  echo "npm publication authorization failed for $(jq -r '.packageName + "@" + .version' "$admission"); fix its publishing credentials before retrying" >&2
  exit "$status"
fi
if [[ "$status" != 0 ]]; then echo "npm upload returned exit $status; reconciling the frozen version" >&2; fi
