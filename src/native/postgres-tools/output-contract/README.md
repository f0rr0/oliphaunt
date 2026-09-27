# PostgreSQL tool output contract

The convenience `pg_dump` and `psql` APIs return complete in-memory output.
Every Native and WASIX implementation therefore applies the same aggregate
64 MiB budget to stdout plus stderr for one process.

Implementations preserve exact bytes below the limit. If either stream would
take the aggregate above the limit, the invocation fails without returning a
partial dump, even if the child or guest later exits successfully. Producers
must continue to drain or terminate the process without accumulating further
output so the limit itself cannot deadlock the tool.

This bound is a resource-safety contract for the in-memory convenience API,
not a maximum valid PostgreSQL dump size. A streaming or caller-provided sink
API is required before larger output can be supported without an equivalent
memory allocation.
