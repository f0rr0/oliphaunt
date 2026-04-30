# Development

Run the local gates before opening a PR:

```sh
scripts/validate.sh ci
scripts/validate.sh release
cargo deny check
```

The hook split is intentionally small:

- pre-commit: file hygiene and formatting
- pre-push: whitespace diff check, `cargo clippy --all-targets`, and
  `cargo test --all-targets`
- CI/release: the hook checks plus no-default build, doctests, Tauri example,
  frontend build, workflow linting, feature powerset, public API compatibility,
  crate packaging, publish dry-run, and supply-chain policy

Install local hooks and the supply-chain gate when needed:

```sh
scripts/install-hooks.sh
cargo install cargo-deny --locked
```

`tests/runtime_smoke.rs` starts the real WASM backend and is intentionally
slower than the protocol unit tests.

## Maintenance Utilities

The repository includes maintenance commands:

- `pglite-dump` is the logical dump CLI entry point.
- `pglite-proxy` exposes a local PostgreSQL socket backed by the embedded
  runtime.
- the bundled prepopulated PGDATA template is maintained by the asset pipeline;
  local fresh-template generation depends on the future split WASIX `initdb`
  runner.

Asset and source checks:

```sh
cargo run -p xtask -- assets check --strict-local
cargo run -p xtask -- assets check --strict-generated
cargo run -p xtask -- assets source-spine --check-patch-applies
cargo run -p xtask -- assets audit-upstream --strict
cargo run -p xtask -- package-size --enforce
```

Release process details are tracked in [RELEASE.md](RELEASE.md).
Completed implementation work is summarized in [DONE.md](DONE.md), and the
implementation backlog is tracked in [TODO.md](TODO.md).
