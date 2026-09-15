#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[[ $# == 1 ]] || {
  echo 'usage: close-release-candidate.sh OUTPUT_DIRECTORY' >&2
  exit 2
}
[[ "$(cat "$1/required")" == true ]] || exit 0
title="$(cat "$1/title")"
git config user.name "$(bun -p 'require("./tools/release/release-bot.json").name')"
git config user.email "$(bun -p 'require("./tools/release/release-bot.json").email')"
git add -A
git commit -m "$title"
bash tools/release/sync-release-pr.sh
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  git add -A
  git commit --amend --no-edit
fi
products="$(bash tools/release/release-please-state.sh "$PWD" HEAD bash tools/release/with-release-history.sh "$PWD" HEAD tools/dev/bun.sh tools/release/verify-release-commit.mts --derive-products --head-ref HEAD)"
bash tools/release/release-please-state.sh "$PWD" HEAD bash tools/release/with-release-history.sh "$PWD" HEAD tools/dev/bun.sh tools/release/verify-release-commit.mts --products-json "$products" --head-ref HEAD
bash tools/release/release-metadata-check.sh --publication
