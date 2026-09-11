#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/release-pr-publish.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/work/.github/scripts" "$scratch/bin" "$scratch/metadata"
git init -q --bare "$scratch/remote"
git init -q -b main "$scratch/work"
cd "$scratch/work"
git config user.name 'Release Fixture'
git config user.email 'release@example.invalid'
cp "$root/.github/scripts/require-current-main.sh" .github/scripts/
echo 0.1.0 >VERSION
git add .
git commit -qm 'feat: source baseline'
git remote add origin "$scratch/remote"
git push -q origin main
export GITHUB_SHA GITHUB_REF=refs/heads/main GITHUB_REPOSITORY=f0rr0/oliphaunt
GITHUB_SHA="$(git rev-parse HEAD)"
export RELEASE_PR_FIXTURE="$scratch"
cat >"$scratch/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'auth setup-git') exit 0 ;;
  'pr list')
    if [[ -f "$RELEASE_PR_FIXTURE/pr.json" ]]; then cat "$RELEASE_PR_FIXTURE/pr.json"; else echo '[]'; fi ;;
  'pr create'|'pr edit')
    sha="$(git --git-dir="$RELEASE_PR_FIXTURE/remote" rev-parse refs/heads/release-please--branches--main)"
    jq -nc --arg sha "$sha" '[{number:42, headRefOid:$sha, headRepository:{nameWithOwner:"f0rr0/oliphaunt"}, isCrossRepository:false, title:"chore(release): prepare main releases", labels:[{name:"autorelease: pending"}]}]' > "$RELEASE_PR_FIXTURE/pr.json"
    if [[ "$2" == create ]]; then
      echo created >> "$RELEASE_PR_FIXTURE/creates"
      if [[ -f "$RELEASE_PR_FIXTURE/ambiguous" ]]; then rm "$RELEASE_PR_FIXTURE/ambiguous"; exit 1; fi
    fi ;;
  *) echo "unexpected gh command: $*" >&2; exit 1 ;;
esac
SH
chmod +x "$scratch/bin/gh"
export PATH="$scratch/bin:$PATH"
title='chore(release): prepare main releases'
printf '%s\n' "$title" >"$scratch/metadata/title"
echo true >"$scratch/metadata/required"
echo 'Release Please fixture notes' >"$scratch/metadata/body.md"
candidate() {
  git checkout -q --detach "$GITHUB_SHA"
  echo 0.1.1 >VERSION
  git add VERSION
  GIT_COMMITTER_DATE="$1" GIT_AUTHOR_DATE="$1" git commit -qm "$title"
}
publish() { bash "$root/.github/scripts/publish-release-pr.sh" "$scratch/metadata"; }
remote_head() { git --git-dir="$scratch/remote" rev-parse refs/heads/release-please--branches--main; }

candidate '2026-09-11T12:00:00Z'
touch "$scratch/ambiguous"
if publish >"$scratch/first.log" 2>&1; then
  echo 'ambiguous create must report failure' >&2
  exit 1
fi
first="$(remote_head)"
publish >"$scratch/recovery.log" 2>&1
[[ "$(wc -l <"$scratch/creates")" == 1 && "$(remote_head)" == "$first" ]]

candidate '2026-09-12T12:00:00Z'
[[ "$(git rev-parse HEAD)" != "$first" ]]
publish >"$scratch/repeat.log" 2>&1
[[ "$(remote_head)" == "$first" ]]

git checkout -q main
echo 'new source' >README.md
git add README.md
git commit -qm 'docs: source update'
git push -q origin main
GITHUB_SHA="$(git rev-parse HEAD)"
candidate '2026-09-13T12:00:00Z'
publish >"$scratch/update.log" 2>&1
[[ "$(remote_head)" == "$(git rev-parse HEAD)" && "$(wc -l <"$scratch/creates")" == 1 ]]

# A branch changed outside the inspected PR is never overwritten.
echo 'unrelated work' >unrelated
git add unrelated
git commit -qm 'feat: unrelated branch work'
git push -q origin HEAD:refs/heads/release-please--branches--main
unexpected="$(remote_head)"
candidate '2026-09-14T12:00:00Z'
if publish >"$scratch/conflict.log" 2>&1; then
  echo 'unrelated remote work must be rejected' >&2
  exit 1
fi
[[ "$(remote_head)" == "$unexpected" ]]
echo 'release PR publication converges across retries and new main; unrelated work is preserved'
