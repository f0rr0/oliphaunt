# WASIX Postmaster Third-Party Sources

These pins reproduce the host runtime used by the concurrent PostgreSQL/WASIX
postmaster experiment. They are intentionally separate from the stock WASIX
runtime source domain: applying the postmaster runtime patches must not alter
the existing `liboliphaunt-wasix` product.

The hardened source fetcher materializes clean, immutable checkouts under
`target/oliphaunt-sources/checkouts/`. Project scripts copy those inputs into
disposable worktrees under `target/oliphaunt-wasix-postmaster/` before applying
patches. The durable source checkouts are never patched in place.

Wasmer's `lib/napi`, `wasmer-test-files`, and `tests/wast/spec` gitlinks are
pinned independently because the repository source fetcher deliberately does
not recurse into submodules.
