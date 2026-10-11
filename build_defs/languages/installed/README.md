This is a closed installed Cargo consumer test for the current checkout. It uses
actual constructed source crates, a genuine Cargo-generated lockfile, captured
sparse index records, and registry archives authenticated by that lockfile.
It does not authorize publication or establish completed release origins.
Archive acquisition uses Cargo's selected Linux host graph; the remaining
cross-target index records support offline resolution without downloading their
unused platform archives.

`consumer_test` stages the final envelopes and derives SDK/helper constraints
from their conventional manifests. Cargo reconciles candidate versions offline
before the final locked offline compile and SQL/reopen execution. Independently
held runtime requirements remain the SDK manifest's requirements. Its result
records which source candidates Cargo actually selected; an unused patch is not
qualification of that candidate.

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
