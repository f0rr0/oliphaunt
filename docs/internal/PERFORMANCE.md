# Performance Internals

This page is the maintainer entry point for performance evidence. Public
benchmark guidance lives in
[`src/docs/content/reference/performance.mdx`](../../src/docs/content/reference/performance.mdx);
the executable harnesses and retained reports under `tools/perf/` and
`benchmarks/` are authoritative.

## Measurement rules

- Compare native direct, broker, and server with the appropriate PostgreSQL
  control under the same workload.
- Treat focused or quick runs as diagnostics. Release claims require the full
  reproducible matrix and retained provenance.
- Record concrete PostgreSQL startup GUCs, runtime artifacts, source revision,
  host, and workload parameters with every result.
- Measure cold and warm open, query latency distributions, transaction and bulk
  throughput, large-result transfer, backup/restore, CPU, RSS, and packaged
  artifact size where relevant.
- Keep one variable changed at a time. Do not encode benchmark tuning as public
  SDK profiles or modes.

## Footprint experiments

Native and mobile footprint experiments use explicit PostgreSQL startup GUCs.
Current comparisons may sweep `shared_buffers`, work memory, and
`max_wal_size`; the report must state their exact values. Experiments below the
minimum WAL size for a 16 MB WAL-segment cluster require a separately generated
template with an explicit `initdb --wal-segsize` value, which must also be
recorded.

WASIX performance work may use packaged AOT artifacts, runtime/template caches,
and instrumented guest builds. Instrumentation and cache controls are
maintainer-only diagnostics, not public database APIs.

## Qualification

Use the repository performance matrix and evidence checkers documented in
[`docs/maintainers/performance-evidence.md`](../maintainers/performance-evidence.md).
Do not copy historical numbers or API names into current claims; regenerate
evidence from the exact candidate revision.
