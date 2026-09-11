# Release setup

Status: normative external-setup guide. Last verified: 2026-07-30. Owner: repository maintainers.

This document covers state that cannot live in the repository. The executable
contract is the direct least-privilege workflow in
`.github/workflows/release.yml` and
`tools/release/check_publish_environment.mts`; update this guide when either
changes.

## GitHub controls

Protect `main` before the first public release:

- require pull requests and the repository's aggregate `Required` check;
- allow squash merges only and require linear history;
- allow administrator bypass, while blocking force-push and deletion for
  protected-branch users;
- require conversations to be resolved and dismiss stale approvals;
- require at least one independent approval in team governance, but set the
  approval count to zero when the repository has only one collaborator so a
  self-authored generated release PR remains mergeable;
- do not enable `cancel-in-progress` for main qualification or release workflows.

`Required` is the branch merge gate. After a merge, the non-cancelled CI run on
the resulting `main` commit must also produce the exact-SHA `Qualified` record;
that record is publication evidence, not a pull-request branch-protection check.

Create these environments:

| Environment | Purpose | Secrets | Protection |
| --- | --- | --- | --- |
| `release-pr` | Create/update the generated release PR | `RELEASE_PR_TOKEN` | main only |
| `release-dry-run` | Exact-SHA artifact assembly and dry-run | none | main only |
| `release-bootstrap` | Creation of npm/crates identities that do not exist yet | Release tag App credentials plus only the short-lived, registry-scoped `CRATES_IO_BOOTSTRAP_TOKEN` and/or `NPM_BOOTSTRAP_TOKEN` required by the approved lock | `main` only; independent approval when available |
| `release-publish` | Normal trusted publication | Release tag App credentials, Maven Central credentials and signing key | `main` only; independent approval when available |

Use a GitHub App or narrowly scoped bot token for `RELEASE_PR_TOKEN`; PRs created by the default workflow token do not trigger the normal PR workflow. Keep bootstrap tokens out of repository secrets and out of `release-publish`. The approved-candidate inventory determines which of the two bootstrap tokens is required; do not provision a Cargo token for an npm-only bootstrap or vice versa. Delete/revoke each token immediately after trusted publishers are configured.

Create one private GitHub App installed only on `f0rr0/oliphaunt`, with
repository **Contents: read and write** and **Workflows: read and write** (no
webhooks or account permissions). Store `RELEASE_TAG_APP_CLIENT_ID` and
`RELEASE_TAG_APP_PRIVATE_KEY` in both `release-publish` and `release-bootstrap`.
These are GitHub tag credentials; retain them when retiring registry bootstrap
tokens. Do not copy `RELEASE_PR_TOKEN` or use a personal token for this role.

GitHub can reject tags on an older candidate whose workflow files differ from
the publishing commit, even with an existing transport ref. The normal
`GITHUB_TOKEN` cannot request `workflows: write`. The pinned
`actions/create-github-app-token` action requests only the two required
permissions for this repository, checks them before publication, and
mints fresh tokens immediately before product/transport tags and SwiftPM tags.
It revokes each installation token during job cleanup. Ordinary publication,
attestations, and registry authentication keep their existing credentials.
A missing App installation or permission fails before release mutations.

The App's bot account is `oliphaunt-release-bot[bot]` (GitHub user ID
`326451763`). `tools/release/release-bot.json` owns its commit name and linked
noreply address for generated release helper commits. SwiftPM commit authorship
is read from the candidate's copy of that file so newer publisher code cannot
change an older approved synthetic commit; candidates predating the file retain
the legacy identity. Do not rewrite existing release history to change avatars.

After a publication-only fix is merged and its `Required` check passes, dispatch
normal `publish` from current `main` with the original `release_commit` and
`approval_run_id`. The completed bootstrap is found by its approved lock;
neither the binaries nor bootstrap need to run again. Retain the approved
candidate artifacts and completed bootstrap artifact until publication finishes.
A failure without a code change still resumes by rerunning the original failed
publish run.

Use exact custom deployment branch/tag policies. `release-pr` and
`release-dry-run`, `release-bootstrap`, and `release-publish` allow only the
`main` branch. A rerun remains bound to its original workflow SHA and explicit
dry-run approval even after `main` advances. Existing immutable
`oliphaunt-release-transport/*` tags remain append-only and are never updated or
deleted.
Environment approval is optional for dry-run and recommended for the
irreversible bootstrap and publish operations when a second maintainer is
available. In that case, require the independent reviewer and prevent
self-review. A solo-maintained repository must leave self-review prevention
disabled so publication remains possible; manual root dispatch plus exact-SHA
qualification, the root-admitted immutable transport boundary, and the frozen
lock are the viable solo controls.

Actions must allow OIDC and artifact attestations. Normal Cargo publication's
in-process broker follows crates.io's documented OIDC exchange and revocation
protocol: it requests audience `crates.io`, exchanges the GitHub JWT for a
30-minute registry token, masks it before use, starts at most 20 carriers and
no work after 20 minutes on that token, and revokes it in `finally`. A fresh
batch receives a fresh token; `id-token: write` alone does not authorize a
registry upload. The frozen Cargo uploader sends the lock-matching `.crate`
through crates.io's Registry Web API instead of asking `cargo publish` to
repackage it.

Bootstrap uses only its scoped first-publish tokens. After package identities and their external publisher settings
exist, normal Cargo/npm publication uses the `release-publish` environment and
short-lived OIDC credentials without bootstrap tokens.

### Trusted-publisher identity through the direct workflow

Cargo and npm publication jobs run directly in `.github/workflows/release.yml`.
Their GitHub OIDC identity therefore contains that exact file in
`workflow_ref`, its exact commit in `workflow_sha`, and the protected
`release-publish` environment claim. GitHub may also emit `job_workflow_ref`
as an optional current-job alias, with or without `job_workflow_sha`. The ref
must exactly equal the canonical `workflow_ref`; a present SHA alias is
accepted only alongside that exact ref and must equal `workflow_sha`. This
rejects a distinct called reusable-workflow identity without requiring the SHA
alias to accompany every ref alias. Repository policy also forbids delegated
operation jobs and `workflow_call`. The workflow performs a read-only
live-token check of the repository, workflow, ref, SHA, hosted runner, event,
and environment claims before normal trusted publication.

| Registry | Exact external configuration | Ref binding |
| --- | --- | --- |
| crates.io | owner `f0rr0`, repository `oliphaunt`, workflow filename `release.yml`, environment `release-publish` | Normal publication is a root `main` dispatch |
| npm | owner `f0rr0`, repository `oliphaunt`, workflow filename `release.yml`, environment `release-publish`, allowed action `npm publish` | Normal publication is a root `main` dispatch |

This identity follows GitHub's [OIDC claim
reference](https://docs.github.com/en/actions/reference/security/oidc), the
[crates.io trusted-publishing setup](https://crates.io/docs/trusted-publishing),
and npm's [trusted-publisher fields](https://docs.npmjs.com/trusted-publishers/).
Registry settings are external state: the OIDC preflight proves what GitHub
emits, not what a registry operator entered. Audit the table after bootstrap.
The crates.io exchange then proves its matching configuration before normal
registry mutation; npm has no non-publishing trusted-auth probe, so its package
settings must be checked directly.

Use the exact publication lock to manage that external state; never maintain a
second handwritten package list. This command validates the lock against the
checked-out catalog and prints a plan without credentials, network access, or
mutation:

```sh
lock=target/release/publication-lock.json
bash tools/release/trusted-publisher-config.sh --lock "$lock"
```

Authenticated `--audit` remains read-only. Mutation exists only behind the
literal `--apply` flag *and* an exact `--confirm-lock-digest`; the tool first
audits the entire selected batch, refuses every mutation if it finds a wrong or
extra configuration, creates only missing configurations, and re-audits after
creation. It never revokes or replaces a registry configuration. A failed or
expired-auth run is resumable by rerunning the same lock and batch: exact
configurations are skipped, while conflicts still fail closed.

Each credential-bearing job directly selects exactly one protected environment:
`release-pr`, `release-bootstrap`, or `release-publish`. Keep the named secrets
only in those environments; do not add repository-level duplicates or a
reusable-workflow secret bridge. GitHub automatically provides the scoped
`GITHUB_TOKEN`. Every job declares its own effective permissions: dry-run is
read-only, bootstrap adds `contents: write`,
preparation gets release-PR writes, and normal publish runs in one direct job
with the `release-publish` grants. Bootstrap's
content write is solely to create the immutable
release transport tag immediately before its first registry mutation;
reruns do not create, move, or delete repository refs.
Candidate preparation, conditional bootstrap, and publication are dependent
jobs in one `publish` run with separate permissions and environments.
The read-only dry-run validates every public release visible to its token and
every selected product tag. `publish` uses its content-write token to require
the complete live draft/public release set before mutation. A hidden draft is
therefore never misclassified as absent proof, and dry-run does not gain write
capability merely to list drafts.

Bootstrap recovery uses GitHub's rerun of the original failed workflow run.
The rerun retains the original workflow SHA and explicit candidate identity,
then verifies the exact `oliphaunt-release-transport/<full-sha>` tag instead of
resolving moving `main`.

Audit the live controls without changing them for release setup or an actual
public registry/tag/asset mutation:

```sh
tools/dev/bun.sh tools/release/audit-github-release-controls.mts \
  --governance solo \
  --bootstrap-state idle
```

Use `--governance team` only when an independent maintainer is actually
available. Bootstrap state is an explicit credential lifecycle, not an
authorization shortcut:

- `idle` is the default when bootstrap tokens are absent; it requires both
  token names to be absent and does not describe whether source CI may run;
- `ready` is valid only after every reviewed short-lived Cargo/npm token
  required by the approved lock has been installed for an imminent
  `publish` dispatch that will bootstrap missing identities; it accepts either registry token or both, and
  requires at least one. Provision only the registries whose exact locked
  identities remain absent. A recovery in which every selected Cargo/npm
  version already matches stays `idle` and requires neither token; and
- `retired` is valid only after bootstrap sealed, trusted publishers were
  configured, and both tokens were revoked and removed; it also requires the
  token names to be absent.

This audit is not an ordinary branch-push, release-PR or source-qualification
gate. Those jobs do not select `release-bootstrap` and cannot receive its
environment secrets. A bootstrap lifecycle finding does not justify blocking
unrelated source work, changing credentials, or claiming a different lifecycle.
It remains a release setup finding to resolve before the affected public
mutation. No remote settings or secrets are changed by this diagnostic.

The conditional bootstrap job independently derives the registries required
by the approved lock and rejects each missing credential immediately before
mutation, so an `idle` audit cannot authorize bootstrap publication. The
auditor reads the canonical repository through `gh api`, prints deterministic
`PASS`/`WARN`/`FAIL` findings, and exits nonzero only for hard release-safety
findings (usage, authentication, or API errors exit `2`). It reads environment
secret names, never values; the authenticated account therefore needs
permission to inspect repository and environment settings. Warnings cover
optional team governance and repository hygiene and do not block a solo
release.

## Registry ownership

The publication catalog defines stable carrier topology; the frozen publication lock is the exhaustive candidate identity inventory, including generated payload parts. Generate/query them rather than maintaining a package list in this document. The first bootstrap inventory freezes a carrier-level ledger scope containing only wholly absent package names. Existing names without the locked exact version remain outside that scope for normal trusted publication. A resumed run accepts a scoped identity only when its locked first version is already public with lock-matching bytes (a recovery skip) or its name remains wholly absent (a first-version mutation). Any other state inside the immutable scope is a hard blocker. The workflow invokes bootstrap publishers only for scoped names that remain absent; a conflicting public identity is never a reason to rename an artifact silently.

### crates.io

1. Create the maintainer account/team.
2. Inventory the exact first-release lock. Crates.io's documented per-user new-name limit is a burst of 5 followed by one new crate every 10 minutes. Do not copy a carrier count from this document: the publication catalog is the stable identity model, while oversized payloads add generated `*-part-NNN` carriers only when the candidate artifacts and publication lock are assembled. For `C` missing Cargo names, the untouched-default rate-limit floor is `max(0, C - 5) * 10 minutes`. Crates.io support may grant exceptional capacity, but no API exposes that account state, so the workflow never treats an operator-entered number as proof. A valid `429 Retry-After` response and the next read-only registry inventory are authoritative.
3. Dispatch `publish`; its conditional protected bootstrap job creates only missing first versions using the candidate prepared in the same run. The slim bootstrap job verifies and atomically installs those exact bytes; it does not rebuild them. Before initializing its ledger or sending any npm/Cargo mutation, the workflow queries crates.io read-only and reports exact selected/existing/missing counts and the official-default duration floor. It admits only a dependency-closed batch that fits the bounded job window. Independent Cargo and npm mutations overlap; each registry remains strictly sequential, and dependencies within the absent-name scope remain barriers. An optional npm dependency on an existing package name stays on the normal trusted-publication graph; any other unavailable locked dependency stops bootstrap.

   When the exact lock cannot finish in one six-hour hosted job, the job drains
   in-flight uploads, reconciles successful mutations, uploads its
   content-addressed checkpoint, and exits incomplete with the exact
   `gh run rerun <run-id> --failed` command. The maintainer reruns that original
   workflow run after any reported `Retry-After` delay. The rerun restores only
   an intact ledger bound to the same release SHA, approved candidate, lock,
   and products. A timeout, ambiguous upload, integrity conflict, malformed
   retry response, or checkpoint failure remains a hard failure.

   Bootstrap's protected `release-bootstrap` environment may increase, but
   never decrease, four calibrated admission variables: 30 seconds per missing
   Cargo name (`REGISTRY_BOOTSTRAP_CARGO_SECONDS_PER_CARRIER`), 30 seconds per
   missing npm name (`REGISTRY_BOOTSTRAP_NPM_SECONDS_PER_CARRIER`), 6 seconds
   per already-public version reconciled at fixed concurrency eight
   (`REGISTRY_BOOTSTRAP_RECONCILIATION_SECONDS_PER_CARRIER`), and a 600-second
   non-publication reserve (`REGISTRY_BOOTSTRAP_RESERVE_SECONDS`). Leave them
   unset to use these defaults. Increase a value only from measured registry or
   runner evidence; the parser rejects smaller values so an operator cannot
   make a workload appear to fit by weakening the admission model. For `C`
   missing Cargo names and `N` missing npm names, the basic aggregate
   estimate is `30*C + 30*N` seconds and the independent-lane lower bound is
   `max(30*C, 30*N)` seconds before reserve and dependency barriers. These
   formulas are explanatory, not admission evidence: the gate recomputes the
   exact dependency-DAG critical path from the frozen lock, including every
   generated Cargo part carrier.

   These values are not upper bounds on third-party latency. A Cargo carrier
   can use up to twelve visibility probes separated by ten-second waits, and an
   npm carrier has its own bounded publish and visibility loops; either can
   exceed the 30-second estimate. The absolute registry/job deadline is the
   hard bound. Completed carrier IDs are reconciled and appended through one
   serialized checkpoint writer in canonical order. If either lane fails, no
   new mutation starts after the shared abort, the peer's one in-flight
   immutable operation drains, and a final checkpoint attempt covers every
   successful operation. An exact-lock rerun inventories and byte-proves public
   partial mutations, including an ambiguous upload accepted before failure,
   without blindly repeating that immutable upload.
4. Give the revocable scoped API token the `publish-new` and `trusted-publishing` endpoint scopes and only the `oliphaunt*` and `liboliphaunt*` crate scopes. After bootstrap seals, expose that same bootstrap token to the local process as `CRATES_IO_TRUST_CONFIG_TOKEN`, then run the lock-derived read-only audit and explicit apply below. The crates.io API is queried per exact crate; any wrong or additional configuration blocks the whole apply before it creates another one.

   ```sh
   lock=target/release/publication-lock.json
   digest="$(jq -er .lockDigest "$lock")"
   bash tools/release/trusted-publisher-config.sh \
     --audit --ecosystem cargo --lock "$lock"
   bash tools/release/trusted-publisher-config.sh \
     --apply --confirm-lock-digest "$digest" --ecosystem cargo --lock "$lock"
   ```

   The first audit exits `1` while configurations are missing; that is an
   expected read-only finding, not permission to weaken the apply guard. Run it
   once more after apply and retain its zero-missing, zero-conflict JSON report
   with the release evidence. `CRATES_IO_TRUST_CONFIG_TOKEN` is only the local
   process alias for the already-protected bootstrap token: do not duplicate it
   as another GitHub secret or put its value in a file, command argument, log,
   or shell history.
5. Revoke `CRATES_IO_BOOTSTRAP_TOKEN` and remove it from `release-bootstrap`.
6. Run normal `publish`; its bounded in-process broker must acquire, mask, use,
   and revoke fresh OIDC-exchanged tokens for at most 20 Cargo carriers and 20
   minutes per batch.

Crates.io returns `429` with an HTTP-date `Retry-After` when a publish bucket is
empty. The frozen publisher retries only that explicit non-mutating rejection,
using the exact same locked bytes and only while the bounded mutation deadline
can accommodate the server delay. Ambiguous transport and other server errors
are never blindly replayed: registry state is checked, matching bytes resume,
and the maintainer uses GitHub's rerun on the original Release run.

Normal publication does not predict registry capacity or deliberately admit a
partial batch. It inventories every exact `name@version`, rejects missing names
that require bootstrap, and attempts the complete dependency-ordered plan once
inside the job deadline. A rerun byte-proves matching public versions and
publishes only those still absent.
Trusted-publishing credentials are also bounded: crates.io issues each token
for 30 minutes, so the Cargo executor refreshes and revokes tokens in batches
well inside that lifetime rather than retaining the workflow's first token.
Every OIDC, token-exchange, and revoke request is clamped to the shared registry
deadline. A batch cannot acquire a token unless two bounded exchanges plus the
mandatory revoke budget remain, and publication receives a deadline that
excludes that revoke budget even when a carrier fails.

Generated Cargo `*-part-NNN` crates are allowed only when a `.crate` would
exceed crates.io's package-size limit. They are carriers in the frozen lock,
publish before their aggregator, and are not independent release products.

### npm

1. Create/claim the `@oliphaunt` scope and require public access/provenance in package metadata.
2. Bootstrap only identities whose settings page cannot exist before a first
   publish. Immediately before that run, create `NPM_BOOTSTRAP_TOKEN` as a
   short-lived **granular access token** owned by an actor whose npm account has
   2FA enabled and write access to `@oliphaunt`. Its package/scopes permission
   must be **Read and write**, its selected scope must explicitly include
   `@oliphaunt`, and **Bypass two-factor authentication** must be enabled.
   Limit its lifetime to the bootstrap window, store it only in the
   `release-bootstrap` environment, and revoke it as soon as the identity chain
   seals. An ordinary token, a read-only token, an organization-only grant, or
   a granular token without 2FA bypass may authenticate successfully but will
   fail the noninteractive first publish with `EOTP`; do not discover that
   distinction through a sacrificial package mutation.
3. For this operator-side configuration step, use npm CLI 11.15.0 or newer and
   an npm authentication method supported by `npm trust`; the account must have
   2FA and every package must already exist. The release workflow separately
   installs and verifies its exact `NPM_VERSION` through
   `setup-npm-publisher`; do not substitute the operator's ambient CLI for that
   workflow pin.
   The setup helper retains npm's documented two-second spacing and divides the
   exact lock into deterministic batches of 25, leaving room inside each
   five-minute 2FA skip window for pre-audit, creation, and post-audit. For each
   `npmBatches[].number` printed by the no-network plan, run the read-only audit
   and then the explicit apply:

   ```sh
   lock=target/release/publication-lock.json
   digest="$(jq -er .lockDigest "$lock")"
   bash tools/release/trusted-publisher-config.sh \
     --audit --ecosystem npm --batch 1 --lock "$lock" \
     --output target/release/npm-trust-batch-1-pre-audit.json
   bash tools/release/trusted-publisher-config.sh \
     --apply --confirm-lock-digest "$digest" \
     --ecosystem npm --batch 1 --lock "$lock" \
     --output target/release/npm-trust-batch-1-apply.json
   ```

   Repeat with the next batch number, completing npm's 2FA prompt when a new
   window is needed. The first audit exits `1` for missing configurations; its
   JSON is still the required pre-mutation inventory. Every exact package receives repository
   `f0rr0/oliphaunt`, workflow `release.yml`, environment
   `release-publish`, and only `npm publish`; staged publishing is never
   authorized. After all batches, rerun `--audit` for every batch and retain
   the zero-missing, zero-conflict reports.

   Run every npm `--audit` and `--apply` command directly in an interactive
   terminal. npm can require web or classic OTP even for `npm trust list`.
   Before the initial and final classification passes, the helper therefore
   runs one read-only list with inherited terminal streams and discards that
   display, then performs separate bounded captured reads as evidence. If that
   authentication window expires during a batch, an `EOTP` captured read gets
   exactly one more read-only warm-up and one captured retry; no other failure
   is retried. Every successful warm-up is followed by the same bounded
   two-second management-request spacing as ordinary list/create requests.
   Each interactive warm-up or mutation has a five-minute process deadline.
   Select npm's five-minute authentication window when prompted. Do not pipe
   or redirect npm audit/apply commands. `--output` atomically creates the
   machine-readable mode-`0600` report and refuses to overwrite an earlier
   report, so use a new output name for every final re-audit.
4. Revoke `NPM_BOOTSTRAP_TOKEN`; normal publishing uses npm trusted publishing and no `NODE_AUTH_TOKEN`.

Target-specific npm packages are intentional carriers. Routine payload-splitting packages are forbidden; an npm tarball contains the target payload directly and stays within the registry's documented limits.

### Maven Central

Verify in Central Portal that `dev.oliphaunt` is visibly **Verified** for the
account represented by the portal token. This is a one-time external control:
the documented Publisher API has no read-only namespace-status endpoint, so an
empty deployment listing must not be represented as proof of namespace
verification. Store the portal username/password and in-memory GPG
key/id/passphrase only in `release-publish`. Before any mutation, the normal
workflow authenticates against the read-only deployment endpoint, binds its
query to `dev.oliphaunt`, and rejects catalog groups outside that namespace. It
also imports the key into an isolated temporary GPG home, signs fixed preflight
bytes with the configured key and passphrase, requires the signature to use the
primary key rather than an incompatible signing subkey, verifies the detached
signature and fingerprint, confirms that exact primary fingerprint is
retrievable from at least one Central-supported keyserver, deletes the
temporary keyring, and repeats that proof immediately before mutation. The
normal publish job also constructs the complete
lock-selected Central bundle without upload and requires Central metadata,
exact primary/sources/javadoc files, nonempty payloads, signatures, checksums,
safe paths, and a total archive size strictly below 1 GB. Placeholder
sources/javadoc JARs are deterministic and intentional for binary carrier
coordinates. `MAVEN_GPG_KEY_ID` must be an 8-64 character hexadecimal
primary-key ID or fingerprint, with an optional `0x` prefix. Publish the public
primary key to `keyserver.ubuntu.com`, `keys.openpgp.org`, or `pgp.mit.edu`
before release. Publish the identities declared by the catalog: the Android
AAR, Gradle plugin and marker, runtime/extension ABI carriers. Do not publish an
undeclared Kotlin Multiplatform/JVM root module.

### SwiftPM and GitHub Releases

Product tags use `<product>-v<version>`. SwiftPM additionally consumes an unscoped semantic tag; because legacy unscoped tags occupy versions through `0.5.1`, the first Oliphaunt Swift version is `0.6.0`.

Release Please owns product versions, changelogs, and the generated release PR.
On the normal single-identity path, the root protected publish job first reads
`oliphaunt-release-transport/<full-sha>`. When it is absent, or the job is on
its first run attempt, the helper validates current `main` before creating or
accepting the exact direct-commit tag. Only a genuine GitHub rerun
(`GITHUB_RUN_ATTEMPT > 1`) of the exact root operation, original
`refs/heads/main` workflow SHA may reuse an already
exact tag after `main` advances; a missing, wrong, or annotated tag cannot use
that exception. The job then stages each selected product tag and draft GitHub
release directly at the qualified SHA. Before
staging, the lock-derived SwiftPM preflight creates no semantic tag and performs
no push: it accepts only an absent semantic tag or an existing tag that resolves
to the exact deterministic manifest commit for this release. Any conflicting
or ambiguous remote tag fails before the first mutation. The release transport
tag itself is immutable and is never updated or deleted.
The workflow then uploads checksum-covered assets, completes registries, runs
the receipt-bound anonymous public-consumer probes, preserves their immutable
evidence, and promotes drafts. A failed publish must leave drafts unpromoted.
The Swift probe can resolve the public source tag and evaluate its manifest at
this point; draft binary-target assets are not anonymously public until
promotion and remain covered by the exact GitHub asset/attestation receipt.

## First release sequence

1. Confirm selected registry identities and product tags do not conflict.
2. Merge the introduction tree through the qualified path. Its parent must be
   the full `bootstrap-sha` boundary recorded in `release-please-config.json`,
   so legacy release commits are excluded from the first product releases. Do
   not rewrite history after any affected identity is public. A defect creates
   a new ordinary candidate and requires fresh qualification.
3. Run `prepare-release-pr` from current `main`; review the single generated release-bump commit.
   A large Release Please update may arrive internally as multiple transport
   chunks; the prepare job validates and collapses the exact canonical PR tree
   to this single commit before it is reviewable or mergeable. The prepare job
   must also converge all derived pins, locks, compatibility values, and
   evidence, then validate their exact Git blobs before pushing the normalized
   head. A raw Release Please head is never
   mergeable merely because its direct versions and changelogs look complete.
4. Merge it and wait for that exact commit's non-cancelled `Qualified` CI run.
5. Run `publish`. It prepares the frozen lock and complete candidate from
   exact-SHA CI artifacts, then automatically bootstraps missing Cargo/npm
   names, publishes the dependency-ordered registry plan, checks anonymous
   public consumers, and promotes GitHub drafts last. Existing names use
   trusted publishing. Provision short-lived bootstrap tokens only if names
   are absent. No separate dry-run, bootstrap dispatch, or approval run ID is
   needed on this path.
6. If a job stops, preserve its evidence and use
   `gh run rerun <run-id> --failed` after any reported not-before delay.
   Bootstrap restores its checkpoint; publishers prove and skip matching
   immutable bytes. Successful preparation is reused.
7. After first identities exist, configure their trusted publishers with the
   exact lock's `trusted-publisher-config.sh` plan/audit/apply flow and revoke
   bootstrap tokens before the next release. Preserve the lock, ledger,
   provenance, and workflow URL.

The first generated release PR consumes the one-time `bootstrap-sha` boundary.
`sync-release-pr.mts` removes it on that PR once any manifest entry advances
from `0.0.0`; the release-bump commit must contain that removal. Never delete
the boundary on the unreleased introduction tree. Never restore it on a
publishable release-bump tree.

Normally `release_commit` asserts the current workflow SHA. For a narrowly
permitted publication-only fix, `publish` may supply an approved ancestor SHA
and its `approval_run_id`. The controller rejects product, packaging, build,
CI, and lockfile changes. The old candidate retains its exact qualification
and bytes; the current controller requires successful CI `Required`.

## Recovery

Publishing is not cross-registry atomic. On normal-publish failure, preserve
the lock and responses, inventory all selected identities, and use GitHub's
rerun on the original Release run at the exact same commit. Matching immutable
versions may be skipped only after registry bytes are proved; a mismatch stops
the release. Only first-identity bootstrap restores a content-addressed
checkpoint chain. Product changes require a new version and exact-SHA
qualification.

Normal recovery reruns `publish` at the exact same release commit with the same
qualified artifacts and approved lock. Use GitHub's rerun for the failed
Release run rather than a fresh dispatch after `main` moves. The original run
and referenced CI/candidate artifacts must still be available. The rerun
byte-verifies public registry and GitHub state, skips exact matches, and writes
only missing state. Product changes require a new candidate and normal
versioning and qualification. Publication-only fixes may reuse a completed
Release run whose candidate preparation succeeded, through the explicit
source SHA and approval run inputs. First-identity bootstrap alone restores its checkpoint chain. See
`.codex/skills/release-oliphaunt/references/recovery.md` for recovery.

## External readiness checklist

- the read-only GitHub controls audit has no `FAIL` findings for the applicable
  solo/team governance and `idle`, `ready`, or `retired` bootstrap lifecycle;
- main requires `Required`, squash-only merges, linear history, resolved
  conversations, stale-approval dismissal, and no force-push or deletion for
  protected-branch users; administrators may bypass branch protection;
- all release environments admit only the `main` branch; bootstrap and publish
  use independent approval and
  prevent-self-review when a second maintainer exists, while solo operation
  keeps self-review prevention disabled;
- `release-pr` can create a PR that triggers normal CI;
- dry-run has no write credentials;
- bootstrap tokens are absent unless a reviewed first-identity run is imminent;
- every Cargo and npm identity uses workflow `release.yml` and environment
  `release-publish`, npm
  allows `npm publish`, and neither registry is expected to bind a branch;
- the exact-lock trusted-publisher audit reports every selected Cargo/npm
  identity exact, with zero missing and zero conflicting/extra configurations;
- Central Portal visibly marks `dev.oliphaunt` Verified, the deployment API
  credentials authenticate, and the primary signing key preflight validates;
- registry owners and GitHub maintainers can recover/revoke credentials;
- staged/local clean consumers pass before publication, and the normal publish
  can resolve/install every applicable exact-lock public ecosystem entry from
  anonymous endpoints before draft promotion; Swift's pre-promotion proof is
  intentionally source-tag/manifest-only because draft binary assets are not
  public yet.
