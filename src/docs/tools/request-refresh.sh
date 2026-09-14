#!/usr/bin/env bash
set -euo pipefail

: "${VERCEL_DOCS_DEPLOY_HOOK:?Set VERCEL_DOCS_DEPLOY_HOOK in the protected Production environment to the oliphaunt.dev main-branch deploy hook}"
receipt="${1:?usage: request-refresh.sh RECEIPT_JSON}"
response="$(mktemp)"
trap 'rm -f "$response"' EXIT

# Do not retry a POST with an ambiguous outcome: it may already have queued a build.
curl --fail --silent --show-error --max-time 30 --request POST \
  "$VERCEL_DOCS_DEPLOY_HOOK" --output "$response"
mkdir -p "$(dirname "$receipt")"
jq -e '{job: {id: .job.id, state: .job.state, createdAt: .job.createdAt}}
  | select((.job.id | type) == "string" and (.job.id | length) > 0)' \
  "$response" > "$receipt"
printf 'Vercel accepted the docs refresh request. Deployment success has not been verified.\n'
