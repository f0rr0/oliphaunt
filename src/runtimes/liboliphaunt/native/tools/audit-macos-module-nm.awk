# Reject Mach-O modules whose unresolved symbols use the main-executable
# ordinal. Such a bundle may load in postgres itself, but it cannot load in an
# embedding host whose executable does not export PostgreSQL's symbol table.
# Modules with no unresolved PostgreSQL symbols are valid and need not contain
# a "dynamically looked up" entry.
index($0, "(from executable)") {
  invalid = 1
}

END {
  exit invalid ? 1 : 0
}
