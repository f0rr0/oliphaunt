# First input: `nm -gU` output for liboliphaunt (defined engine symbols).
# Second input: `nm -m` output for one packaged extension module.
# Reject a module import that names an engine export but is bound to another
# Mach-O provider. Such two-level bindings bypass liboliphaunt even when it is
# process-global. Also reject the legacy PostgreSQL dynahash binary names: after
# the Apple-only source namespace patch, any such import proves a callsite was
# not rebuilt against Oliphaunt's patched PostgreSQL headers.
BEGIN {
  legacy_engine_symbol["_hash_create"] = 1
  legacy_engine_symbol["_hash_destroy"] = 1
  legacy_engine_symbol["_hash_search"] = 1
}

FNR == NR {
  if (NF > 0) {
    engine_symbol[$NF] = 1
    if (require_namespaced_dynahash && legacy_engine_symbol[$NF]) {
      print "legacy dynahash engine export " $NF > "/dev/stderr"
      invalid = 1
    }
  }
  next
}

index($0, "(undefined)") && index($0, " external ") {
  symbol = $0
  sub(/^.* external /, "", symbol)
  sub(/ \(.*/, "", symbol)
  if (legacy_engine_symbol[symbol]) {
    print symbol " " $0 > "/dev/stderr"
    invalid = 1
  } else if (index($0, " (dynamically looked up)") && !engine_symbol[symbol]) {
    print symbol " " $0 > "/dev/stderr"
    invalid = 1
  } else if (index($0, " (from ") && engine_symbol[symbol]) {
    provider = $0
    sub(/^.* \(from /, "", provider)
    sub(/\).*$/, "", provider)
    if (allowed_engine_provider == "" || provider != allowed_engine_provider) {
      print symbol " " $0 > "/dev/stderr"
      invalid = 1
    }
  }
}

END {
  if (require_namespaced_dynahash) {
    required_engine_symbol["_oliphaunt_pg_hash_create"] = 1
    required_engine_symbol["_oliphaunt_pg_hash_destroy"] = 1
    required_engine_symbol["_oliphaunt_pg_hash_search"] = 1
    for (symbol in required_engine_symbol) {
      if (!engine_symbol[symbol]) {
        print "missing namespaced dynahash engine export " symbol > "/dev/stderr"
        invalid = 1
      }
    }
  }
  exit invalid ? 1 : 0
}
