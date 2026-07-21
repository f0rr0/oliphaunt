# oliphaunt-build

`oliphaunt-build` is the Cargo build-script helper for Rust applications that
bundle Oliphaunt runtime artifacts.

Applications add it as a build dependency and call it from `build.rs`:

```rust
fn main() {
    oliphaunt_build::configure();
}
```

Direct application dependencies expose Cargo-resolved runtime, ICU, and
extension artifact manifests through Cargo `links` metadata. `oliphaunt-build`
validates the selected application metadata, copies the already-resolved
artifacts into `OUT_DIR/oliphaunt/resources`, and writes
`OUT_DIR/oliphaunt/oliphaunt-assets.lock`.

For `runtime = "liboliphaunt-wasix"`, root runtime staging includes only the
portable runtime and matching AOT runtime artifacts. If the application enables
the `oliphaunt-wasix` `tools` feature, `oliphaunt-build` also stages the split
`oliphaunt-wasix-tools` and tools-AOT artifacts that provide `pg_dump` and
`psql`. Applications that enable tools indirectly can set
`[package.metadata.oliphaunt] tools = true` to make that intent explicit.

It performs no network I/O, does not mutate `Cargo.toml`, and writes no generated
files outside `OUT_DIR`.
