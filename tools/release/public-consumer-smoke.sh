#!/usr/bin/env bash
set -euo pipefail
set -m
ulimit -Sn "$(ulimit -Hn)"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
tool="$root/tools/release/public-consumer-smoke.mts"
deadline="$(command -v gtimeout || command -v timeout)"
command -v jq >/dev/null

if [ "${1:-}" = --surface ]; then
  scratch="$2"
  ecosystem="$3"
  surface="$scratch/$ecosystem"
  mkdir -p "$surface"
  end="$(jq -r '.deadlineMilliseconds / 1000 | floor' "$scratch/context.json")"
  command_pid=''
  # shellcheck disable=SC2317
  stop_command() {
    if [ -n "$command_pid" ]; then
      kill -TERM -- "-$command_pid" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$command_pid" 2>/dev/null || true
      wait "$command_pid" 2>/dev/null || true
    fi
  }
  trap stop_command EXIT
  trap 'exit 130' INT TERM
  capture() {
    local output="$1" directory="$2" environment="$3" seconds status entry
    shift 3
    seconds=$((end - $(date +%s)))
    [ "$seconds" -gt 0 ] || { echo 'shared public-consumer deadline reached' >&2; return 1; }
    [ "$seconds" -le 240 ] || seconds=240
    local command=("$@")
    if [ -n "$environment" ]; then
      local clean=(env -i)
      while IFS= read -r -d '' entry; do clean+=("$entry"); done < "$environment"
      command=("${clean[@]}" "${command[@]}")
    fi
    (cd "$directory"; exec "$deadline" --kill-after=5s "${seconds}s" "${command[@]}") > "$output" 2> "$surface/command-error" &
    command_pid=$!
    status=0
    wait "$command_pid" || status=$?
    kill -KILL -- "-$command_pid" 2>/dev/null || true
    command_pid=''
    if [ "$status" != 0 ]; then
      tail -c 8192 "$output" >&2
      tail -c 8192 "$surface/command-error" >&2
      return "$status"
    fi
  }
  capture "$surface/stage.log" "$root" '' bash tools/dev/bun.sh "$tool" --stage "$scratch" "$ecosystem"
  environment="$surface/environment"
  case "$ecosystem" in
    cargo)
      for consumer in "$surface"/cargo/entry-*; do
        capture "$consumer/command-output" "$consumer" "$environment" cargo generate-lockfile
      done ;;
    npm)
      for consumer in "$surface"/npm/entry-*; do
        capture "$consumer/command-output" "$consumer" "$environment" npm install --ignore-scripts --no-audit --no-fund --omit=peer --registry=https://registry.npmjs.org/
      done ;;
    maven)
      capture "$surface/gradle-output" "$surface/maven" "$environment" "$root/src/sdks/kotlin/gradlew" --no-daemon --console=plain --project-dir "$surface/maven" resolveOliphauntPublicConsumers ;;
    github)
      git_args=(git -c credential.helper= -c http.extraHeader= --git-dir "$surface/github.git")
      capture "$surface/init.log" "$surface" "$environment" git -c credential.helper= -c http.extraHeader= init --bare "$surface/github.git"
      refs=()
      while IFS= read -r tag; do refs+=("refs/tags/$tag:refs/tags/$tag"); done < <(jq -r '[.plan.github.productTags[].tag, (.plan.github.swift.tag // empty)] | unique[]' "$scratch/context.json")
      repository="$(jq -r '.plan.repositoryUrl' "$scratch/context.json")"
      capture "$surface/fetch.log" "$surface" "$environment" "${git_args[@]}" fetch --no-tags --force "$repository" "${refs[@]}"
      index=0
      while IFS= read -r tag; do
        capture "$surface/tag-$index" "$surface" "$environment" "${git_args[@]}" rev-parse "$tag^{commit}"
        expected="$(jq -r --argjson index "$index" '.plan.github.productTags[$index].commit' "$scratch/context.json")"
        [ "$(cat "$surface/tag-$index")" = "$expected" ] || { echo "public tag $tag differs from the frozen commit" >&2; exit 1; }
        index=$((index + 1))
      done < <(jq -r '.plan.github.productTags[].tag' "$scratch/context.json")
      swift_tag="$(jq -r '.plan.github.swift.tag // empty' "$scratch/context.json")"
      if [ -n "$swift_tag" ]; then
        capture "$surface/swift-commit" "$surface" "$environment" "${git_args[@]}" rev-parse "$swift_tag^{commit}"
        commit="$(cat "$surface/swift-commit")"
        capture "$surface/swift-parents" "$surface" "$environment" "${git_args[@]}" rev-list --parents -n 1 "$commit"
        parent="$(jq -r '.plan.github.swift.parentCommit' "$scratch/context.json")"
        [ "$(cat "$surface/swift-parents")" = "$commit $parent" ] || { echo 'SwiftPM source tag has the wrong parent' >&2; exit 1; }
        mkdir "$surface/swift-source"
        capture "$surface/checkout.log" "$surface" "$environment" "${git_args[@]}" --work-tree "$surface/swift-source" checkout --force "$commit" -- .
        capture "$surface/swift-package.json" "$surface/swift-source" "$surface/swift-environment" swift package dump-package
        capture "$surface/swift-tree" "$surface" "$environment" "${git_args[@]}" rev-parse "$commit^{tree}"
      fi ;;
    *) echo "unknown public consumer surface: $ecosystem" >&2; exit 2 ;;
  esac
  capture "$surface/finish.log" "$root" '' bash tools/dev/bun.sh "$tool" --finish "$scratch" "$ecosystem"
  exit 0
fi

scratch="$(mktemp -d)"
pids=()
# shellcheck disable=SC2317
cleanup() {
  status=$?
  trap - EXIT
  for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  if [ "${#pids[@]}" -gt 0 ]; then sleep 2; fi
  for pid in "${pids[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  if [ "$status" != 0 ]; then
    for log in "$scratch"/*.log; do [ ! -f "$log" ] || tail -c 16384 "$log" >&2; done
  fi
  rm -rf "$scratch"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
bash tools/dev/bun.sh "$tool" --prepare "$scratch" "$@"
# Help does not prepare a run.
[ -f "$scratch/context.json" ] || exit 0
end="$(jq -r '.deadlineMilliseconds / 1000 | floor' "$scratch/context.json")"
while IFS= read -r ecosystem; do
  seconds=$((end - $(date +%s)))
  [ "$seconds" -gt 0 ] || { echo 'shared public-consumer deadline reached' >&2; exit 1; }
  "$deadline" --kill-after=5s "${seconds}s" bash "$root/tools/release/public-consumer-smoke.sh" --surface "$scratch" "$ecosystem" > "$scratch/$ecosystem.log" 2>&1 &
  pids+=("$!")
done < <(jq -r '.plan.surfaces[].ecosystem, "github"' "$scratch/context.json")
while [ "${#pids[@]}" -gt 0 ]; do
  active=()
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then active+=("$pid"); else wait "$pid"; fi
  done
  pids=("${active[@]}")
  [ "${#pids[@]}" = 0 ] || sleep 0.2
done
bash tools/dev/bun.sh "$tool" --report "$scratch"
