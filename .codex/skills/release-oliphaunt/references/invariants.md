# Release invariants

- A product owns SemVer, changelog, source identity, product tag, and GitHub release.
- A carrier is an ecosystem/target package for one product version. Carrier count is driven by consumer selection and registry limits, not by product count.
- PostgreSQL 18 contrib SQL members share the single runtime-bound
  `oliphaunt-extension-contrib-pg18` distribution product while retaining exact
  member paths/checksums inside each target carrier. External extensions own
  independent packaging SemVer and record their upstream version/commit
  separately.
- Normally the generated release-bump commit, qualified workflow head, artifact
  attestations, publication lock source SHA/tree, and product tags agree
  exactly. The sole post-publication control-recovery exception splits those
  identities: the original release-bump commit/tree remains the immutable
  publication source, while a later current-main commit is only the freshly
  qualified workflow controller. Never rewrite the lock source or relabel
  product evidence as controller output.
- Same-version recovery selects the complete original payload CI inventory,
  approved lock/capsule, immutable recovery boundary, and any required terminal
  bootstrap ledger by exact committed run/job/artifact ID, digest, and size.
  The boundary is either a nonempty exact public-registry prefix or the complete
  exact-source GitHub staged set backed by the failed run's recovery artifact.
  Its replayed publication lock must be byte-identical to the approved original,
  including `source` and `lockDigest`. The current first-release recovery
  requires all 73 recorded CI artifacts.
- A recovery controller receives a fresh, exact-main recovery-control CI record
  for its zero-owner control delta; it does not rebuild unchanged platform or
  package payloads. The separately reverified, committed complete source CI
  inventory remains the sole payload authority.
- Product tags/releases/assets, Swift source publication, registry receipts,
  and consumer-facing provenance remain publication-source-bound. Workflow
  code, the transport tag, OIDC claims, request journals, and pacing are
  controller-bound. Dual-identity recovery evidence must bind both.
- Extension evidence runs are immutable observations. Claim regeneration never changes them, and current WASIX support is qualified only by the full lifecycle collector running against same-workflow exact-SHA artifacts and recording that commit/tree/run identity.
- The publication lock is exhaustive: reject undeclared and missing packages/assets as well as hash, size, dependency, target, or version drift.
- Every shared published-byte producer or public target contract has exactly
  one declarative ownership rule and content-addressed Release Please
  fingerprints under every affected product root. Pure control-plane policy
  and transport-only edits do not create product releases; compiler, SDK,
  build, source-selection, target, and packaging changes remain
  product-semantic even when implemented in a workflow or local action.
- Generate the lock after artifact assembly. Freeze it before any external write. Preserve it with the release ledger.
- Publish leaves/parts before aggregators, target carriers before façades, runtime artifacts before SDKs, and packages before public GitHub release promotion.
- Every extension Cargo `*-wasix` portable carrier and each of its dynamic payload parts records the explicit canonical target `wasix-portable`; portable extension targets are never inferred from a null target.
- Cross-registry publication is resumable, not atomic. Treat already-matching immutable identities as success; treat mismatched identities as a stop condition.
- Normal publish is a strict GitHub-stage -> registry -> finalization DAG with a fresh deadline per job. Cross-job state must be a manifest-exact immutable artifact downloaded by ID; bind source SHA/tree, selected products, lock/catalog/package-envelope, approved dry-run run/artifact metadata, and every file digest/size. Carry Cargo/npm packages once in the approved capsule, only non-capsule registry inputs in the stage handoff, and receipts only after registry publication.
- Bootstrap writes a genesis checkpoint before any external mutation, executes one sequential lane per immutable-name registry with DAG barriers between them, and serializes canonical completed-ID receipts into a content-addressed hash-chain checkpoint after each bounded batch and final failure drain. Resume only an intact chain for the same source SHA, lock, catalog, selected products, complete carrier order, and package envelope.
- An existence check never authorizes an immutable-version skip. Prove crates.io checksums, npm SRI, Maven payload bytes, and the JSR file manifest against the publication lock, and preserve final receipts before release promotion.
- Before promotion, derive every applicable public consumer surface and dependency closure from the exact lock; probe each anonymous Cargo/npm/Maven/JSR entry independently plus Git/Swift in fresh caches under one deadline, require every resolver lock to contain its complete frozen closure, retry only transient visibility failures, and preserve deterministic evidence bound to both immutable receipt sets. Never hide a missing lock dependency in a receipt-only category. A macOS host install does not prove every OS carrier, and a pre-promotion Swift probe proves the public source tag/manifest rather than draft binary-target availability.
- Normal npm and JSR publication uses GitHub-hosted OIDC. Normal Cargo publication exchanges OIDC for a fresh temporary token per bounded carrier batch and revokes it in `finally`; Maven credentials remain protected environment secrets. Bootstrap credentials are short-lived, isolated, and revoked after exact trusted-publisher configuration is audited; npm bootstrap specifically requires a granular `@oliphaunt` read/write token with 2FA bypass from a 2FA-enabled actor.
- A pure version/changelog update may change the package envelope and lock, but must not change the WASIX binary-semantic input fingerprint.
- Never upload an immutable public version twice, move a public product tag, or
  force-push a history containing affected public releases. A same-version
  control recovery may only checksum/SRI-reconcile an already-public carrier;
  one byte of drift fails closed and requires a new version.
- Same-version recovery cannot run bootstrap or any continuation. Resume only
  through an idempotent root `publish` rerun that verifies the original
  terminal ledger when one was required, proves the recorded immutable recovery
  boundary, and reconciles every exact immutable identity before writes.
- With a clean release state, a pure zero-owner control-plane, workflow,
  validator, registry-transport, test, or documentation change creates no
  release PR and performs no publication. Semantic ownership, not a `ci:`
  subject, decides; compiler, SDK, build, source-selection, target, and
  packaging changes require releases.
