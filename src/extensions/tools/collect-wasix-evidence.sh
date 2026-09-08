#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel)"
cd "$root"

for command in pnpm rustfmt; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "missing required evidence command: $command" >&2
    exit 1
  fi
done

for name in GITHUB_ACTIONS GITHUB_REPOSITORY GITHUB_WORKFLOW GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_JOB CI_HEAD_SHA; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required; full release evidence is recorded only by GitHub Actions" >&2
    exit 1
  fi
done
if [ "$GITHUB_ACTIONS" != "true" ] || [ "$(git rev-parse 'HEAD^{commit}')" != "$CI_HEAD_SHA" ]; then
  echo "the evidence collector checkout must equal CI_HEAD_SHA exactly" >&2
  exit 1
fi

run_id="${1:-$(date -u +%Y-%m-%dT%H%M%SZ)-wasix-full-lifecycle}"
observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OLIPHAUNT_EXTENSION_EVIDENCE_DIR="$(mktemp -d)"
export OLIPHAUNT_EXTENSION_EVIDENCE_DIR
trap 'rm -rf "$OLIPHAUNT_EXTENSION_EVIDENCE_DIR"' EXIT

# This command exercises every catalogued extension in direct, server, restart,
# materialization, and physical backup/restore modes. The record command is deliberately
# after it so a failing or interrupted run cannot produce passed evidence.
bash src/runtimes/liboliphaunt/wasix/tools/runtime-smoke.sh regression
bash src/extensions/tools/check-extension-model.sh \
  --record-wasix-evidence-run "$run_id" \
  --observed-at "$observed_at"
bash src/extensions/tools/check-extension-model.sh --check --require-current-evidence

echo "recorded immutable WASIX extension evidence run: $run_id"
