#!/usr/bin/env bash
set -euo pipefail

subject="${1:-}"
base_ref="${2:-origin/main}"
head_ref="${3:-HEAD}"
head_branch="${4:-}"
event_name="${5:-}"
full_ref="${6:-}"

if [[ -z "${subject}" ]]; then
  echo "expected a non-empty PR title or commit subject" >&2
  exit 1
fi

if ! git rev-parse --verify "${head_ref}^{commit}" >/dev/null 2>&1; then
  echo "could not resolve release-intent head ref: ${head_ref}" >&2
  exit 1
fi

# The final authorized protected-main rewrite reports the already-qualified
# introduction tip as `github.event.before`. This is intentionally distinct
# from the older displaced-main release-metadata baseline. Its immutable
# before/ref/event tuple and the exact unreleased introduction shape make this
# exception non-replayable. Every other non-fast-forward comparison remains
# strict.
if ! git rev-parse --verify "${base_ref}^{commit}" >/dev/null 2>&1 ||
  ! git merge-base --is-ancestor "${base_ref}^{commit}" "${head_ref}^{commit}"; then
  if ! repair_contract="$(
    bun -e '
import {
  RELEASE_PLEASE_BOOTSTRAP_SHA,
  RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
  RELEASE_PLEASE_INTRODUCTION_SUBJECT,
} from "./tools/release/release-please-bootstrap.mjs";
console.log([
  RELEASE_PLEASE_BOOTSTRAP_SHA,
  RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
  RELEASE_PLEASE_INTRODUCTION_SUBJECT,
].join("\t"));
'
  )"; then
    echo "could not load the protected-main history-repair contract" >&2
    exit 1
  fi
  IFS=$'\t' read -r canonical_bootstrap_sha repair_before_sha introduction_subject <<< "${repair_contract}"

  rewrite_parents="$(git rev-list --parents -n 1 "${head_ref}^{commit}")"
  read -r -a rewrite_commit_and_parents <<< "${rewrite_parents}"
  if [[ "${#rewrite_commit_and_parents[@]}" -ne 2 ]]; then
    echo "protected-main history repair requires an exact one-parent introduction commit" >&2
    exit 1
  fi
  rewrite_parent="${rewrite_commit_and_parents[1]}"

  candidate_bootstrap_sha="$(
    git show "${head_ref}:release-please-config.json" |
      bun -e '
const config = JSON.parse(await Bun.stdin.text());
const value = config?.["bootstrap-sha"];
if (typeof value === "string") process.stdout.write(value);
'
  )"
  candidate_manifest_unreleased="$(
    git show "${head_ref}:.release-please-manifest.json" |
      bun -e '
const manifest = JSON.parse(await Bun.stdin.text());
const versions = manifest && !Array.isArray(manifest) && typeof manifest === "object"
  ? Object.values(manifest)
  : [];
process.stdout.write(String(versions.length > 0 && versions.every((version) => version === "0.0.0")));
'
  )"

  if [[ "${event_name}" != "push" ]] ||
    [[ "${full_ref}" != "refs/heads/main" ]] ||
    [[ "${head_branch}" != "main" ]] ||
    [[ "${base_ref}" != "${repair_before_sha}" ]] ||
    [[ "${subject}" != "${introduction_subject}" ]] ||
    [[ "${rewrite_parent}" != "${canonical_bootstrap_sha}" ]] ||
    [[ "${candidate_bootstrap_sha}" != "${canonical_bootstrap_sha}" ]] ||
    [[ "${candidate_manifest_unreleased}" != "true" ]]; then
    echo "release-intent base ${base_ref} is not an ancestor of ${head_ref}" >&2
    echo "non-fast-forward main updates are allowed only for the exact final introduction repair" >&2
    exit 1
  fi
  echo "authorized final main history repair; comparing ${head_ref} to its exact introduction parent" >&2
  base_ref="${head_ref}^{commit}^"
fi

release_types="$({
  git show "${head_ref}:release-please-config.json" |
    bun -e '
const config = JSON.parse(await Bun.stdin.text());
const sections = config["changelog-sections"];
if (!Array.isArray(sections) || sections.length === 0) {
  console.error("release-please-config.json must define changelog-sections");
  process.exit(1);
}
const types = [...new Set(sections.map((section) => section?.type))];
if (types.some((type) => typeof type !== "string" || !/^[a-z][a-z0-9-]*$/.test(type))) {
  console.error("release-please changelog section types must be conventional lowercase identifiers");
  process.exit(1);
}
console.log(types.join("|"));
'
})"
if [[ -z "${release_types}" ]]; then
  echo "could not derive release-impact types from release-please-config.json" >&2
  exit 1
fi
release_pattern="^((${release_types})(\\([a-z0-9][a-z0-9._/-]*\\))?(!)?|[a-z]+(\\([a-z0-9][a-z0-9._/-]*\\))?!): .+"
release_pr_pattern='^chore\(release\): .+'

is_release_pr=false
is_generated_release_branch=false
if [[ "${head_branch}" == "release-please--branches--main" ]]; then
  is_generated_release_branch=true
fi
if [[ "${subject}" =~ ${release_pr_pattern} ]]; then
  if [[ "${is_generated_release_branch}" == true || "${head_branch}" == "main" ]]; then
    is_release_pr=true
  fi
fi

package_versions_from_ref() {
  local ref="${1:?package_versions_from_ref requires a git ref}"
  local files

  files="$(
    git ls-tree -r --name-only "${ref}" |
      grep -E '(^Cargo.toml$|^src/.*/Cargo.toml$|^tools/xtask/Cargo.toml$)' || true
  )"

  while IFS= read -r file; do
    [[ -z "${file}" ]] && continue
    git show "${ref}:${file}" | awk -v file="${file}" '
    /^\[package\][[:space:]]*$/ {
      in_package = 1
      next
    }
    /^\[/ && in_package {
      exit
    }
    in_package && $0 ~ /^[[:space:]]*name[[:space:]]*=/ {
      name = $0
      sub(/^[^=]*=[[:space:]]*"/, "", name)
      sub(/".*$/, "", name)
    }
    in_package && $0 ~ /^[[:space:]]*version[[:space:]]*=/ {
      line = $0
      sub(/^[^=]*=[[:space:]]*"/, "", line)
      sub(/".*$/, "", line)
      if (name == "") {
        name = file
      }
      print name "=" line
      exit
    }
  '
  done <<< "${files}" | sort
}

base_versions="$(package_versions_from_ref "${base_ref}")"
head_versions="$(package_versions_from_ref "${head_ref}")"
release_manifest_versions_from_ref() {
  local ref="${1:?release_manifest_versions_from_ref requires a git ref}"
  local manifest
  if ! manifest="$(git show "${ref}:.release-please-manifest.json" 2>/dev/null)"; then
    return 0
  fi
  # shellcheck disable=SC2016
  printf '%s\n' "${manifest}" |
    bun -e '
let data;
try {
  data = JSON.parse(await Bun.stdin.text());
} catch {
  process.exit(0);
}
for (const [path, version] of Object.entries(data).sort(([left], [right]) =>
  left < right ? -1 : left > right ? 1 : 0)) {
  console.log(`${path}=${version}`);
}
'
}

base_release_manifest_versions="$(release_manifest_versions_from_ref "${base_ref}")"
head_release_manifest_versions="$(release_manifest_versions_from_ref "${head_ref}")"

if [[ -z "${base_versions}" || -z "${head_versions}" || -z "${head_release_manifest_versions}" ]]; then
  echo "could not read package versions or release-please manifest versions" >&2
  exit 1
fi

changed_existing_versions="$(
  join -t $'\t' \
    <(printf '%s\n' "${base_versions}" | sed 's/=/\t/' | sort -t $'\t' -k1,1) \
    <(printf '%s\n' "${head_versions}" | sed 's/=/\t/' | sort -t $'\t' -k1,1) |
    awk -F '\t' '$2 != $3 { print $1 "=" $2 " -> " $3 }'
)"
if [[ -n "${base_release_manifest_versions}" ]]; then
  changed_existing_release_manifest_versions="$(
    join -t $'\t' \
      <(printf '%s\n' "${base_release_manifest_versions}" | sed 's/=/\t/' | sort -t $'\t' -k1,1) \
      <(printf '%s\n' "${head_release_manifest_versions}" | sed 's/=/\t/' | sort -t $'\t' -k1,1) |
      awk -F '\t' '$2 != $3 { print $1 "=" $2 " -> " $3 }'
  )"
else
  changed_existing_release_manifest_versions=""
fi
if [[ -n "${changed_existing_versions}${changed_existing_release_manifest_versions}" && "${is_release_pr}" != true ]]; then
  cat >&2 <<EOF
This PR changes one or more workspace package versions or release-please
manifest versions.

Package and release-please manifest version bumps are release owned. Run the
Release workflow with prepare-release-pr and merge the generated release PR
instead of changing versions in a feature/fix PR.

Generated release PRs are allowed only from generated release branches, and
their main merge commits are allowed only when the subject starts with
chore(release):.

Received:
  ${subject}

Base package versions:
${base_versions}

Head package versions:
${head_versions}

Changed existing package versions:
${changed_existing_versions}

Base release-please manifest versions:
${base_release_manifest_versions}

Head release-please manifest versions:
${head_release_manifest_versions}

Changed existing release-please manifest versions:
${changed_existing_release_manifest_versions}
EOF
  exit 1
fi

if [[ "${is_release_pr}" == true ]]; then
  base_commit="$(git rev-parse "${base_ref}^{commit}")"
  head_parent="$(git rev-parse "${head_ref}^{commit}^")"
  if [[ "${head_parent}" != "${base_commit}" ]]; then
    echo "generated release commit parent ${head_parent} does not exactly match base ${base_commit}" >&2
    echo "release PRs must contain one normalized release-bump commit directly on the current base" >&2
    exit 1
  fi
  release_products_json="$(
    tools/dev/bun.sh tools/release/verify-release-commit.mjs \
      --derive-products \
      --head-ref "${head_ref}"
  )"
  tools/dev/bun.sh tools/release/verify-release-commit.mjs \
    --products-json "${release_products_json}" \
    --head-ref "${head_ref}"
fi

release_plan="$(tools/dev/bun.sh tools/release/release_plan.mjs --base-ref "${base_ref}" --head-ref "${head_ref}" --format json)"
release_products="$(
  bun -e 'const data = JSON.parse(await Bun.stdin.text()); console.log((data.releaseProducts ?? []).join("\n"));' <<< "${release_plan}"
)"

if [[ -z "${release_products}" ]]; then
  exit 0
fi

if [[ "${subject}" =~ ${release_pattern} ]]; then
  exit 0
fi

if [[ "${is_release_pr}" == true ]]; then
  exit 0
fi

cat >&2 <<EOF
This PR changes release-affecting product surfaces, but its title does not
carry release intent.

Use one of these Conventional Commit types in the PR title:
  ${release_types//|/, }

Breaking changes may use any type with !, for example:
  chore!: remove a deprecated API

Generated release PRs are exempt only from generated release branches, and
their main merge commits are exempt only when the subject starts with
chore(release):.

Docs, README, CI, tests, examples, xtask-only maintenance, source-checkout
scripts, and other repository-only changes can keep non-release types such as
docs:, ci:, chore:, style:, or test: when the product release metadata does not
select a releasable product.

Received:
  ${subject}

Release-affecting products:
EOF

printf '%s\n' "${release_products}" | sed 's/^/  /' >&2
exit 1
