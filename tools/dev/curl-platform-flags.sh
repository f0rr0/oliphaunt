#!/usr/bin/env sh

# Print the one curl TLS flag that is specific to the active host, or print
# nothing when curl's portable defaults are sufficient. This is sourced by
# bootstrap scripts that cannot depend on Bun because they may be installing it.
oliphaunt_curl_platform_tls_flag() {
  case "${RUNNER_OS:-}" in
    Windows)
      printf '%s\n' '--ssl-revoke-best-effort'
      return 0
      ;;
    Linux | macOS)
      return 0
      ;;
  esac

  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) printf '%s\n' '--ssl-revoke-best-effort' ;;
  esac
}
