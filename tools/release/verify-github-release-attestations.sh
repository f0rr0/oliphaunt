#!/usr/bin/env bash
set -euo pipefail
owner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$owner/../.."
native() { bash tools/dev/bun.sh tools/release/verify_github_release_attestations.mts "$@"; }
case "${1:-}" in
  finalize|--help|-h) native "$@"; exit ;;
esac
# The prepared-only entry is also usable locally for a previously prepared bundle set.
if [[ "${1:-}" == --verify-prepared ]]; then
  scratch="${2:?prepared directory required}"
else
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-release-attestations.XXXXXX")"
  trap 'rm -rf "$scratch"' EXIT
fi
OLIPHAUNT_ATTESTATION_VERIFICATION_DIR="$scratch"
export OLIPHAUNT_ATTESTATION_VERIFICATION_DIR
case "${1:-}" in
  pre-mutation) native --prepare-bundles "$scratch" "${@:2}" ;;
  --verify-prepared) ;;
  *) bash tools/release/with-release-tags.sh bash tools/dev/bun.sh tools/release/verify_github_release_attestations.mts --prepare-public "$scratch" "$@" ;;
esac
bounded="$(command -v timeout || command -v gtimeout)"
for subject in "$scratch"/*.subject; do
  [[ -f "$subject" ]] || continue
  { IFS= read -r -d '' file; IFS= read -r -d '' bundle; IFS= read -r -d '' head; IFS= read -r -d '' repo; } < "$subject"
  rm -f "${subject%.subject}.json"
  (
    ulimit -f 65536
    "$bounded" --kill-after=5s 300s gh attestation verify "$file" --repo "$repo" --bundle "$bundle" \
      --format json --predicate-type https://slsa.dev/provenance/v1 \
      --signer-workflow "$repo/.github/workflows/release.yml" --signer-digest "$head" \
      --source-ref refs/heads/main --source-digest "$head" --deny-self-hosted-runners \
      > "${subject%.subject}.tmp"
  )
  mv "${subject%.subject}.tmp" "${subject%.subject}.json"
done
for record in "$scratch"/*/*.public; do
  [[ -f "$record" ]] || continue
  { IFS= read -r -d '' repo; IFS= read -r -d '' tag; IFS= read -r -d '' asset; IFS= read -r -d '' file; } < "$record"
  "$bounded" --kill-after=5s 600s gh release download "$tag" --repo "$repo" --pattern "$asset" --dir "$(dirname "$file")"
  "$bounded" --kill-after=5s 300s gh attestation verify "$file" --repo "$repo" \
    --signer-workflow "$repo/.github/workflows/release.yml" --source-ref refs/heads/main --deny-self-hosted-runners
done
if [[ "${1:-}" == pre-mutation ]]; then native "$@"; fi
