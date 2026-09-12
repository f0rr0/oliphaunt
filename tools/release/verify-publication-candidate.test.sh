#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${OLIPHAUNT_RELEASE_PLEASE_STATE:-}" ]]; then
  exec bash "$root/tools/release/release-please-state.sh" "$root" HEAD \
    bash "$root/tools/release/verify-publication-candidate.test.sh"
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-publication-candidate.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

for scenario in rerun controller changed-version; do
  repo="$scratch/$scenario"
  git init -q "$repo"
  git -C "$repo" config user.name 'Release Test'
  git -C "$repo" config user.email release@example.invalid
  mkdir -p "$repo/packages/alpha"
  cat > "$repo/release-please-config.json" <<'JSON'
{"packages":{"packages/alpha":{"release-type":"simple","component":"alpha","version-file":"VERSION","changelog-path":"CHANGELOG.md"}}}
JSON
  printf '{"packages/alpha":"0.0.0"}\n' > "$repo/.release-please-manifest.json"
  printf '0.0.0\n' > "$repo/packages/alpha/VERSION"
  printf '# Changelog\n' > "$repo/packages/alpha/CHANGELOG.md"
  git -C "$repo" add .
  git -C "$repo" commit -qm 'feat: introduce fixture'
  printf '{"packages/alpha":"0.1.0"}\n' > "$repo/.release-please-manifest.json"
  printf '0.1.0\n' > "$repo/packages/alpha/VERSION"
  printf '# Changelog\n\n## 0.1.0 (2026-07-30)\n\n- Initial release.\n' > "$repo/packages/alpha/CHANGELOG.md"
  git -C "$repo" add .
  git -C "$repo" commit -qm 'chore(release): publish alpha 0.1.0'
  release="$(git -C "$repo" rev-parse HEAD)"
  case "$scenario" in
    rerun) git -C "$repo" tag alpha-v0.1.0 "$release" ;;
    controller)
      mkdir -p "$repo/tools"
      printf 'changed\n' > "$repo/tools/release-control.txt"
      git -C "$repo" add .
      git -C "$repo" commit -qm 'fix(release): change release control' ;;
    changed-version)
      printf '{"packages/alpha":"0.2.0"}\n' > "$repo/.release-please-manifest.json"
      git -C "$repo" add .
      git -C "$repo" commit -qm 'fix(release): change pending version' ;;
  esac
  head="$(git -C "$repo" rev-parse HEAD)"
  bash "$root/tools/release/with-release-history.sh" "$repo" "$head" \
    bash "$root/tools/dev/bun.sh" "$root/tools/release/verify-publication-candidate.test.mts" \
    "$scenario" "$repo" "$release" "$head"
done
