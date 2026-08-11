#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="${OLIPHAUNT_REPO_ROOT:-$(cd "$script_dir/../../../.." && pwd)}"
runner="$script_dir/run-ios-broker-simulator.sh"
aggregate_root="$repo_root/target/ios-native-broker-full-matrix"
aggregate_report="$aggregate_root/simulator-matrix.json"
timeout_seconds="${OLIPHAUNT_IOS_BROKER_TIMEOUT_SECONDS:-240}"
prepare_first="${OLIPHAUNT_IOS_BROKER_PREPARE_ARTIFACTS:-YES}"

[ -x "$runner" ] || {
  printf 'error: simulator runner is not executable: %s\n' "$runner" >&2
  exit 1
}
mkdir -p "$aggregate_root"

run_mode() {
  local mode="$1"
  local build_leaf="$2"
  local prepare="$3"
  local reset_storage="$4"
  env \
    OLIPHAUNT_REPO_ROOT="$repo_root" \
    OLIPHAUNT_BROKER_FIXTURE_MODE="$mode" \
    OLIPHAUNT_IOS_BROKER_BUILD_ROOT="target/$build_leaf" \
    OLIPHAUNT_IOS_BROKER_PREPARE_ARTIFACTS="$prepare" \
    OLIPHAUNT_IOS_BROKER_RESET_SIMULATOR_STORAGE="$reset_storage" \
    OLIPHAUNT_IOS_BROKER_TIMEOUT_SECONDS="$timeout_seconds" \
    "$runner"
}

run_mode semantic ios-native-broker-full-matrix/semantic "$prepare_first" YES
run_mode handshakeNegatives ios-native-broker-full-matrix/handshake NO NO
run_mode extendedFaults ios-native-broker-full-matrix/faults NO NO
# A real WorkerCore deadlock may leave an unkillable/reused extension generation.
# Keep it last so it cannot contaminate the recoverable crash matrices.
run_mode hang ios-native-broker-full-matrix/hang NO NO

ruby -rjson - "$aggregate_report" \
  "$aggregate_root/semantic/reports/runner-report.json" \
  "$aggregate_root/handshake/reports/runner-report.json" \
  "$aggregate_root/faults/reports/runner-report.json" \
  "$aggregate_root/hang/reports/runner-report.json" <<'RUBY'
output, *paths = ARGV
reports = paths.map { |path| [path, JSON.parse(File.read(path))] }
expected_modes = %w[semantic handshakeNegatives extendedFaults hang]
actual_modes = reports.map { |_, report| report["fixtureMode"] }
raise "simulator modes differ: #{actual_modes.inspect}" unless actual_modes == expected_modes
reports.each do |path, report|
  raise "simulator lane failed: #{path}" unless report["status"] == "PASS"
end
File.write(output, JSON.pretty_generate({
  schema: "oliphaunt-ios-broker-full-simulator-matrix-v1",
  status: "PASS",
  completedAt: Time.now.utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
  modes: reports.map { |path, report| {
    mode: report.fetch("fixtureMode"),
    report: path,
    appReport: report.fetch("appReport"),
  } },
}) + "\n")
RUBY

printf 'OLIPHAUNT_IOS_BROKER_FULL_SIMULATOR_MATRIX_PASS report=%s\n' \
  "$aggregate_report"
