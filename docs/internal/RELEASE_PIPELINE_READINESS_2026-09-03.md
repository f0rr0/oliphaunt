# Release pipeline readiness — 2026-09-03

Baseline: freshly fetched `origin/main` at
`6b3e16aed489507cc9140c0dacb677785792da7d`. `HEAD` and `origin/main` were
rechecked after the audit and still matched. This report closes the execution
and hosted-limit work from the broader
[`CI_RELEASE_PROCESS_AUDIT_2026-09-02.md`](CI_RELEASE_PROCESS_AUDIT_2026-09-02.md)
and
[`REPOSITORY_ORGANIZATION_AUDIT_2026-09-03.md`](REPOSITORY_ORGANIZATION_AUDIT_2026-09-03.md).

## Executive verdict

The repository code now has one coherent release path, and the locally
executable portions pass. It is not honest to call the next release fully
proved until a fresh GitHub run exercises this diff. The live release-control
configuration now matches the chosen administrator-bypass policy.

| Boundary | Current verdict | Evidence |
| --- | --- | --- |
| Create/update release PR | **Locally proved; hosted rerun pending** | The real 84-file candidate from PR #167 was rebased onto current `main`, reduced to one exact-parent commit, synchronized to a fixed point, and accepted as a 20-product release by the current verifier. |
| Generated release PR CI | **Graph and gates proved locally; hosted rerun pending** | Product task edges, affected selection, release metadata, mutation units, workflow security, and representative product compile/unit/package tasks pass. Release candidates still use normal PR CI. |
| Merge to `main` | **Exact prior failure fixed; hosted rerun pending** | The latest live main run failed because a build-only Postmaster job inherited `test` and timed out. Builds now consume compile/package data only; test remains a separate gate. |
| Product/release dry run | **Locally proved except hosted artifact/platform access** | It waits for exact-SHA `Builds`, `Required`, and `Qualified`, downloads artifacts by run and artifact identity, assembles carriers, and stores a digest-bound lock/capsule for 90 days. It has no registry-write permission. |
| Actual release | **Code path locally proved; hosted rerun pending** | Publish repeats exact candidate assembly, byte-compares the approved dry-run lock, stages drafts, publishes frozen bytes, tests public consumers, and promotes drafts last. No real registry mutation was attempted in this audit. |

## The target execution model now implemented

1. `prepare-release-pr` requires the exact current `main`, generates the
   candidate, normalizes it to one commit whose parent is current `main`,
   synchronizes derived files, verifies the selected release products, and
   pushes with an exact force-with-lease.
2. PR CI runs affected static, compile, unit, package, behavior, and E2E tasks.
   Product builders no longer inherit already-visible unit gates.
3. The merge SHA runs full release qualification and emits an exact-SHA
   `oliphaunt-release-candidate` record plus any required artifact evidence.
4. `publish-dry-run` consumes that qualified run, recreates public carriers,
   checks registry collisions, and freezes the publication lock and bootstrap
   capsule. This is candidate assembly and approval, not a simulated write.
5. `publish` requires the same exact SHA and an approved dry-run, recreates the
   candidate, byte-compares the locks, then performs resumable mutations. It
   promotes GitHub drafts only after registry and clean public-consumer checks.

The release workflow no longer reruns the full release mutation-unit suite in
release-PR preparation, dry-run, and publish. Those steps now run the metadata
gate their names claim. Mutation units are owned by CI and by the explicit
local `release-check.mjs` maintainer gate.

## Adversarial failures found and fixed

| Demonstrated failure | Root cause | Fix |
| --- | --- | --- |
| Latest `main` CI failed after 103.5 minutes in `Builds / wasix-postmaster (macos-arm64)` although the visible Postmaster test had passed. | A build artifact task inherited `test`; the duplicate test exited 124. | Semantic `compile`, `unit`, and `package` tasks now separate data edges from qualification edges. |
| Release PR preparation run 33628150501 rejected the generated branch after `main` advanced. | Normalization required the PR head to descend from the exact current `main`, so an ordinary stale release branch was unrecoverable. | Normalize now verifies the merge base, rebases canonical history onto current `main`, collapses it to one commit, and retains exact force-with-lease protection. Conflicts and unrelated history still fail. |
| The rebased real release candidate failed validation on generated WASIX npm dependency versions. | The verifier did not recognize version-only rewrites in the WASIX tools facade and pnpm importer as derived release files. | Sync and verification now share the exact workspace dependency bindings and derived facade inventory. The real candidate then passed for all 20 products. |
| `release-publish` was incorrectly required to accept transport tags. | The controls auditor conflated bootstrap continuation with normal publish. | Only `release-bootstrap` permits `oliphaunt-release-transport/*`; normal publish is main-only. |
| A successful publish spent an artificial hour before its first GitHub content write. | A fresh per-run journal imposed a full rolling-hour cooldown even though all writes were already globally spaced by 10 seconds. | The cold-start delay and environment state were deleted. The durable exact-lineage journal, lock, deadline, retries, and 10-second interval remain. The first reservation is immediate. |
| Release evidence expired earlier than the supported approval window. | WASIX qualification evidence used 30 days and the exact candidate record used 14. | Both now use the repository's 90-day release-evidence window. |

## Chaos and dependency results

- A JavaScript SDK-only edit does **not** rebuild the Node Direct native addon.
- A Node Direct edit selects the addon and its downstream JavaScript SDK.
- A WASIX Node-API edit selects its actual WASIX runtime/AOT/carrier inputs.
- WASIX Node-API prose and isolated unit fixtures do not start artifact builds.
- Shared contrib source selects both runtime owners but no fictitious contrib
  release product.
- Each of the seven external extensions remains one independently versioned
  source product. Native and WASIX targets are already distinct carrier
  families, so splitting the versioned product would duplicate releases rather
  than clarify them.
- All Moon artifact-data edges point to tasks with declared outputs; ordering
  gates do not pretend to transport artifacts. The focused graph suite is
  Moon-cached and returned in about 0.1 seconds on identical reruns.

The remaining exhaustive work on a release bump is expected: a candidate that
bumps many public products must build and qualify those products. What was
removed is unrelated work, duplicate upstream execution, and release-tool unit
tests repeated at every release phase.

## PR #170 cold-runner follow-up

[CI run 33731039633](https://github.com/f0rr0/oliphaunt/actions/runs/33731039633)
on exact commit `a17cbdccbf6ed7acf7cdd3a0171101339f0b48d7` exposed three
fresh-checkout assumptions. The failures and fixes are intentionally narrow:

| Failed surface | Actual cause | Fix and retained proof |
| --- | --- | --- |
| Static docs check, macOS release metadata, and Vercel | The deleted duplicate favicon left an empty local `src/docs/static` directory, but Git does not preserve empty directories. The generator still required that directory. | Removed the obsolete copy step. Docs generation still owns and recreates its generated static output; the 44-route check passes after physically removing the local source directory. |
| Rust SDK and WASIX Rust binding package jobs | Final `.crate` test-closure validation is deliberately offline, but the package job had not fetched the root lock on a cold runner. | Each Cargo SDK artifact wrapper now fetches the exact locked dependency graph before offline closure validation. Both products pass from separate empty Cargo homes; the offline final-crate test remains. |
| Release tooling unit job | Its real concurrent Cargo packager test ran without Rust setup because `release-tools:unit` did not declare `ci-rust`. Two rustup proxies then raced to install the missing toolchain. | Declared the truthful Rust capability. The concurrency test remains unchanged and the full release-tools suite passes. |

Visible CI naming is now responsibility-first and consistent without changing
stable job IDs or gate protocols. Static partitions list the exact Moon targets
they run instead of `static 1/4`; unit jobs use readable project/task labels;
native extension lifecycle partitions show their extension count and members;
and build leaves use product, artifact role, and target. The aggregate `Checks`,
`Tests`, `Builds`, `E2E`, `Required`, and `Qualified` names remain stable because
release replay, mobile E2E, and repository policy consume them as protocol
identities.

Focused local proof for this follow-up:

- both Cargo SDK final-package closures from independent empty Cargo homes;
- the complete five-minute release-tools mutation suite, including the exact
  concurrent Cargo test that failed on GitHub;
- actionlint, zizmor, workflow security, planner chaos tests, and toolchain
  bootstrap tests;
- release metadata and docs generation with no `src/docs/static` directory;
- task-capability, label, and native lifecycle partition tests; and
- Vercel deployment logs confirming the same removed-directory root cause.

## Hosted time and capacity

Observed GitHub history:

| Run | Result and wall time | Interpretation |
| --- | --- | --- |
| [Latest main CI 33628129735](https://github.com/f0rr0/oliphaunt/actions/runs/33628129735) | Failed, 103.5 min; about 879 runner-minutes | Exact hidden-test/build failure fixed by the task model. Queueing delayed one 4-minute leaf by about 57 minutes. |
| [Successful full CI 31276212829](https://github.com/f0rr0/oliphaunt/actions/runs/31276212829) | Passed, 99.5 min | A genuinely full release graph should still be budgeted near 100 minutes plus queue variance. |
| [Successful dry run 31299792169](https://github.com/f0rr0/oliphaunt/actions/runs/31299792169) | Passed, 36.5 min | Best available hosted baseline for exact-SHA candidate assembly. |
| [Successful publish 31304325013](https://github.com/f0rr0/oliphaunt/actions/runs/31304325013) | Passed, 75.6 min | Proves the registry/consumer/finalization shape, but predates this refactor and is not a reliable new-duration promise. |

Removing the cold-start wait saves up to 60 minutes before the first write.
The remaining GitHub mutation time intentionally scales at roughly 10 seconds
per write; a release with about 210 actual content mutations can spend about 35
minutes in pacing if none of those operations already exists. Resumable reruns
reconcile and skip completed mutations.

Current workflows remain inside documented GitHub ceilings:

- CI is 147 KB and Release is 100 KB, below the 500 KB workflow-file limit;
- the observed full run had 100 jobs, below the 256-job matrix limit; and
- release jobs use a 360-minute maximum, equal to GitHub's 6-hour hosted-job
  ceiling. The release code also reserves 54 minutes for final verification
  before its internal mutation deadline.

GitHub documents a 1,000-request/hour primary limit for `GITHUB_TOKEN`, 100
concurrent requests, 900 REST points/minute, and generally 80 content writes
per minute or 500 per hour. The release journal caps the job at 900 core
request attempts, the read layer honors reset/retry delays, and the retained
10-second content pacer admits at most 7/minute or 361/hour within the
serialized release job. The one-hour cold start provided no additional
steady-state protection. See
[GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [Actions limits](https://docs.github.com/en/actions/reference/limits).

The last successful publication lock had 303 registry carriers (220 Cargo, 59
npm, 23 Maven, and one JSR) and 152 GitHub assets across 18 releases. Its largest
release had 19 assets; its largest asset was 75.6 MB. GitHub permits 1,000 assets
per release, each under 2 GiB. See
[GitHub release quotas](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

Registry boundaries also fit:

- crates.io limits a `.crate` to 10 MB; the largest locked Cargo payload was
  9.10 MB and every packager enforces the bound. See
  [Cargo publishing](https://doc.rust-lang.org/cargo/reference/publishing.html).
- crates.io's current server defaults are a burst of 5 new names followed by
  one every 10 minutes, and a burst of 30 version updates followed by one every
  minute. A 220-name first bootstrap therefore cannot fit in one hosted job;
  the content-addressed continuation design is necessary. An ordinary 220-name
  update needs at most about 190 minutes of token refill, inside the 330-minute
  registry window. See the pinned
  [crates.io rate-limiter source](https://github.com/rust-lang/crates.io/blob/2e1b870971b57caddc4c10d6be52189e04ba06d9/src/rate_limiter.rs).
- npm trusted publishing requires npm 11.5.1+ and Node 22.14+; the workflow pins
  Node 22.22.3 and npm 11.18.0. npm recommends two seconds between trust
  configuration calls and estimates about 80 within its five-minute 2FA skip;
  the repository uses two seconds and batches of 25. See
  [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
  [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
- Maven Central permits a bundle up to 1 GB; the last locked Maven payload was
  135.6 MB and the code rejects `>= 1,000,000,000` bytes. See
  [Central Portal upload limits](https://central.sonatype.org/publish/publish-portal-upload/).

One operational cost remains visible: the latest full CI run stored 78
artifacts totaling 2.69 GB. Release-critical lock, capsule, qualification, and
attestation evidence intentionally uses 90-day retention. Do not shorten that
evidence below the approval window; if Actions storage becomes a billing
constraint, remove superseded non-release diagnostics/build artifacts through
a separate retention policy rather than weakening release reproducibility.

## Live repository settings

After an explicitly authorized settings correction, the read-only live controls
audit reports **39 PASS, 0 WARN, 0 FAIL**. Administrator branch-protection
bypass is intentional and is no longer treated as a release-control failure.

The `oliphaunt-release-transport/*` tag rule was removed from
`release-publish`, which now allows only branch `main`. A separate read verified
that `release-bootstrap` still allows branch `main` and the exact transport-tag
namespace required by continuations. Secret *names* and environment isolation
match the workflow, but local execution cannot prove the current value, expiry,
ownership, or provider-side authorization of protected credentials. Publish
therefore rechecks npm/Cargo ownership and trust, Maven credentials/signing
identity, tag/release collisions, and the approved lock before its first
irreversible registry write.

## Qualification ledger

Passed on the final tree:

- full `tools/release/release-check.mjs`, including metadata and every
  policy/release mutation unit file;
- `tools/policy/check-workflows.sh`: actionlint, zizmor, workflow security,
  planner chaos tests, and fail-closed pinned toolchain bootstrap tests;
- `release-metadata-check.mjs` after replacing the redundant workflow gates;
- real PR #167 candidate normalization/synchronization and current
  `verify-release-commit.mjs` for all 20 selected products;
- focused pacer concurrency, deadline, malformed-journal, and test-isolation
  tests;
- product task/edge invariants and 21 affected-selection chaos cases;
- Postmaster `compile` and `unit`, including sealed-carrier packaging tests;
- live GitHub settings audit: 39 PASS, 0 WARN, 0 FAIL;
- repository formatting and `git diff --check`; and
- final fetch proving `HEAD == origin/main` at the audited baseline.

Not locally executable on this Linux host: macOS/iOS builds, Android device
E2E, Windows builds, GitHub environment enforcement, OIDC token exchange, or
real immutable registry publication. Those existing hosted proofs were not
removed. A fresh GitHub release-PR/main/dry-run sequence is the remaining proof
for this exact diff; actual publish should not be dispatched until that sequence
is green.

## Change ledger for this final adversarial pass

- Completed `liboliphaunt-wasix-postmaster:qualify` with the packaged runtime,
  smoke, regression, stress, and recovery chain already owned by `release-assets`.
- Rebased stale canonical Release Please branches safely during normalization.
- Added exact generated WASIX facade/importer dependency ownership to release
  synchronization and verification.
- Corrected normal-publish versus bootstrap environment tag policy.
- Extended exact release qualification records to 90-day retention.
- Deleted the one-hour GitHub content-write cold start while retaining bounded
  pacing and journals.
- Replaced three repeated full mutation-suite executions in release-PR,
  dry-run, and publish with truthful metadata validation.
- Removed the live transport-tag deployment rule from `release-publish` and
  verified that `release-bootstrap` retained it.
- Recorded administrator branch-protection bypass as intentional governance
  rather than a release-safety finding.
- Corrected the JavaScript SDK command guide so `compile` no longer claims the
  npm package-shape proof owned by `package`.
- Removed the retired `--skip-package-size` option from the live WASIX
  performance recipe; dated command transcripts remain historical records.

Aggregate product behavior coverage is unchanged. The removed source-string
checks and repeated gates provided earlier or duplicate diagnostics, not unique
runtime proof. Compile, package reopening, installed-product smoke, regression,
mobile lifecycle, exact-SHA qualification, registry reconciliation, public
consumer checks, and final attestations remain.
