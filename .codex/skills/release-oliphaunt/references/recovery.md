# Release and history recovery

## Failed or partial publish

1. Freeze further publication and save the workflow URL, candidate SHA, publication lock, complete checkpoint chain, and registry responses.
2. Validate every checkpoint digest and previous-checkpoint link. Confirm the source SHA/tree, lock/catalog digests, package envelope, and selected products are unchanged. Never hand-edit or truncate the chain.
3. Query every expected identity and GitHub tag/release. Classify it as absent, present-and-byte-matching, or conflicting. An existence-only response is not matching evidence.
4. Fix only the failed phase. Requalify a new commit if repository code/configuration changes; never attach old artifacts or a prior ledger to it.
5. Resume in dependency order from the newest validated checkpoint. Re-inventory the complete exact lock first: a carrier accepted before an ambiguous response or checkpoint interruption is recovery input, not permission to upload again. Skip it only after its registry checksum/SRI/payload/file manifest matches the frozen bytes. Bootstrap resumes with one sequential Cargo lane and one sequential npm lane, preserves cross-lane dependency barriers, and serializes canonical checkpoint appends.
6. Seal bootstrap only after every expected identity has a receipt. Promote draft GitHub releases only after the final all-registry receipt proof and exact-lock anonymous public-consumer probes produce their deterministic receipt-bound evidence. Retry a transient visibility failure only from a fresh cache under the original shared deadline; do not retry an exact identity/source/closure mismatch. Swift remains a source-tag/manifest probe before promotion because draft binary-target assets are not anonymously public. npm's normal tag is attached by its immutable version publish because OIDC does not authorize a later dist-tag mutation.

## Pre-publication main-history repair

This path is forbidden after any affected product tag/package is public.

1. Freeze main and verify the exact old tip. Create a uniquely named archive ref and an independently verified offline bundle for that tip.
2. Build the desired tree on a temporary branch based on the current main tip
   and run an all-target `workflow_dispatch` CI qualification before touching
   main. When the current tip is the still-unpublished generated first-release
   commit, the qualification transport must be its direct child on the exact
   branch exported as
   `RELEASE_PLEASE_HISTORY_REPAIR_CANDIDATE_BRANCH`. Its tree must restore the immutable
   `bootstrap-sha`, retain the complete configured package path set, restore
   every manifest and changed workspace package version to `0.0.0`, and prove
   that the parent manifest contained exactly each configured first version
   (including Swift `0.6.0`). Dispatch that exact ref with `wasm_target=all`,
   `native_target=all`, and `mobile_target=all`; a PR, push, main or tag ref,
   another branch, an indirect descendant, a partial reset, or a narrower
   target selection is not a qualification transport. Record the exact
   candidate SHA and run id, and keep that remote branch intact through
   rewritten-main qualification.
3. Create one tree-identical introduction commit on the intended stable parent. Its full message must contain exactly one `Oliphaunt-History-Repair-Candidate: <lowercase-full-candidate-sha>` trailer. Do not add the trailer to the tree or add a second commit. A reproducible signed construction is:

```sh
candidate=<qualified-temporary-branch-sha>
parent=<RELEASE_PLEASE_BOOTSTRAP_SHA>
tree="$(git rev-parse "${candidate}^{tree}")"
introduction="$(
  printf 'feat: introduce oliphaunt\n\nOliphaunt-History-Repair-Candidate: %s\n' "$candidate" |
    git commit-tree -S "$tree" -p "$parent"
)"
test "$(git rev-parse "${introduction}^{tree}")" = "$tree"
```

Keep the immutable Release Please bootstrap and displaced-main metadata boundaries unchanged. Set only `RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA` to the exact current main tip so the non-fast-forward exception is bound to this one attempt.
4. Temporarily allow only the minimum force-push authority. Push with `--force-with-lease=<main>:<recorded-old-sha>`.
5. Immediately restore branch protection, require pull requests/checks, and disable force-push.
6. Run the full, non-cancelled CI graph on the new introduction SHA. The release-intent job must select the exact recorded temporary-branch run, download its immutable plan/candidate artifacts by id and digest, prove that its retained remote branch still points to the trailer SHA, and prove that its candidate tree equals the introduction tree before planning any other job. Temporary-branch `Qualified` evidence proves the transport tree but remains ineligible for publication; only the later protected-main `Qualified` record is publishable.
7. If exact-main qualification finds another defect, do not append a fix commit or prepare a release. Repeat from step 1: archive the now-superseded introduction under a new ref and bundle, qualify the next replacement tree, and rotate only the one-shot repair predecessor. An older predecessor must remain rejected, so a completed exception cannot be replayed.
8. Only after the introduction passes exact-main qualification, prepare and review the generated release PR. The eventual desired public history is that single introduction commit followed by the single generated release-bump commit; qualify and publish only the exact release-bump SHA.

Do not automate repository-setting changes or the force-push without explicit maintainer authorization at execution time.
