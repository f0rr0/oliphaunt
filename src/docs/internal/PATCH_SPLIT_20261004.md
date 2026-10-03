# Patch consolidation: separate policy decisions

PR #218 is rebased onto remote main `ea89d7fb58059011c199e66fdc590999fee809a6`.
The pre-rebase head is `8d57e35902367efc8a51b5f16dfd4cc9a55f5a87`.

Two independent follow-ups target the consolidated branch, not each other:

| Branch | Change | Known trade-off |
| --- | --- | --- |
| `f0rr0/patch-correctness-refresh` | Patch cleanup, trusted login, error recovery, large responses and terminal cleanup; retain main's fsync/compiler defaults | Not a claim of zero residual performance cost or complete platform qualification |
| `f0rr0/native-fsync-default` | Stop injecting native `-F`; default native direct/broker sessions to `fsync=on`, keeping ordinary PostgreSQL overrides | Earlier controlled autocommit measurements were about 9.4× slower; matched fsync-on main was close |
| `f0rr0/wasix-strict-memory-policy` | Disable nonvolatile LLVM memory optimizations for embedded/tool AOT and Postmaster; move the matching profile, cache, carrier and verifier changes together | Earlier exact-guest isolation measured about 9–15% in several memory workloads; this also affects directory-mode execution |

“Volatile” is a compiler memory-access rule, not a storage mode. Neither child
changes WASIX directory fsync policy or the browser's V8 compiler. No new public
flag or runtime choice was added to create the split.

Retaining main's native default also retains its crash-safety limitation:
persistent storage with `fsync=off` is not a durable commit guarantee. Retaining
main's nonvolatile compiler policy leaves its known required-out-of-bounds-trap
semantics concern unresolved. These are isolated decisions, not rejected fixes.
The Postmaster strict policy is a related shared-memory correctness change;
the embedded benchmark percentages are not Postmaster measurements.

## Rebase choices

- Preserve main's October SJLJ fix and zero partial-link inline threshold,
  alongside the consolidated live guest recovery boundary.
- Keep main's bounded source acquisition, virtual-fs/virtual-mio wake fixes,
  source-only documentation checks and rewritten short SDK READMEs.
- Keep compiler-policy identity checks and producer/verifier agreement on every
  branch. AOT artifacts from different policies must not be relabelled or mixed.
- Keep native configuration/role fixes, large-result and terminal-close tests,
  patch ordering, and uncertainty handling for interrupted writes in #218.

## Evidence boundaries

The September benchmark and runtime reports are historical comparisons of the
combined candidate. The rebase includes a main-side SJLJ code-size change, so
those numbers do not qualify these exact new commits or predict their precise
performance. Source checks and patch replay for this split are recorded in the
PR descriptions; hosted CI must qualify each new head before merge/publication.

Windows recovery (#208), execution-stack protection, CPU-bound WASIX
cancellation and fresh full Postmaster/platform qualification remain separate
unfinished work. Splitting the two policies does not solve those blockers.
