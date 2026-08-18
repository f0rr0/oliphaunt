# WASIX Postmaster Third-Party Sources

These are the production source pins for the concurrent PostgreSQL/WASIX
postmaster runtime. They are separate from the single-backend WASIX source
domain because applying the postmaster concurrency patches must not alter the
existing `liboliphaunt-wasix` product.

The hardened source fetcher materializes clean, immutable checkouts under
`target/oliphaunt-sources/checkouts/`. Project scripts copy those inputs into
disposable worktrees under `target/oliphaunt-wasix-postmaster/` before applying
patches. The durable source checkouts are never patched in place.

Wasmer's `lib/napi`, `wasmer-test-files`, and `tests/wast/spec` gitlinks are
pinned independently because the repository source fetcher deliberately does
not recurse into submodules.
