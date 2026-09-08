#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
run_id= sha= release= required_job= target= all=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --all-targets) all=true; shift ;;
    --run-id|--sha|--release|--required-job|--target|--target-triple)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "$1 requires a value" >&2; exit 2; }
      case "$1" in
        --run-id) run_id="$2" ;; --sha) sha="$2" ;; --release) release="$2" ;;
        --required-job) required_job="$2" ;; *) target="$2" ;;
      esac
      shift 2 ;;
    *) echo "unknown download option: $1" >&2; exit 2 ;;
  esac
done
[ "$all" = false ] || [ -z "$target" ] || { echo 'choose --all-targets or --target' >&2; exit 2; }
if [ -n "$release" ]; then
  [ -z "$run_id$sha$required_job" ] && [[ "$release" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'release requires one valid tag and no workflow selector' >&2; exit 2; }
else
  [ -n "$run_id$sha" ] || { echo '--run-id or --sha is required' >&2; exit 2; }
fi
if [ "$all" = true ]; then target=all; elif [ -z "$target" ]; then target="$(rustc -vV | awk '/^host:/{print $2}')"; fi
rows="$(tools/dev/bun.sh src/runtimes/liboliphaunt/wasix/tools/wasix-cargo-artifact-contract.mts "$target")"
stage="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-wasix-download.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
payload="$stage/payload"
mkdir "$payload"
install_args=(--from "$payload")
if [ -n "$release" ]; then
  version="${release##*-v}"
  checksum="liboliphaunt-wasix-$version-release-assets.sha256"
  curl_args=(--fail --location --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 --retry 3 --retry-max-time 1800)
  case "$(uname -s)" in MINGW*|MSYS*) curl_args+=(--ssl-revoke-best-effort) ;; esac
  url="https://github.com/f0rr0/oliphaunt/releases/download/$release"
  curl "${curl_args[@]}" "$url/$checksum" --output "$stage/$checksum"
  archives=("liboliphaunt-wasix-$version-runtime-portable.tar.zst")
  while IFS=$'\t' read -r triple artifact id; do
    archives+=("liboliphaunt-wasix-$version-runtime-aot-$id.tar.zst")
    install_args+=(--target-triple "$triple")
  done <<<"$rows"
  if command -v sha256sum >/dev/null; then hash=(sha256sum); else hash=(shasum -a 256); fi
  for archive in "${archives[@]}"; do
    expected="$(awk -v asset="$archive" '
      NF != 2 || length($1) != 64 || $1 ~ /[^a-fA-F0-9]/ { bad=1 }
      { name=$2; sub(/^\*/, "", name); sub(/^\.\//, "", name); if (name == asset) { count++; digest=tolower($1) } }
      END { if (bad || count != 1) exit 1; print digest }
    ' "$stage/$checksum")"
    curl "${curl_args[@]}" "$url/$archive" --output "$stage/$archive"
    printf '%s  %s\n' "$expected" "$stage/$archive" | "${hash[@]}" -c -
    cargo run --quiet --locked -p xtask -- assets unpack "$stage/$archive" "$payload"
  done
else
  export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  : "${GH_TOKEN:?GitHub authentication is required}"
  export GH_REPO="${GH_REPO:-${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}}"
  if [ -z "$sha" ]; then sha="$(gh run view "$run_id" --json headSha --jq .headSha)"; fi
  [[ "$sha" =~ ^[a-fA-F0-9]{40}$ ]] || { echo '--sha must be a full commit SHA' >&2; exit 2; }
  if [ -z "$run_id" ]; then
    run_id="$(gh run list --workflow CI --commit "$sha" --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
    : "${run_id:?no successful CI run exists for the requested commit}"
  fi
  download_args=()
  [ -z "$run_id" ] || download_args+=(--run-id "$run_id")
  [ -z "$required_job" ] || download_args+=(--job "$required_job")
  bash .github/scripts/download-build-artifacts.sh CI "$sha" "$payload" "${download_args[@]}" --artifact liboliphaunt-wasix-runtime-portable
  while IFS=$'\t' read -r triple artifact id; do
    bash .github/scripts/download-build-artifacts.sh CI "$sha" "$payload/target/oliphaunt-wasix/aot/$triple" "${download_args[@]}" --artifact "$artifact"
    install_args+=(--target-triple "$triple")
  done <<<"$rows"
fi
cargo run --quiet --locked -p xtask -- assets import-download "${install_args[@]}"
