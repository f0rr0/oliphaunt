# Release setup

Status: normative external-setup guide. Last verified: 2026-07-14. Owner: repository maintainers.

This document covers state that cannot live in the repository. The executable
contract is the least-privilege dispatcher in `.github/workflows/release.yml`,
the shared implementation in `.github/workflows/release-execute.yml`, and
`tools/release/check_publish_environment.mjs`; update this guide when any of
them changes.

## GitHub controls

Protect `main` before the first public release:

- require pull requests and the repository's aggregate `Required` check;
- allow squash merges only and require linear history;
- enforce the rules for administrators, and block force-push and deletion;
- require conversations to be resolved and dismiss stale approvals;
- do not enable `cancel-in-progress` for main qualification or release workflows.

`Required` is the branch merge gate. After a merge, the non-cancelled CI run on
the resulting `main` commit must also produce the exact-SHA `Qualified` record;
that record is publication evidence, not a pull-request branch-protection check.

Create these environments:

| Environment | Purpose | Secrets | Protection |
| --- | --- | --- | --- |
| `release-pr` | Create/update the generated release PR | `RELEASE_PR_TOKEN` | main only |
| `release-dry-run` | Exact-SHA artifact assembly and dry-run | none | main only |
| `release-bootstrap` | One-time creation of npm/crates identities | `CRATES_IO_BOOTSTRAP_TOKEN`, `NPM_BOOTSTRAP_TOKEN`, and the numeric `CRATES_IO_NEW_CRATE_RUN_CAPACITY` assertion when the exact lock exceeds the default crates.io burst | main only; independent approval when available |
| `release-publish` | Normal trusted publication | Maven Central credentials and signing key; optional support-approved `CRATES_IO_VERSION_RUN_CAPACITY` only when more than 30 Cargo versions are pending | main only; independent approval when available |

Use a GitHub App or narrowly scoped bot token for `RELEASE_PR_TOKEN`; PRs created by the default workflow token do not trigger the normal PR workflow. Keep bootstrap tokens out of repository secrets and out of `release-publish`. Delete/revoke them immediately after trusted publishers are configured.

Every release environment must use a `main`-only deployment branch policy.
Environment approval is optional for dry-run and recommended for the
irreversible bootstrap and publish operations when a second maintainer is
available. In that case, require the independent reviewer and prevent
self-review. A solo-maintained repository must leave self-review prevention
disabled so publication remains possible; manual dispatch plus exact-SHA
qualification, current-main revalidation, and the frozen lock are the viable
solo controls.

Actions must allow OIDC and artifact attestations. Normal Cargo publication's
in-process broker follows crates.io's documented OIDC exchange and revocation
protocol: it requests audience `crates.io`, exchanges the GitHub JWT for a
30-minute registry token, masks it before use, starts at most 20 carriers and
no work after 20 minutes on that token, and revokes it in `finally`. A fresh
batch receives a fresh token; `id-token: write` alone does not authorize a
registry upload. The frozen Cargo uploader sends the lock-matching `.crate`
through crates.io's Registry Web API instead of asking `cargo publish` to
repackage it.

### Trusted-publisher identity through the reusable workflow

GitHub's standard OIDC claims describe the top-level caller, while
`job_workflow_ref` describes the called reusable workflow. Consequently,
crates.io and npm must be configured with the dispatcher filename
`release.yml`, **not** `release-execute.yml`. The protected environment belongs
to the called job and is still emitted as the `environment` claim. The workflow
performs a read-only live-token check of all three values before either
mutating operation.

| Registry | Exact external configuration | Branch binding |
| --- | --- | --- |
| crates.io | owner `f0rr0`, repository `oliphaunt`, workflow filename `release.yml`, environment `release-publish` | crates.io has no branch field; the GitHub `release-publish` environment must allow only `main` |
| npm | owner `f0rr0`, repository `oliphaunt`, workflow filename `release.yml`, environment `release-publish`, allowed action `npm publish` | npm has no branch field; the GitHub `release-publish` environment must allow only `main` |
| JSR | link `@oliphaunt/ts` to GitHub repository `f0rr0/oliphaunt` | JSR has no workflow filename, environment, or branch publisher field; the workflow and GitHub environment enforce `main` |

This distinction follows GitHub's [OIDC behavior for reusable
workflows](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows),
the [crates.io trusted-publishing setup](https://crates.io/docs/trusted-publishing),
npm's [trusted-publisher fields and reusable-workflow
behavior](https://docs.npmjs.com/trusted-publishers/), and JSR's
[repository-link publishing model](https://jsr.io/docs/publishing-packages).
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
tools/dev/bun.sh tools/release/trusted-publisher-config.mjs --lock "$lock"
```

Authenticated `--audit` remains read-only. Mutation exists only behind the
literal `--apply` flag *and* an exact `--confirm-lock-digest`; the tool first
audits the entire selected batch, refuses every mutation if it finds a wrong or
extra configuration, creates only missing configurations, and re-audits after
creation. It never revokes or replaces a registry configuration. A failed or
expired-auth run is resumable by rerunning the same lock and batch: exact
configurations are skipped, while conflicts still fail closed.

The dispatcher callers intentionally omit both named secrets and
`secrets: inherit`. GitHub resolves only the environment secrets selected by
the called job (`release-pr`, `release-bootstrap`, or `release-publish`) and
automatically provides the scoped `GITHUB_TOKEN`. Caller permissions are a
ceiling that the reusable workflow cannot elevate. Both caller and called jobs
grant `id-token: write` for normal publish; bootstrap also grants only OIDC in
addition to repository-read permissions because npm provenance needs it.

Audit the live controls without changing them:

```sh
tools/dev/bun.sh tools/release/audit-github-release-controls.mjs \
  --governance solo \
  --bootstrap-state ready
```

Use `--governance team` only when an independent maintainer is actually
available. Use `--bootstrap-state retired` after the one-time Cargo/npm tokens
have been revoked. The auditor reads the canonical repository through `gh api`,
prints deterministic `PASS`/`WARN`/`FAIL` findings, and exits nonzero only for
hard release-safety findings (usage, authentication, or API errors exit `2`). It
reads environment secret names, never values; the authenticated account
therefore needs permission to inspect repository and environment settings.
Warnings cover optional team governance and repository
hygiene and do not block a solo release.

## Registry ownership

The publication catalog is the identity inventory. Generate/query it rather than maintaining a package list in this document. Before bootstrap, verify every selected identity is absent or already owned by the intended maintainer. A conflicting public identity is a blocker, not a reason to rename an artifact silently.

### crates.io

1. Create the maintainer account/team.
2. Inventory the exact first-release lock. Crates.io's documented per-user new-name limit is a burst of 5 followed by one new crate every 10 minutes. The current complete catalog declares 417 unique Cargo names, so publishing all of them from an untouched default bucket has a 68-hour-40-minute rate-limit floor and cannot fit the six-hour release job. Request an exceptional new-crate capacity from [crates.io support](https://crates.io/support) before dispatching bootstrap; crates.io documents that such exceptions are exceptional on its [publishing rate-limits page](https://crates.io/docs/rate-limits).
3. Store `CRATES_IO_NEW_CRATE_RUN_CAPACITY` as a numeric secret in the protected `release-bootstrap` environment. It is an operator assertion of the currently available, crates.io-confirmed immediate new-name capacity for the publishing account, not a bypass switch. Do not guess the value or set it merely to satisfy CI. For a complete first release where all 417 names are absent, the confirmed value must be at least `417`; a resumed bootstrap may require less because the gate inventories every exact-lock name again.
4. Use the protected `publish-bootstrap` operation for only the missing first versions. Before initializing its ledger or sending any npm/Cargo mutation, the workflow queries crates.io read-only, reports exact selected/existing/missing counts and the default minimum duration, validates the numeric capacity, and refuses an undersized or malformed assertion. The mutation deadline is fixed 30 minutes before the six-hour job timeout.
5. Give the one-time scoped API token the `publish-new` and `trusted-publishing` endpoint scopes and only the `oliphaunt*` and `liboliphaunt*` crate scopes. After bootstrap seals, expose that same one-time bootstrap token to the local process as `CRATES_IO_TRUST_CONFIG_TOKEN`, then run the lock-derived read-only audit and explicit apply below. The crates.io API is queried per exact crate; any wrong or additional configuration blocks the whole apply before it creates another one.

   ```sh
   lock=target/release/publication-lock.json
   digest="$(jq -er .lockDigest "$lock")"
   tools/dev/bun.sh tools/release/trusted-publisher-config.mjs \
     --audit --ecosystem cargo --lock "$lock"
   tools/dev/bun.sh tools/release/trusted-publisher-config.mjs \
     --apply --confirm-lock-digest "$digest" --ecosystem cargo --lock "$lock"
   ```

   The first audit exits `1` while configurations are missing; that is an
   expected read-only finding, not permission to weaken the apply guard. Run it
   once more after apply and retain its zero-missing, zero-conflict JSON report
   with the release evidence. `CRATES_IO_TRUST_CONFIG_TOKEN` is only the local
   process alias for the already-protected bootstrap token: do not duplicate it
   as another GitHub secret or put its value in a file, command argument, log,
   or shell history.
6. Revoke `CRATES_IO_BOOTSTRAP_TOKEN`, remove `CRATES_IO_NEW_CRATE_RUN_CAPACITY`, and remove both from `release-bootstrap`.
7. Run normal `publish`; its bounded in-process broker must acquire, mask, use,
   and revoke fresh OIDC-exchanged tokens for at most 20 Cargo carriers and 20
   minutes per batch.

Crates.io returns `429` with an HTTP-date `Retry-After` when a publish bucket is
empty. The frozen publisher retries only that explicit non-mutating rejection,
using the exact same locked bytes and only while the bounded mutation deadline
can accommodate the server delay. Ambiguous transport and other server errors
are never blindly replayed: registry state is checked, matching bytes resume,
and otherwise the immutable checkpoint chain is used by the next run.

Normal publication has a separate per-user version-update bucket: 30 versions
immediately, then one version per minute. The pre-mutation gate uses that
documented burst of 30 when `CRATES_IO_VERSION_RUN_CAPACITY` is absent, so an
ordinary release with at most 30 pending Cargo versions needs no capacity
secret. Updating all 417 current Cargo names from a full default bucket has a
6-hour-27-minute rate-limit floor, longer than the release job. For any exact
lock with more than 30 pending versions, obtain sufficient capacity from
crates.io and store `CRATES_IO_VERSION_RUN_CAPACITY` as a numeric secret in
`release-publish`; it is an operator assertion of the currently available,
support-confirmed capacity and must cover every pending version. Do not add the
secret merely to satisfy CI. The live-controls auditor treats it as an allowed
optional override, not a universal release credential. The normal-publish gate
inventories every exact `name@version` before tags or packages are mutated and
rejects missing names that should have gone through bootstrap.
It also reserves 30 seconds per pending Cargo carrier from the remaining
bounded mutation window; a late run fails before mutation instead of assuming
that a support exception also makes uploads instantaneous.
Trusted-publishing credentials are also bounded: crates.io issues each token
for 30 minutes, so the Cargo executor refreshes and revokes tokens in batches
well inside that lifetime rather than retaining the workflow's first token.

Generated Cargo `part-N` crates are allowed only when a `.crate` would exceed crates.io's package-size limit. They are carriers in the frozen lock, publish before their aggregator, and are not independent release products.

### npm

1. Create/claim the `@oliphaunt` scope and require public access/provenance in package metadata.
2. Bootstrap only identities whose settings page cannot exist before a first publish.
3. Use npm CLI 11.15.0 or newer and an npm authentication method supported by
   `npm trust`; the account must have 2FA and every package must already exist.
   The setup helper retains npm's documented two-second spacing and divides the
   exact lock into deterministic batches of 25, leaving room inside each
   five-minute 2FA skip window for pre-audit, creation, and post-audit. For each
   `npmBatches[].number` printed by the no-network plan, run the read-only audit
   and then the explicit apply:

   ```sh
   lock=target/release/publication-lock.json
   digest="$(jq -er .lockDigest "$lock")"
   tools/dev/bun.sh tools/release/trusted-publisher-config.mjs \
     --audit --ecosystem npm --batch 1 --lock "$lock"
   tools/dev/bun.sh tools/release/trusted-publisher-config.mjs \
     --apply --confirm-lock-digest "$digest" \
     --ecosystem npm --batch 1 --lock "$lock"
   ```

   Repeat with the next batch number, completing npm's 2FA prompt when a new
   window is needed. The first audit exits `1` for missing configurations; its
   JSON is still the required pre-mutation inventory. Every exact package receives repository
   `f0rr0/oliphaunt`, caller workflow `release.yml`, environment
   `release-publish`, and only `npm publish`; staged publishing is never
   authorized. After all batches, rerun `--audit` for every batch and retain
   the zero-missing, zero-conflict reports.
4. Revoke `NPM_BOOTSTRAP_TOKEN`; normal publishing uses npm trusted publishing and no `NODE_AUTH_TOKEN`.

Target-specific npm packages are intentional carriers. Routine payload-splitting packages are forbidden; an npm tarball contains the target payload directly and stays within the registry's documented limits.

### JSR

Create the `@oliphaunt` scope and `@oliphaunt/ts` package, then link it to `f0rr0/oliphaunt`. The normal workflow uses JSR's GitHub Actions OIDC path. Its read-only readiness gate queries JSR's management API and fails before qualification downloads or release mutations unless the package exists and exposes that exact repository link. Do not configure `JSR_TOKEN` unless JSR's documented bootstrap process explicitly requires one, and never retain it for normal releases.

JSR requires the actor who dispatches the GitHub workflow to be a member of the
JSR scope by default. Keep that safer default and make every release operator a
scope member; if the scope setting is deliberately relaxed, record that
decision in the external controls audit. This actor-membership policy is not
visible through the repository's unauthenticated readiness query.

### Maven Central

Verify control of `dev.oliphaunt` in Central Portal. Store the portal username/password and in-memory GPG key/id/passphrase only in `release-publish`. Before any mutation, the normal workflow uses the authenticated read-only Publisher API to prove that those credentials can access the exact `dev.oliphaunt` namespace and rejects catalog groups outside it. Publish the identities declared by the catalog: the Android AAR, Gradle plugin and marker, runtime/extension ABI carriers. Do not publish an undeclared Kotlin Multiplatform/JVM root module.

### SwiftPM and GitHub Releases

Product tags use `<product>-v<version>`. SwiftPM additionally consumes an unscoped semantic tag; because legacy unscoped tags occupy versions through `0.5.1`, the first Oliphaunt Swift version is `0.6.0`.

Release Please owns product versions, changelogs, and the generated release PR.
After final current-main validation, the protected publish workflow stages each
selected product tag and draft GitHub release directly at the qualified SHA.
The workflow then uploads checksum-covered assets, completes registries and
clean-consumer checks, and promotes drafts. A failed publish must leave drafts
unpromoted.

## First release sequence

1. Confirm selected registry identities and product tags do not conflict.
2. Merge the introduction tree through the qualified path. Its parent must be
   the full `bootstrap-sha` boundary recorded in `release-please-config.json`,
   so legacy release commits are excluded from the first product releases. Do
   not rewrite history after any affected identity is public.
3. Run `prepare-release-pr` from current `main`; review the single generated release-bump commit.
4. Merge it and wait for that exact commit's non-cancelled `Qualified` CI run.
5. Run `publish-dry-run`. It must download that run's artifacts, create/freeze the publication lock, and perform clean package/install checks without credentials.
6. If npm/crates first identities are missing, run `publish-bootstrap`. It writes a genesis checkpoint before the first registry mutation, appends immutable byte receipts throughout the run, and uploads the chain even on failure. A retry for the same exact SHA restores and validates that chain before resuming. After the chain seals, use the exact lock's `trusted-publisher-config.mjs` plan, audit, and explicit apply flow above; retain the final reports and revoke the bootstrap tokens. Bootstrap does not promote GitHub releases or publish unrelated registries.
7. Run normal `publish` on the same current `main` SHA. The workflow revalidates current main, qualification record, artifact hashes, lock, registry state, tags, and consumer installs.
8. Preserve the publication lock, ledger, provenance, and workflow URL with the release.

The first generated release PR consumes the one-time `bootstrap-sha` boundary.
`sync-release-pr.mjs` removes it on that PR once any manifest entry advances
from `0.0.0`; the release-bump commit must contain that removal. Never delete
the boundary on the unreleased introduction tree, and never restore it after
the first release bump.

`release_commit` is only an equality assertion for the workflow commit; it cannot select an older commit. Release tooling fixes create a new candidate SHA and require new qualification. There is no temporary Release Please target branch.

## Recovery

Publishing is resumable but not cross-registry atomic. On failure, preserve and validate the complete content-addressed checkpoint chain, then inventory all selected identities against the frozen lock. Matching immutable versions may be skipped only after registry bytes are proved; a mismatched version/tag/asset or ledger checkpoint stops the release. Repository changes require a new version and new exact-SHA qualification. Use `.codex/skills/release-oliphaunt/references/recovery.md` for the recovery and pre-publication history-repair procedure.

## External readiness checklist

- the read-only GitHub controls audit has no `FAIL` findings for the applicable
  solo/team and bootstrap-ready/retired modes;
- main requires `Required`, squash-only merges, linear history, resolved
  conversations, stale-approval dismissal, administrator enforcement, and no
  force-push or deletion;
- every release environment is restricted to `main`; bootstrap and publish use
  independent approval and prevent-self-review when a second maintainer exists,
  while solo operation keeps self-review prevention disabled;
- `release-pr` can create a PR that triggers normal CI;
- dry-run has no write credentials;
- bootstrap tokens are absent unless a reviewed first-identity run is imminent;
- every Cargo and npm identity uses dispatcher `release.yml` and environment
  `release-publish` (never reusable implementation `release-execute.yml`), npm
  allows `npm publish`, and neither registry is expected to bind a branch;
- the exact-lock trusted-publisher audit reports every selected Cargo/npm
  identity exact, with zero missing and zero conflicting/extra configurations;
- JSR `@oliphaunt/ts` links to `f0rr0/oliphaunt`, and each workflow dispatcher
  is a JSR scope member while the default actor restriction is enabled;
- Maven namespace, signing key, and Central Portal credentials validate;
- registry owners and GitHub maintainers can recover/revoke credentials;
- a clean consumer can install each selected ecosystem façade from staged/local registries before public publish.
