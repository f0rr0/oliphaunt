This is a closed installed Cargo consumer test for the current checkout. It uses
actual constructed source crates, a genuine Cargo-generated lockfile, captured
sparse index records, and registry archives authenticated by that lockfile.
It does not authorize publication or establish completed release origins.
Archive acquisition uses Cargo's selected Linux host graph; the remaining
cross-target index records support offline resolution without downloading their
unused platform archives.

`consumer_test` runs three common preparation cases: the current SDK/helper
composition with its declared candidate dependency closure, a direct packaged
Core public API consumer, and the genuine held SDK baseline. Each case compiles
and executes SQL/reopen checks. The direct Core case leaves the held SDK's
requirements unchanged.

`consumer_minimum_test` runs only the additional declared SDK minimum case. The
source-owned policy requires it for final admission of prepared selected Rust
source carriers. Preparation alone cannot satisfy that final requirement.
Cargo resolves both tests' compositions offline from the conventional manifests
and captured inputs. For SDK compositions, independently held runtime
requirements remain the SDK manifest's requirements. Results record which
source candidates Cargo actually selected; an unused patch is not qualification
of that candidate.

Registry requirement changes need explicit qualification preflight. Run
`capture.mts` with the pinned Cargo and rustc executable paths, an output
directory, and the constructed source archive paths. The updater invokes real
Cargo resolution and fetch, verifies each downloaded archive against its lock
checksum and sparse index record, and emits `Cargo.lock` plus
`registry-index.json`. Replace both fixture files together with these generated
outputs, review the dependency changes, refresh the module acquisition lock if
needed, then run the closed test. No manually edited resolution graph is used.

The production frozen consumer adapter independently authenticates selected
candidate and held origins from its publication capsule before sharing the same
source-envelope stager. This checkout test intentionally has no publication
capsule or production origin claim.
