# Benchmarks

Benchmark definitions and reports belong here.

The long-term benchmark matrix should compare:

- native PostgreSQL control;
- `libpglite` direct mode;
- `libpglite-oxide` direct, broker, and server modes;
- the existing WASIX `pglite-oxide` release lane;
- SQLite baselines for comparable embedded workloads.

Tooling may live in `tools/` when it is an executable harness, but benchmark
plans, datasets, and published reports should live here.
