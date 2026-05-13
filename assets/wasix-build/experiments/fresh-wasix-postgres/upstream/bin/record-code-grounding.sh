#!/usr/bin/env bash

set -euo pipefail

UPSTREAM_SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRESH_ROOT="$(cd "$UPSTREAM_SOURCE_ROOT/.." && pwd)"
REPO_ROOT="$(cd "$FRESH_ROOT/../../../.." && pwd)"
WASIX_BUILD_ROOT="$REPO_ROOT/assets/wasix-build"
UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$WASIX_BUILD_ROOT/work/upstream}"
WASMER_ROOT="${WASMER_ROOT:-$UPSTREAM_WORK_ROOT/wasmer}"
WASIX_LIBC_ROOT="${WASIX_LIBC_ROOT:-$UPSTREAM_WORK_ROOT/wasix-libc}"
CAPABILITY_FILE="${CAPABILITY_FILE:-$UPSTREAM_SOURCE_ROOT/capabilities.tsv}"
REPORT_DIR="${REPORT_DIR:-$UPSTREAM_WORK_ROOT/reports}"
STRICT=0

usage() {
	cat <<EOF
usage: $0 [--strict]

Records code-grounding evidence for the PostgreSQL/WASIX capability claims.

The report is based on local source checkouts, not public documentation:
  Wasmer:     $WASMER_ROOT
  wasix-libc: $WASIX_LIBC_ROOT
  inventory:  $CAPABILITY_FILE
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--strict)
			STRICT=1
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "unknown argument: $1" >&2
			usage >&2
			exit 2
			;;
	esac
done

mkdir -p "$REPORT_DIR"
report="$REPORT_DIR/code-grounding.md"
missing=0

git_field() {
	local root="$1"
	local field="$2"

	if [ ! -d "$root/.git" ]; then
		printf 'missing checkout'
		return
	fi

	case "$field" in
		head)
			git -C "$root" rev-parse HEAD
			;;
		branch)
			git -C "$root" branch --show-current
			;;
		origin)
			git -C "$root" rev-parse origin/main 2>/dev/null || true
			;;
		status)
			git -C "$root" status --short
			;;
		stat)
			git -C "$root" diff --stat
			;;
	esac
}

resolve_ref() {
	local ref="$1"
	local root
	local rel

	case "$ref" in
		wasmer:*)
			root="$WASMER_ROOT"
			rel="${ref#wasmer:}"
			;;
		wasix-libc:*)
			root="$WASIX_LIBC_ROOT"
			rel="${ref#wasix-libc:}"
			;;
		experiment:*)
			root="$FRESH_ROOT"
			rel="${ref#experiment:}"
			;;
		*)
			printf 'unknown:%s' "$ref"
			return 1
			;;
	esac

	if [ -e "$root/$rel" ]; then
		printf 'ok:%s' "$ref"
		return 0
	fi

	printf 'missing:%s' "$ref"
	return 1
}

append_status_block() {
	local title="$1"
	local content="$2"

	printf '### %s\n\n' "$title" >>"$report"
	if [ -n "$content" ]; then
		printf '```text\n%s\n```\n\n' "$content" >>"$report"
	else
		printf '_clean_\n\n' >>"$report"
	fi
}

{
	printf '# Code-Grounded WASIX Capability Report\n\n'
	printf -- '- Generated: `%s`\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
	printf -- '- Upstream source root: `%s`\n' "$UPSTREAM_SOURCE_ROOT"
	printf -- '- Upstream work root: `%s`\n' "$UPSTREAM_WORK_ROOT"
	printf -- '- Capability inventory: `%s`\n\n' "$CAPABILITY_FILE"
	printf '## Source Checkouts\n\n'
	printf '| Source | Head | origin/main | Branch |\n'
	printf '| --- | --- | --- | --- |\n'
	printf '| Wasmer | `%s` | `%s` | `%s` |\n' \
		"$(git_field "$WASMER_ROOT" head)" \
		"$(git_field "$WASMER_ROOT" origin)" \
		"$(git_field "$WASMER_ROOT" branch)"
	printf '| wasix-libc | `%s` | `%s` | `%s` |\n\n' \
		"$(git_field "$WASIX_LIBC_ROOT" head)" \
		"$(git_field "$WASIX_LIBC_ROOT" origin)" \
		"$(git_field "$WASIX_LIBC_ROOT" branch)"
} >"$report"

append_status_block "Wasmer Working Tree" "$(git_field "$WASMER_ROOT" status)"
append_status_block "Wasmer Patch Stat" "$(git_field "$WASMER_ROOT" stat)"
append_status_block "wasix-libc Working Tree" "$(git_field "$WASIX_LIBC_ROOT" status)"
append_status_block "wasix-libc Patch Stat" "$(git_field "$WASIX_LIBC_ROOT" stat)"

{
	printf '## Capability Ledger\n\n'
	printf '| Capability | Owner | Basis | Path Evidence | Probe | PostgreSQL Behavior | Status |\n'
	printf '| --- | --- | --- | --- | --- | --- | --- |\n'
} >>"$report"

while IFS=$'\t' read -r id owner basis source_paths probe postgres_behavior status; do
	if [ -z "${id:-}" ] || [[ "$id" == \#* ]]; then
		continue
	fi

	path_evidence=""
	IFS=';' read -r -a refs <<<"$source_paths"
	for ref in "${refs[@]}"; do
		result="$(resolve_ref "$ref")" || {
			missing=$((missing + 1))
		}
		if [ -n "$path_evidence" ]; then
			path_evidence="$path_evidence<br>"
		fi
		path_evidence="$path_evidence\`$result\`"
	done

	printf '| `%s` | %s | %s | %s | `%s` | %s | %s |\n' \
		"$id" "$owner" "$basis" "$path_evidence" "$probe" "$postgres_behavior" "$status" >>"$report"
done <"$CAPABILITY_FILE"

{
	printf '\n## Summary\n\n'
	printf -- '- Missing source references: `%s`\n' "$missing"
	printf -- '- Strict mode: `%s`\n' "$STRICT"
} >>"$report"

printf 'wrote %s\n' "$report"

if [ "$STRICT" -eq 1 ] && [ "$missing" -ne 0 ]; then
	exit 1
fi
