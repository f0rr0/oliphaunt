# PostgreSQL WASIX tools

This product packages `pg_dump` and `psql` for the WASIX executor. Its release version is independent of the runtime; each portable archive records the runtime version and PostgreSQL source fingerprint that produced its modules. AOT archives retain the compiler identity and module digests from their producer.

From this directory:

```sh
moon run postgres-tools-wasix:package-portable
moon run postgres-tools-wasix:package-aot
moon run postgres-tools-wasix:build
```

These tasks build the core runtime first, then compile only `pg_dump` and `psql`. Their portable modules live in `target/postgres-tools/wasix/assets`; their AOT task serializes only those two modules into `target/postgres-tools/wasix/aot`. Building the runtime alone does not build these tools or extensions. To package already prepared outputs without rebuilding them:

```sh
bun tools/package-assets.mts --target portable
bun tools/package-assets.mts --target aot
bun tools/package-cargo-artifacts.mts --target portable
```

The AOT command uses the current host, or `AOT_TARGET`. Packaging rejects stale source fingerprints and modified binaries. Release aggregation collects portable and all four platform archives before calling `tools/package-carriers.mts`; a local Cargo packaging check can select only the targets available locally with repeated `--target` arguments.

Archives and Cargo packages go to `target/postgres-tools/wasix` at the repository root. They contain tools and their notices; runtime, extensions, seeds and ICU are separate inputs to applications.

Checkout Cargo carriers use those owner directories automatically. Custom inputs use
`OLIPHAUNT_WASIX_TOOLS_ASSETS_DIR` and `OLIPHAUNT_WASIX_TOOLS_AOT_DIR`; the runtime
SDK asset variables do not redirect tools.
