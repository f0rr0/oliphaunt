# Release invariants

- A product owns SemVer, changelog, source identity, product tag, and GitHub release.
- A carrier is an ecosystem/target package for one product version. Carrier count is driven by consumer selection and registry limits, not by product count.
- contrib extensions are runtime-bound. External extensions own independent packaging SemVer and record their upstream version/commit separately.
- The release commit, qualified workflow head, artifact attestations, publication lock source SHA/tree, and product tags must agree exactly.
- Extension evidence runs are immutable observations. Claim regeneration never changes them, and current WASIX support is qualified only by the full lifecycle collector running against same-workflow exact-SHA artifacts and recording that commit/tree/run identity.
- The publication lock is exhaustive: reject undeclared and missing packages/assets as well as hash, size, dependency, target, or version drift.
- Generate the lock after artifact assembly. Freeze it before any external write. Preserve it with the release ledger.
- Publish leaves/parts before aggregators, target carriers before façades, runtime artifacts before SDKs, and packages before public GitHub release promotion.
- Cross-registry publication is resumable, not atomic. Treat already-matching immutable identities as success; treat mismatched identities as a stop condition.
- Bootstrap writes a genesis checkpoint before any external mutation and appends a content-addressed hash-chain checkpoint after each bounded, dependency-ordered carrier batch. Resume only an intact chain for the same source SHA, lock, catalog, selected products, complete carrier order, and package envelope.
- An existence check never authorizes an immutable-version skip. Prove crates.io checksums, npm SRI, Maven payload bytes, and the JSR file manifest against the publication lock, and preserve final receipts before release promotion.
- Normal npm and JSR publication uses GitHub-hosted OIDC. Normal Cargo publication exchanges OIDC for a fresh temporary token per bounded carrier batch and revokes it in `finally`; Maven credentials remain protected environment secrets. Long-lived bootstrap credentials are scoped, isolated, and revoked after exact trusted-publisher configuration is audited.
- A pure version/changelog update may change the package envelope and lock, but must not change the WASIX binary-semantic input fingerprint.
- Never reuse a public version, move a public product tag, or force-push a history containing affected public releases.
