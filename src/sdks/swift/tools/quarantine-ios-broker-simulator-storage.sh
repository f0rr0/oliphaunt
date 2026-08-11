#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

safe_bundle_identifier() {
  case "$1" in
    ''|*[!A-Za-z0-9.-]*) return 1 ;;
    *) return 0 ;;
  esac
}

safe_process_name() {
  case "$1" in
    ''|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}

write_refusal() {
  local reason="$1"
  local detail="${2:-}"
  {
    printf 'status=refused\n'
    printf 'reason=%s\n' "$reason"
    [ -z "$detail" ] || printf 'detail=%s\n' "$detail"
  } >"$report_path"
}

if [ "$#" -ne 8 ]; then
  fail "usage: $0 UDID HOST_BUNDLE_ID EXTENSION_BUNDLE_ID APP_PRODUCT HOST_EXECUTABLE EXTENSION_PRODUCT EXTENSION_EXECUTABLE REPORT"
fi

selected_udid="$1"
app_bundle_id="$2"
extension_bundle_id="$3"
app_product_name="$4"
host_executable="$5"
extension_product_name="$6"
extension_executable="$7"
report_path="${8:-}"

case "$selected_udid" in
  ''|*[!A-Fa-f0-9-]*) fail "unsafe simulator UDID" ;;
esac
safe_bundle_identifier "$app_bundle_id" || fail "unsafe host bundle identifier"
safe_bundle_identifier "$extension_bundle_id" || fail "unsafe extension bundle identifier"
safe_process_name "$app_product_name" || fail "unsafe host product name"
safe_process_name "$host_executable" || fail "unsafe host executable name"
safe_process_name "$extension_product_name" || fail "unsafe extension product name"
safe_process_name "$extension_executable" || fail "unsafe extension executable name"
[ -n "$report_path" ] || fail "storage quarantine report path is empty"
mkdir -p "$(dirname "$report_path")"
: >"$report_path"

for command_name in ps ruby sleep xcrun; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

process_wait_attempts="${OLIPHAUNT_IOS_BROKER_QUARANTINE_PROCESS_WAIT_ATTEMPTS:-50}"
case "$process_wait_attempts" in
  ''|*[!0-9]*) fail "quarantine process wait attempts must be a positive integer" ;;
esac
[ "$process_wait_attempts" -gt 0 ] || \
  fail "quarantine process wait attempts must be positive"
[ "$process_wait_attempts" -ge 3 ] || \
  fail "quarantine process wait attempts must be at least three"

simulator_data_root="$(
  xcrun simctl getenv "$selected_udid" SIMULATOR_SHARED_RESOURCES_DIRECTORY 2>/dev/null || true
)"
if [ -z "$simulator_data_root" ]; then
  write_refusal "data-root-unavailable"
  fail "selected simulator data root is unavailable"
fi

target_processes() {
  local snapshot matches
  if ! snapshot="$(ps -axo pid=,command= 2>/dev/null)"; then
    write_refusal "process-list-unavailable"
    fail "could not inspect simulator target processes"
  fi
  matches="$(printf '%s\n' "$snapshot" | \
    OLIPHAUNT_QUARANTINE_DATA_ROOT="$simulator_data_root" \
    OLIPHAUNT_QUARANTINE_APP_PRODUCT="$app_product_name" \
    OLIPHAUNT_QUARANTINE_HOST_EXECUTABLE="$host_executable" \
    OLIPHAUNT_QUARANTINE_EXTENSION_PRODUCT="$extension_product_name" \
    OLIPHAUNT_QUARANTINE_EXTENSION_EXECUTABLE="$extension_executable" \
    ruby -e '
data_root = ENV.fetch("OLIPHAUNT_QUARANTINE_DATA_ROOT")
app_product = ENV.fetch("OLIPHAUNT_QUARANTINE_APP_PRODUCT")
host_executable = ENV.fetch("OLIPHAUNT_QUARANTINE_HOST_EXECUTABLE")
extension_product = ENV.fetch("OLIPHAUNT_QUARANTINE_EXTENSION_PRODUCT")
extension_executable = ENV.fetch("OLIPHAUNT_QUARANTINE_EXTENSION_EXECUTABLE")

bundle_root = "#{data_root}/Containers/Bundle/Application/"
host_needle = "/#{app_product}.app/#{host_executable}"
extension_needle =
  "/#{app_product}.app/Extensions/#{extension_product}.appex/#{extension_executable}"

def contains_executable?(command, needle)
  offset = command.index(needle)
  return false unless offset

  boundary = offset + needle.bytesize
  boundary == command.bytesize || command.getbyte(boundary) == 0x20
end

STDIN.each_line do |line|
  line.chomp!
  match = line.match(/\A\s*(\d+)\s+(.+)\z/)
  next unless match

  pid = match[1]
  command = match[2]
  next unless command.start_with?(bundle_root)

  if contains_executable?(command, extension_needle)
    puts "extension:#{pid}"
  elsif contains_executable?(command, host_needle)
    puts "host:#{pid}"
  end
end
'
  )"
  printf '%s' "$matches"
}

wait_for_target_processes_to_exit() {
  local attempt matches quiet_observations=0
  for ((attempt = 1; attempt <= process_wait_attempts; attempt++)); do
    matches="$(target_processes)"
    if [ -z "$matches" ]; then
      quiet_observations=$((quiet_observations + 1))
      if [ "$quiet_observations" -ge 3 ]; then
        return 0
      fi
    else
      quiet_observations=0
    fi
    if [ "$attempt" -lt "$process_wait_attempts" ]; then
      sleep 0.1
    fi
  done

  matches="$(target_processes)"
  write_refusal "active-target-processes" "$(printf '%s' "$matches" | tr '\n' ',')"
  fail "target host or extension process remained active"
}

# A missing/not-running target is expected, so command status is not evidence.
# The bounded process snapshots below are the authoritative termination check.
xcrun simctl terminate "$selected_udid" "$app_bundle_id" >/dev/null 2>&1 || true
xcrun simctl terminate "$selected_udid" "$extension_bundle_id" >/dev/null 2>&1 || true
wait_for_target_processes_to_exit
xcrun simctl uninstall "$selected_udid" "$app_bundle_id" >/dev/null 2>&1 || true
xcrun simctl terminate "$selected_udid" "$extension_bundle_id" >/dev/null 2>&1 || true
wait_for_target_processes_to_exit

if ! ruby -rjson -rdigest -rsecurerandom -rtime \
  - "$selected_udid" "$simulator_data_root" "$report_path" <<'RUBY'
udid, data_root, report_path = ARGV
stale_digest = "ios-native-broker-spike-v1"
current_digest = "ios-native-broker-spike-v2-restricted-role"

def write_report(path, values)
  temporary = "#{path}.tmp-#{Process.pid}-#{SecureRandom.hex(4)}"
  File.open(temporary, "wb", 0o600) do |file|
    values.each { |key, value| file.write("#{key}=#{value}\n") }
  end
  File.rename(temporary, path)
ensure
  File.unlink(temporary) if defined?(temporary) && File.exist?(temporary)
end

def refuse(report_path, reason)
  write_report(report_path, status: "refused", reason: reason)
  warn "error: simulator storage quarantine refused: #{reason}"
  exit 1
end

def no_symlink_ancestry?(path)
  return false unless path.start_with?("/") && File.expand_path(path) == path

  cursor = "/"
  path.split("/").reject(&:empty?).each do |component|
    cursor = File.join(cursor, component)
    begin
      stat = File.lstat(cursor)
    rescue Errno::ENOENT
      break
    end
    return false if stat.symlink?
  end
  true
end

unless no_symlink_ancestry?(data_root) && File.directory?(data_root)
  refuse(report_path, "unsafe-data-root")
end

begin
  canonical_data_root = File.realpath(data_root)
rescue SystemCallError
  refuse(report_path, "unsafe-data-root")
end
unless canonical_data_root == data_root
  refuse(report_path, "unsafe-data-root")
end
components = canonical_data_root.split("/").reject(&:empty?)
unless components.last(4) == ["CoreSimulator", "Devices", udid, "data"]
  refuse(report_path, "unexpected-data-root")
end

root = File.join(canonical_data_root, "Library", "Application Support", "Oliphaunt", "default")
unless no_symlink_ancestry?(root)
  refuse(report_path, "unsafe-broker-root")
end
unless File.exist?(root)
  write_report(report_path, status: "absent", root: "default")
  exit 0
end
unless File.directory?(root) && File.realpath(root) == root
  refuse(report_path, "unsafe-broker-root")
end

parent = File.dirname(root)
lock_suffix = Digest::SHA256.hexdigest(root)[0, 32]
lock_path = File.join(parent, ".oliphaunt-root-#{lock_suffix}.lock")

File.open(lock_path, File::RDWR | File::CREAT, 0o600) do |lock|
  unless lock.flock(File::LOCK_EX | File::LOCK_NB)
    refuse(report_path, "root-lock-busy")
  end

  begin
    root_stat = File.lstat(root)
    manifest = JSON.parse(File.binread(File.join(root, "manifest.json")))
    pg_version = File.binread(File.join(root, "pgdata", "PG_VERSION")).strip
  rescue JSON::ParserError, SystemCallError
    refuse(report_path, "unrecognized-manifest")
  end

  expected_common = {
    "formatVersion" => 1,
    "cABIVersion" => 6,
    "liboliphauntVersion" => "0.1.1",
    "postgresMajorVersion" => 18,
    "selectedPostgresExtensions" => ["pg_trgm", "vector"],
    "dataProtectionPolicy" => "completeUntilFirstUserAuthentication",
  }
  common_matches = expected_common.all? { |key, value| manifest[key] == value }
  root_uuid = manifest["rootUUID"]
  common_matches &&= root_uuid.is_a?(String) && root_uuid.match?(
    /\A[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\z/
  )
  common_matches &&= pg_version == "18"
  refuse(report_path, "unrecognized-manifest") unless common_matches

  digest = manifest["startupConfigurationDigest"]
  if digest == current_digest
    write_report(
      report_path,
      status: "retained-current",
      root: "default",
      startupConfigurationDigest: current_digest
    )
    exit 0
  end
  refuse(report_path, "unrecognized-manifest") unless digest == stale_digest

  current_stat = File.lstat(root)
  unless current_stat.dev == root_stat.dev && current_stat.ino == root_stat.ino
    refuse(report_path, "broker-root-changed")
  end

  quarantine_leaf =
    ".oliphaunt-quarantine-default-#{Time.now.utc.strftime("%Y%m%dT%H%M%SZ")}-" \
    "#{Process.pid}-#{SecureRandom.hex(4)}"
  quarantine = File.join(parent, quarantine_leaf)
  refuse(report_path, "quarantine-collision") if File.exist?(quarantine)
  File.rename(root, quarantine)
  write_report(
    report_path,
    status: "quarantined",
    root: "default",
    startupConfigurationDigest: stale_digest,
    quarantineLeaf: quarantine_leaf
  )
end
RUBY
then
  fail "simulator storage quarantine validation failed"
fi
