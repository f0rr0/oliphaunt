# Rust sync-versus-async API diagnostic

This harness measures the incremental public-call path for Oliphaunt's Rust
`sync` and `async` APIs. It supports both native liboliphaunt and WASIX, runs
each API model in a separate process, warms the database before sampling, and
reports open and close separately from the measured operations.

The output is **diagnostic only**. It is not release evidence, has no baseline
or threshold, and is deliberately absent from the release performance matrix.
It answers a narrow question: what overhead does the async admission, owner
queue, wakeup, and reply path add to one sequential call on this machine? It
does not measure concurrent throughput or imply that the runtime and API model
use the same execution owner.

Run a paired diagnostic with:

```sh
bash tools/perf/rust-api-model/run.sh --runtime native
bash tools/perf/rust-api-model/run.sh --runtime wasix
```

Optional arguments are `--iterations N`, `--warmup N`, `--run-id ID`, and
`--output-dir DIR`. Native runs require the normal native runtime artifacts.
WASIX runs require the portable and host-AOT artifacts. The script performs the
same repository runtime preflight used by the product smoke tests.

The output directory contains the two raw run documents, `summary.json`, and a
human-readable `report.md`. Every document identifies the runtime, API model,
calling contract, execution owner, queue model, and `diagnostic-only`
classification.

The corresponding Moon tasks are intentionally non-release tasks:

```sh
moon run perf-tools:rust-api-model-check
moon run perf-tools:rust-api-model-native
moon run perf-tools:rust-api-model-wasix
```

The native and WASIX measured tasks build their required runtime artifact
dependency and are disabled in ordinary CI. Run several fresh pairs before
drawing conclusions from small latency differences; scheduler and filesystem
noise can dominate a single local pair.
