# Release invariants

- A product owns SemVer, changelog, source identity, product tag, and GitHub release.
- A carrier is an ecosystem/target package for one product version. Carrier count is driven by consumer selection and registry limits, not by product count.
- PostgreSQL 18 contrib SQL members share the single runtime-bound
  `oliphaunt-extension-contrib-pg18` distribution product while retaining exact
  member paths/checksums inside each target carrier. External extensions own
  independent packaging SemVer and record their upstream version/commit
  separately.
- The generated release-bump commit, qualified workflow head, artifact
  attestations, publication lock source SHA/tree, product tags, and every retry
  agree exactly. A later commit cannot control or finish the release.
- Extension evidence runs are immutable observations. Claim regeneration never changes them, and current WASIX support is qualified only by the full lifecycle collector running against same-workflow exact-SHA artifacts and recording that commit/tree/run identity.
- The publication lock is exhaustive: reject undeclared and missing packages/assets as well as hash, size, dependency, target, or version drift.
- Release Please selects direct candidates from configured product paths.
  Shared byte producers must live in, or be represented by, every product whose
  shipped behavior they change. Do not create repository-meta fingerprints to
  force selection.
- Generate the lock after artifact assembly. Freeze it before any external write. Preserve it with the release ledger.
- Publish leaves/parts before aggregators, target carriers before façades, runtime artifacts before SDKs, and packages before public GitHub release promotion.
- Every extension Cargo `*-wasix` portable carrier and each of its dynamic payload parts records the explicit canonical target `wasix-portable`; portable extension targets are never inferred from a null target.
- Cross-registry publication is resumable, not atomic. Treat already-matching immutable identities as success; treat mismatched identities as a stop condition.
- Normal publish is one idempotent protected job: stage GitHub state, attempt
  the complete registry plan, verify public consumers, and promote last. It has
  no normal checkpoint, continuation, or phase handoff. On failure, a
  maintainer uses GitHub's rerun on the original Release run at the exact same
  commit, which byte-verifies matching immutable state and publishes only what
  remains absent.
- Bootstrap writes a genesis checkpoint before any external mutation, executes one sequential lane per immutable-name registry with DAG barriers between them, and serializes canonical completed-ID receipts into a content-addressed hash-chain checkpoint after each bounded batch and final failure drain. Resume only an intact chain for the same source SHA, lock, catalog, selected products, complete carrier order, and package envelope.
- An existence check never authorizes an immutable-version skip. Prove crates.io checksums, npm SRI, and Maven payload bytes against the publication lock, and preserve final receipts before release promotion.
- Before promotion, derive every applicable public consumer surface and dependency closure from the exact lock; probe each anonymous Cargo/npm/Maven entry independently plus Git/Swift in fresh caches under one deadline, require every resolver lock to contain its complete frozen closure, retry only transient visibility failures, and preserve deterministic evidence bound to both immutable receipt sets. Never hide a missing lock dependency in a receipt-only category. A macOS host install does not prove every OS carrier, and a pre-promotion Swift probe proves the public source tag/manifest rather than draft binary-target availability.
- Normal npm publication uses GitHub-hosted OIDC. Normal Cargo publication exchanges OIDC for a fresh temporary token per bounded carrier batch and revokes it in `finally`; Maven credentials remain protected environment secrets. Bootstrap credentials are short-lived, isolated, and revoked after exact trusted-publisher configuration is audited; npm bootstrap specifically requires a granular `@oliphaunt` read/write token with 2FA bypass from a 2FA-enabled actor.
- A pure version/changelog update may change the package envelope and lock, but
  must not alter the existing WASIX runtime or AOT bytes.
- Never upload an immutable public version twice, move a public product tag, or
  force-push a history containing affected public releases. Retry only at the
  exact release commit through GitHub's rerun of the original Release run; the
  run and referenced artifacts must remain available. Checksum/SRI-reconcile
  already-public carriers and fail closed on one byte of drift.
- With a clean release state, a pure control-plane, workflow, validator,
  registry-transport, test, or documentation change outside configured product
  paths creates no release PR and performs no publication. Compiler, SDK,
  build, source-selection, target, and packaging output changes require
  releases regardless of commit subject.
