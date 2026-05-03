#!/usr/bin/env bash
set -euo pipefail

workflow="${1:?usage: require-workflow-success.sh <workflow> <sha> [timeout-seconds]}"
sha="${2:?usage: require-workflow-success.sh <workflow> <sha> [timeout-seconds]}"
timeout="${3:-7200}"

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"

deadline=$((SECONDS + timeout))
while true; do
  runs="$(gh run list \
    --workflow "$workflow" \
    --commit "$sha" \
    --limit 10 \
    --json databaseId,status,conclusion,url \
    --jq '.[] | [.databaseId, .status, (.conclusion // ""), .url] | @tsv')"
  if [ -n "$runs" ]; then
    echo "$runs"
    if echo "$runs" | awk -F '\t' '$2 == "completed" && $3 == "success" { found=1 } END { exit found ? 0 : 1 }'; then
      exit 0
    fi
    if echo "$runs" | awk -F '\t' '$2 == "completed" && $3 != "success" { failed=1 } END { exit failed ? 0 : 1 }'; then
      echo "$workflow failed for $sha" >&2
      exit 1
    fi
  else
    echo "waiting for $workflow workflow for $sha"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "timed out waiting for successful $workflow workflow for $sha" >&2
    exit 1
  fi
  sleep 60
done
