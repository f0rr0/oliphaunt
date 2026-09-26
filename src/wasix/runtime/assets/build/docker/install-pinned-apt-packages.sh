#!/usr/bin/env sh
set -eu

export LC_ALL=C

fail() {
	echo "install-pinned-apt-packages: $*" >&2
	exit 1
}

usage() {
	cat >&2 <<'USAGE'
usage: install-pinned-apt-packages.sh --snapshot YYYYMMDDTHHMMSSZ -- PACKAGE...

Installs the WASIX builder dependencies from one immutable Ubuntu snapshot.
Every APT update is fail-closed and the complete update/install transaction is
retried without falling back to a mutable package source.
USAGE
	exit "${1:-2}"
}

snapshot=""
while [ "$#" -gt 0 ]; do
	case "$1" in
	--snapshot)
		[ "$#" -ge 2 ] || usage
		snapshot="$2"
		shift 2
		;;
	--)
		shift
		break
		;;
	--help | -h)
		usage 0
		;;
	*)
		usage
		;;
	esac
done

case "$snapshot" in
[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
*) fail "--snapshot must be a fixed YYYYMMDDTHHMMSSZ timestamp" ;;
esac
[ "$#" -gt 0 ] || fail "at least one package is required"
for package in "$@"; do
	case "$package" in
	"" | [!a-z0-9]* | *[!a-z0-9+.-]*) fail "invalid package name: ${package:-<empty>}" ;;
	esac
done

apt_get="${OLIPHAUNT_APT_GET:-apt-get}"
sleep_command="${OLIPHAUNT_SLEEP:-sleep}"
sources_file="${OLIPHAUNT_APT_SOURCES_FILE:-/etc/apt/sources.list.d/ubuntu.sources}"
lists_dir="${OLIPHAUNT_APT_LISTS_DIR:-/var/lib/apt/lists}"
ca_bundle="${OLIPHAUNT_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
max_attempts="${OLIPHAUNT_APT_MAX_ATTEMPTS:-4}"
retry_delay="${OLIPHAUNT_APT_RETRY_DELAY_SECONDS:-5}"

case "$max_attempts" in
"" | *[!0-9]*) fail "OLIPHAUNT_APT_MAX_ATTEMPTS must be an integer from 1 to 10" ;;
esac
if [ "$max_attempts" -lt 1 ] || [ "$max_attempts" -gt 10 ]; then
	fail "OLIPHAUNT_APT_MAX_ATTEMPTS must be an integer from 1 to 10"
fi
case "$retry_delay" in
"" | *[!0-9]*) fail "OLIPHAUNT_APT_RETRY_DELAY_SECONDS must be an integer from 0 to 60" ;;
esac
[ "$retry_delay" -le 60 ] ||
	fail "OLIPHAUNT_APT_RETRY_DELAY_SECONDS must be an integer from 0 to 60"
for required_path in "$sources_file" "$lists_dir" "$ca_bundle"; do
	case "$required_path" in
	/*) ;;
	*) fail "APT bootstrap paths must be absolute: $required_path" ;;
	esac
done
[ "$lists_dir" != "/" ] || fail "refusing to use / as the APT lists directory"
command -v "$apt_get" >/dev/null 2>&1 || fail "missing APT command: $apt_get"
command -v "$sleep_command" >/dev/null 2>&1 || fail "missing sleep command: $sleep_command"

mkdir -p "$(dirname "$sources_file")"
cat >"$sources_file" <<SOURCES
Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/$snapshot
Suites: noble noble-updates noble-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES

reset_lists() {
	mkdir -p "$lists_dir"
	rm -rf "${lists_dir:?}"/* "${lists_dir:?}"/.[!.]* "${lists_dir:?}"/..?*
	mkdir -p "$lists_dir/partial"
}

apt_update() {
	"$apt_get" \
		-o Dir::Etc::sourcelist="$sources_file" \
		-o Dir::Etc::sourceparts=- \
		-o Dir::State::lists="$lists_dir" \
		-o Acquire::https::CaInfo="$ca_bundle" \
		-o APT::Update::Error-Mode=any \
		-o Acquire::Languages=none \
		-o Acquire::Retries=4 \
		-o Acquire::http::Timeout=30 \
		-o Acquire::https::Timeout=30 \
		update
}

apt_install() {
	"$apt_get" \
		-o Dir::Etc::sourcelist="$sources_file" \
		-o Dir::Etc::sourceparts=- \
		-o Dir::State::lists="$lists_dir" \
		-o Acquire::https::CaInfo="$ca_bundle" \
		-o Acquire::Languages=none \
		-o Acquire::Retries=4 \
		-o Acquire::http::Timeout=30 \
		-o Acquire::https::Timeout=30 \
		install -y --no-install-recommends "$@"
}

install_transaction() {
	label="$1"
	shift
	attempt=1
	while [ "$attempt" -le "$max_attempts" ]; do
		reset_lists
		if apt_update && apt_install "$@"; then
			return 0
		fi
		if [ "$attempt" -eq "$max_attempts" ]; then
			break
		fi
		delay=$((retry_delay * attempt))
		echo "install-pinned-apt-packages: retrying $label transaction after attempt $attempt/$max_attempts" >&2
		"$sleep_command" "$delay"
		attempt=$((attempt + 1))
	done
	fail "$label transaction failed after $max_attempts attempts"
}

# The pinned builder copies and verifies the snapshot service's root CA before
# invoking this helper. Install Ubuntu's full CA package in the same immutable
# transaction as the builder dependencies; every network request verifies TLS.
[ -s "$ca_bundle" ] || fail "pinned snapshot TLS root is missing: $ca_bundle"
install_transaction "builder package" ca-certificates "$@"
reset_lists
