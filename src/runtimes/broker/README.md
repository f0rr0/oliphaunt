# oliphaunt-broker

`oliphaunt-broker` is the helper process used by broker mode. It owns one
native database root per process, serves the Oliphaunt broker IPC protocol, and
is packaged as platform-specific release assets for SDKs that need process
isolation.

Application developers should use their SDK's broker mode instead of invoking
this binary directly.

## Release licensing

The source-only `oliphaunt-broker` crate is Oliphaunt code under MIT and is not
published. The four compiled target carriers also contain the exact normal
Rust dependency graph selected for their OS target. Those binary carriers
therefore declare the complete payload expression and carry a target-specific
`THIRD_PARTY_LICENSES/rust/DEPENDENCIES.json` plus its byte-pinned license
texts.

`dependency-licenses.json` binds every registry dependency to its Cargo.lock
name, version, checksum, declared license, selected redistribution branch,
target set, and complete LICENSE/UNLICENSE/COPYING/NOTICE/COPYRIGHT plus
author, credit, patent, and third-party attribution inventory.
`tools/release/broker-dependency-license-contract.mjs check-contract` verifies
the self-contained contract and committed canonical blobs without consulting
Cargo or a registry cache. The connected production audit runs
`tools/release/broker-dependency-license-contract.mjs audit-contract`: it
creates an empty Cargo home, fetches the exact locked workspace closure for all
targets, then verifies every target graph and canonical source byte offline in
that same home. A dependency update is incomplete until that audit passes and
all four packed target carriers reopen the exact updated closure.
