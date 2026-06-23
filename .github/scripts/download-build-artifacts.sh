#!/usr/bin/env bash
set -euo pipefail

workflow="${1:?usage: download-build-artifacts.sh <workflow> <sha> <destination> [--run-id <id>] [--job <name>] --artifact <name> [--artifact <name>...]}"
sha="${2:?usage: download-build-artifacts.sh <workflow> <sha> <destination> [--run-id <id>] [--job <name>] --artifact <name> [--artifact <name>...]}"
destination="${3:?usage: download-build-artifacts.sh <workflow> <sha> <destination> [--run-id <id>] [--job <name>] --artifact <name> [--artifact <name>...]}"
shift 3

artifacts=()
required_job=""
selected_run_id=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      selected_run_id="${2:?--run-id requires a run id}"
      shift 2
      ;;
    --job)
      required_job="${2:?--job requires a name}"
      shift 2
      ;;
    --artifact)
      artifacts+=("${2:?--artifact requires a name}")
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "${#artifacts[@]}" -eq 0 ]]; then
  echo "at least one --artifact is required" >&2
  exit 2
fi

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"

artifact_present() {
  local run_id="$1"
  local artifact="$2"

  local artifact_names
  artifact_names="$(
    gh api "repos/$GH_REPO/actions/runs/$run_id/artifacts?per_page=100" \
      --paginate \
      --jq '.artifacts[].name'
  )" || {
    echo "failed to list artifacts for $workflow run $run_id" >&2
    exit 1
  }
  printf '%s\n' "$artifact_names" |
    grep -Fxq -- "$artifact"
}

merge_checksum_manifest() {
  local existing="$1"
  local incoming="$2"
  python3 - "$existing" "$incoming" <<'PY'
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

existing = Path(sys.argv[1])
incoming = Path(sys.argv[2])
entries: dict[str, str] = {}


def read_manifest(path: Path) -> None:
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            stripped = line.strip()
            if not stripped:
                continue
            parts = stripped.split(None, 1)
            if len(parts) != 2:
                raise SystemExit(f"{path}: invalid checksum line {line_number}: {line.rstrip()}")
            digest, raw_name = parts[0], parts[1].strip()
            if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
                raise SystemExit(f"{path}: invalid checksum digest on line {line_number}: {digest}")
            name = raw_name.removeprefix("./")
            if not name or "/" in name:
                raise SystemExit(f"{path}: invalid checksum asset name on line {line_number}: {raw_name}")
            previous = entries.get(name)
            if previous is not None and previous != digest:
                raise SystemExit(
                    f"{path}: conflicting checksum for {name}: {previous} vs {digest}"
                )
            entries[name] = digest


read_manifest(existing)
read_manifest(incoming)
with tempfile.NamedTemporaryFile(
    "w",
    encoding="utf-8",
    newline="\n",
    dir=str(existing.parent),
    delete=False,
) as handle:
    temp_path = Path(handle.name)
    for name in sorted(entries):
        handle.write(f"{entries[name]}  ./{name}\n")
temp_path.replace(existing)
PY
}

merge_downloaded_artifact() {
  local artifact="$1"
  local source_dir="$2"

  local source
  while IFS= read -r source; do
    [[ -n "$source" ]] || continue
    local relative_path="${source#"$source_dir"/}"
    local target="$destination/$relative_path"
    mkdir -p "$(dirname "$target")"
    if [[ -e "$target" ]]; then
      if [[ -f "$target" ]] && cmp -s "$source" "$target"; then
        continue
      fi
      if [[ -f "$target" && -f "$source" && "$(basename "$target")" == *-release-assets.sha256 ]]; then
        if ! merge_checksum_manifest "$target" "$source"; then
          return 1
        fi
        continue
      fi
      echo "artifact $artifact would overwrite $relative_path with different bytes" >&2
      return 1
    fi
    cp -p "$source" "$target"
  done < <(find "$source_dir" -type f -print | sort)
}

required_job_success() {
  local run_id="$1"
  if [[ -z "$required_job" ]]; then
    return 0
  fi

  local jobs_file
  jobs_file="$(mktemp)"
  if ! gh run view "$run_id" --repo "$GH_REPO" --json jobs > "$jobs_file"; then
    rm -f "$jobs_file"
    return 1
  fi

  local conclusion
  if ! conclusion="$(
    bun -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(Bun.argv[1], "utf8"));
const required = Bun.argv[2] ?? "";
const job = (data.jobs ?? []).find((candidate) => candidate?.name === required);
console.log(job?.conclusion ?? "");
' "$jobs_file" "$required_job"
  )"; then
    rm -f "$jobs_file"
    return 1
  fi
  rm -f "$jobs_file"
  [[ "$conclusion" == "success" ]]
}

run_id="$selected_run_id"
if [[ -n "$run_id" ]]; then
  if ! required_job_success "$run_id"; then
    echo "$workflow run $run_id does not satisfy required job ${required_job:-<none>}" >&2
    exit 1
  fi
  for artifact in "${artifacts[@]}"; do
    if ! artifact_present "$run_id" "$artifact"; then
      echo "$workflow run $run_id is missing required artifact $artifact" >&2
      exit 1
    fi
  done
else
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if ! required_job_success "$candidate"; then
      continue
    fi
    missing=0
    for artifact in "${artifacts[@]}"; do
      if ! artifact_present "$candidate" "$artifact"; then
        missing=1
        break
      fi
    done
    if [[ "$missing" -eq 0 ]]; then
      run_id="$candidate"
      break
    fi
  done < <(
    if [[ -n "$required_job" ]]; then
      gh run list \
        --repo "$GH_REPO" \
        --workflow "$workflow" \
        --commit "$sha" \
        --limit 20 \
        --json databaseId,status,conclusion,event,createdAt \
        --jq '.[].databaseId'
    else
      gh run list \
        --repo "$GH_REPO" \
        --workflow "$workflow" \
        --commit "$sha" \
        --limit 20 \
        --json databaseId,status,conclusion,event,createdAt \
        --jq '.[] | select(.status == "completed" and .conclusion == "success") | .databaseId'
    fi
  )
fi

if [[ -z "$run_id" ]]; then
  echo "no $workflow workflow run found for $sha with required job/artifacts: ${required_job:-<workflow-success>} / ${artifacts[*]}" >&2
  exit 1
fi

mkdir -p "$destination"
for artifact in "${artifacts[@]}"; do
  echo "Downloading $workflow artifact $artifact from run $run_id"
  artifact_dir="$(mktemp -d)"
  if ! gh run download "$run_id" \
    --repo "$GH_REPO" \
    --name "$artifact" \
    --dir "$artifact_dir"; then
    rm -rf "$artifact_dir"
    exit 1
  fi
  if ! merge_downloaded_artifact "$artifact" "$artifact_dir"; then
    rm -rf "$artifact_dir"
    exit 1
  fi
  rm -rf "$artifact_dir"
done
