#!/usr/bin/env bash
set -euo pipefail

subject="${1:-}"
base_ref="${2:-origin/main}"
head_ref="${3:-HEAD}"
head_branch="${4:-}"

if [[ -z "${subject}" ]]; then
  echo "expected a non-empty PR title or commit subject" >&2
  exit 1
fi

release_pattern='^((feat|fix|perf|refactor|revert)(\([a-z0-9][a-z0-9._/-]*\))?(!)?|[a-z]+(\([a-z0-9][a-z0-9._/-]*\))?!): .+'
release_pr_pattern='^chore\(release\): .+'

is_release_pr=false
is_generated_release_branch=false
case "${head_branch}" in
  release/* | release-please--branches--*)
    is_generated_release_branch=true
    ;;
esac
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
  printf '%s\n' "${manifest}" |
    bun -e '
let data;
try {
  data = JSON.parse(await Bun.stdin.text());
} catch {
  process.exit(0);
}
for (const [path, version] of Object.entries(data).sort(([left], [right]) => left.localeCompare(right))) {
  console.log(`${path}=${version}`);
}
'
}

allowed_bootstrap_release_manifest_seed() {
  local change="${1:?allowed_bootstrap_release_manifest_seed requires a change row}"
  [[ "${change}" == "src/sdks/swift=0.0.0 -> 0.5.0" ]]
}

filter_release_manifest_changes() {
  local mode="${1:?filter_release_manifest_changes requires allow or deny}"
  local change
  while IFS= read -r change; do
    [[ -z "${change}" ]] && continue
    if allowed_bootstrap_release_manifest_seed "${change}"; then
      [[ "${mode}" == "allow" ]] && printf '%s\n' "${change}"
    else
      [[ "${mode}" == "deny" ]] && printf '%s\n' "${change}"
    fi
  done
  return 0
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
allowed_bootstrap_release_manifest_versions="$(
  filter_release_manifest_changes allow <<< "${changed_existing_release_manifest_versions}"
)"
disallowed_changed_existing_release_manifest_versions="$(
  filter_release_manifest_changes deny <<< "${changed_existing_release_manifest_versions}"
)"

if [[ -n "${changed_existing_versions}${disallowed_changed_existing_release_manifest_versions}" && "${is_release_pr}" != true ]]; then
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
${disallowed_changed_existing_release_manifest_versions}

Allowed bootstrap release-please manifest seed changes:
${allowed_bootstrap_release_manifest_versions}
EOF
  exit 1
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
  feat, fix, perf, refactor, revert

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
