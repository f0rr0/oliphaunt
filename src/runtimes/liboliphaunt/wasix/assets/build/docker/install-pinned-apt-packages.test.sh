#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
installer="$script_dir/install-pinned-apt-packages.sh"

fail() {
	echo "install-pinned-apt-packages.test: $*" >&2
	exit 1
}

work_root="$(mktemp -d)"
trap 'rm -rf "$work_root"' EXIT
fake_bin="$work_root/fake-bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/apt-get" <<'APT'
#!/usr/bin/env bash
set -euo pipefail

state_dir="${OLIPHAUNT_FAKE_APT_STATE:?}"
mkdir -p "$state_dir"
call_file="$state_dir/calls"
update_file="$state_dir/updates"
install_file="$state_dir/installs"
call="$(( $(cat "$call_file" 2>/dev/null || echo 0) + 1 ))"
printf '%s\n' "$call" >"$call_file"

operation=""
error_mode=false
for argument in "$@"; do
  case "$argument" in
    update | install) operation="$argument" ;;
    APT::Update::Error-Mode=any) error_mode=true ;;
  esac
done
[ -n "$operation" ] || exit 2
printf 'call=%s operation=%s error_mode=%s args=%s\n' \
  "$call" "$operation" "$error_mode" "$*" >>"${OLIPHAUNT_FAKE_APT_LOG:?}"

if [ "$operation" = update ]; then
  update="$(( $(cat "$update_file" 2>/dev/null || echo 0) + 1 ))"
  printf '%s\n' "$update" >"$update_file"
  case "${OLIPHAUNT_FAKE_APT_MODE:-success}" in
    transient-update)
      [ "$update" -gt 1 ] || exit 100
      ;;
    permanent-update)
      exit 100
      ;;
  esac
  exit 0
fi

install="$(( $(cat "$install_file" 2>/dev/null || echo 0) + 1 ))"
printf '%s\n' "$install" >"$install_file"
if [ "${OLIPHAUNT_FAKE_APT_MODE:-success}" = transient-install ]; then
  [ "$install" -gt 1 ] || exit 100
fi
APT
chmod 0755 "$fake_bin/apt-get"

cat >"$fake_bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
set -euo pipefail
printf 'sleep=%s\n' "$*" >>"${OLIPHAUNT_FAKE_APT_LOG:?}"
SLEEP
chmod 0755 "$fake_bin/sleep"

run_case() {
	local name="$1"
	local mode="$2"
	local seed_ca="${3:-true}"
	local case_root="$work_root/$name"
	mkdir -p "$case_root"
	: >"$case_root/apt.log"
	if [ "$seed_ca" = true ]; then
		mkdir -p "$case_root/certs"
		printf '%s\n' fixture-pinned-snapshot-root >"$case_root/certs/ca-certificates.crt"
	fi
	PATH="$fake_bin:$PATH" \
		OLIPHAUNT_APT_GET="$fake_bin/apt-get" \
		OLIPHAUNT_SLEEP="$fake_bin/sleep" \
		OLIPHAUNT_APT_SOURCES_FILE="$case_root/ubuntu.sources" \
		OLIPHAUNT_APT_LISTS_DIR="$case_root/lists" \
		OLIPHAUNT_CA_BUNDLE="$case_root/certs/ca-certificates.crt" \
		OLIPHAUNT_APT_MAX_ATTEMPTS=3 \
		OLIPHAUNT_APT_RETRY_DELAY_SECONDS=1 \
		OLIPHAUNT_FAKE_APT_MODE="$mode" \
		OLIPHAUNT_FAKE_APT_STATE="$case_root/state" \
		OLIPHAUNT_FAKE_APT_LOG="$case_root/apt.log" \
		"$installer" --snapshot 20260715T000000Z -- bash curl
}

expect_failure() {
	local name="$1"
	local mode="$2"
	local expected="$3"
	local seed_ca="${4:-true}"
	local output
	local status
	set +e
	output="$(run_case "$name" "$mode" "$seed_ca" 2>&1)"
	status=$?
	set -e
	[ "$status" -ne 0 ] || fail "$name unexpectedly succeeded"
	grep -Fq "$expected" <<<"$output" || fail "$name did not report $expected: $output"
}

run_case transient-update transient-update
transient_root="$work_root/transient-update"
sources="$transient_root/ubuntu.sources"
log="$transient_root/apt.log"
for required in \
	'URIs: https://snapshot.ubuntu.com/ubuntu/20260715T000000Z' \
	'Suites: noble noble-updates noble-security' \
	'Components: main universe' \
	'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg'; do
	grep -Fxq "$required" "$sources" || fail "pinned source file is missing $required"
done
if grep -Eq 'backports|restricted|multiverse|archive\.ubuntu\.com|security\.ubuntu\.com' "$sources"; then
	fail "pinned source file retained an unnecessary pocket, component, or mutable mirror"
fi
[ "$(grep -c 'operation=update' "$log")" -eq 2 ] || fail "transient update was not retried as one bounded transaction"
[ "$(grep -c 'operation=install' "$log")" -eq 1 ] || fail "failed update incorrectly ran an install"
[ "$(grep -c 'operation=update.*error_mode=true' "$log")" -eq 2 ] || fail "an update was not fail-closed"
grep -Fq ' install -y --no-install-recommends ca-certificates bash curl' "$log" ||
	fail "builder package install did not include the full CA package and requested dependencies"
[ "$(grep -c '^sleep=' "$log")" -eq 1 ] || fail "transient update used an unexpected retry count"
if grep -vF "Dir::Etc::sourcelist=$transient_root/ubuntu.sources" "$log" | grep -q '^call='; then
	fail "an APT call was not restricted to the generated snapshot source"
fi
if grep -vF 'Dir::Etc::sourceparts=-' "$log" | grep -q '^call='; then
	fail "an APT call allowed additional sourceparts"
fi
if grep -vF "Dir::State::lists=$transient_root/lists" "$log" | grep -q '^call='; then
	fail "an APT call did not use the reset snapshot-list directory"
fi
if grep -vF "Acquire::https::CaInfo=$transient_root/certs/ca-certificates.crt" "$log" | grep -q '^call='; then
	fail "an APT call did not use the verified snapshot TLS root"
fi

run_case transient-install transient-install
install_log="$work_root/transient-install/apt.log"
[ "$(grep -c 'operation=update' "$install_log")" -eq 2 ] || fail "install failure did not repeat its update"
[ "$(grep -c 'operation=install' "$install_log")" -eq 2 ] || fail "install failure did not retry the complete transaction"
[ "$(grep -c '^sleep=' "$install_log")" -eq 1 ] || fail "install failure used an unexpected retry delay"

expect_failure permanent-update permanent-update "builder package transaction failed after 3 attempts"
permanent_log="$work_root/permanent-update/apt.log"
[ "$(grep -c 'operation=update' "$permanent_log")" -eq 3 ] || fail "permanent update failure was not bounded"
if grep -q 'operation=install' "$permanent_log"; then
	fail "permanent update failure reached package installation"
fi
[ "$(grep -c '^sleep=' "$permanent_log")" -eq 2 ] || fail "permanent update failure slept an unexpected number of times"

expect_failure missing-ca success "pinned snapshot TLS root is missing" false
missing_ca_root="$work_root/missing-ca"
[ ! -s "$missing_ca_root/apt.log" ] || fail "missing TLS root reached APT"
[ ! -e "$missing_ca_root/state/calls" ] || fail "missing TLS root invoked APT"

if grep -Fq 'Acquire::https::Verify-Peer=false' "$installer"; then
	fail "installer contains a TLS verification bypass"
fi
if grep -Fq 'Acquire::https::Verify-Peer=false' "$work_root"/*/apt.log; then
	fail "an APT invocation disabled TLS peer verification"
fi

set +e
invalid_output="$(
	OLIPHAUNT_APT_GET="$fake_bin/apt-get" \
		OLIPHAUNT_SLEEP="$fake_bin/sleep" \
		"$installer" --snapshot latest -- bash 2>&1
)"
invalid_status=$?
set -e
[ "$invalid_status" -ne 0 ] || fail "mutable snapshot unexpectedly succeeded"
grep -Fq -- '--snapshot must be a fixed' <<<"$invalid_output" || fail "mutable snapshot diagnostic is missing"

echo "install-pinned-apt-packages.test: pinned TLS, source isolation, bounded full-transaction retries, and fail-closed updates passed"
