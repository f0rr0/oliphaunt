# Benchmarks

Benchmark definitions, workload specs, baselines, and intentionally promoted
reports belong here. Executable benchmark harnesses stay under `tools/perf`.

The long-term benchmark matrix should compare:

- native PostgreSQL control;
- `liboliphaunt` direct mode;
- `oliphaunt` direct, broker, and server modes;
- SQLite baselines for comparable embedded workloads.

The native `oliphaunt` matrix in
`tools/perf/matrix/run_native_oliphaunt_matrix.sh` now includes direct, broker,
server, native PostgreSQL, SQLite, streaming, direct/broker/server
prepared-update, native PostgreSQL prepared-update, resource, and artifact-size
rows. RTT report rows include p50/p90/p95/p99 tail latency. Prepared-update
report rows include fresh-process p50/p90/p95, native-PostgreSQL p90 ratios,
and command-level CPU/RSS/footprint.

Current layout:

- `native/sql/`: fixed SQL workloads used by native direct, broker, server,
  native PostgreSQL, and SQLite comparison suites.
- `native/baselines/`: committed native baselines when promoted as release
  evidence.
- `wasix/`: WASIX benchmark specs and baselines.
- `mobile/`: mobile benchmark specs and baselines.
- `reports/`: published reports promoted as release evidence.

Tooling may live in `tools/` when it is an executable harness, but benchmark
plans, datasets, baselines, and published reports live here.
