#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  exit 0
fi

disabled_any=0
for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [ -f "$file" ] || continue
  if ! grep -Eq 'packages[.]microsoft[.]com|dl[.]google[.]com/linux/chrome(-stable)?/deb' "$file"; then
    continue
  fi

  disabled_any=1
  if [ "$file" = "/etc/apt/sources.list" ]; then
    sudo sed -E -i.bak '/packages[.]microsoft[.]com|dl[.]google[.]com\/linux\/chrome(-stable)?\/deb/s/^/# disabled by oliphaunt CI: /' "$file"
  else
    sudo mv "$file" "$file.disabled"
  fi
done

if [ "$disabled_any" = "1" ]; then
  echo "Disabled unrelated preinstalled Microsoft and Chrome apt sources before apt-get update"
fi
