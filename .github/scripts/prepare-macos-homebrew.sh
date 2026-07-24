#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

command -v brew >/dev/null 2>&1 || {
  echo "prepare-macos-homebrew.sh: Homebrew is not installed" >&2
  exit 1
}

# GitHub's macOS image currently carries this third-party tap even though
# Oliphaunt does not consume it. Homebrew's tap-trust policy reports every
# formula lookup as a workflow warning while the untrusted tap remains.
# Removing an unused runner-owned tap preserves the trust policy instead of
# disabling it or broadly trusting current and future tap contents.
if brew tap | grep -Fxq 'aws/tap'; then
  HOMEBREW_NO_AUTO_UPDATE=1 brew untap aws/tap
fi
