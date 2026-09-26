# Source map

Start with the execution family, then the role:

| Location | What belongs here |
| --- | --- |
| `native/` | Native PostgreSQL runtime, bindings, broker, tools and SDKs |
| `wasix/` | WASIX guests, browser and Node-API hosts, tools and SDKs |
| `query/` | Rust and TypeScript query/protocol packages used by both families |
| `database-resources/` | Cluster seeds, ICU data and resource contracts |
| `extensions/` | Extension catalog, source recipes, packages and qualification evidence |
| `third-party/` | Shared upstream pins and source acquisition |
| `examples/native/`, `examples/wasix/` | Applications grouped by execution family |
| `test-fixtures/` | Shared semantic fixtures |
| `benchmarks/` | Performance and footprint measurements |
| `docs/` | Public docs and maintainer references |

Each family has `runtime/`, `node-addon/`, `postgres-tools/` and `sdks/`.
Product build and packaging helpers stay beside their source. Repository-wide
development, CI, packaging and release tools live in root `tools/`.

Node.js, Bun and Deno can host the WASIX guest: look under `wasix/` for those
adapters. `wasix/postmaster/` owns the concurrent guest and its executor;
`wasix/runtime/` owns the embedded guest and its portable/AOT artifacts.

See [Source Architecture](docs/architecture/final-product-source-architecture.md)
for the full tree and ownership rules, and the
[WASIX TypeScript architecture](wasix/sdks/ts/ARCHITECTURE.md) for its host boundaries.
