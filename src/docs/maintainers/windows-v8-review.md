# Windows V8 code and CI review

Reviewed the integration branch at `30b1ad2a91034c8343abeb1b08f53a081550d35a`
and its isolated native qualification controls. This pass changes tooling and
checks; engine patch bytes and SDK dependency selection stay as tested.

The maintained Wasmer/WASIX correction is appropriately sized for the required
SDK behavior. Keep it in the engine and WASIX task/linker paths. Remaining
release work is engine delivery, notices, matching CPU artifacts and installed
WASIX SDK qualification. Feasibility is established; production integration is
incomplete.

The subsequent [public API and behavior review](windows-v8-api-review.md)
found an engine delivery error-handling blocker and two general memory API
limits. Resolve those before activation; the lifetime stress results do not
establish permanent guest-entry prevention or memory-level cancellation parity.

## Findings fixed

| Finding | Correction |
| --- | --- |
| The whitespace hook rewrote significant `.diff` context and invalidated source digests. | Exclude `.patch` and `.diff` from whitespace and EOF rewriting. Other validation still applies. All 89 existing patch/diff hashes remain unchanged. |
| Four tracked files failed the EOF hook. | Normalize only final newlines in two workflows, the OpenSSL Moon declaration and an Android test manifest. |
| DLL preparation recorded dependency resolution without comparing it. | Reject changes beyond replacing the pinned Wasmer source, matching the static control. Remove an overwritten path assignment. |
| Interruption validation accepted a summary without checking all records. | Require 25 ordered wait cycles, 35 waiter results below three seconds, 32 ordered teardown races and matching counts. The fallible variant also requires all 256 attachment attempts and rejects panic output. |
| Fixture generation could silently miss replacements after source drift. | Check every replacement before applying it. Generated native fixture bytes remain identical to the qualified version. |
| The historical probe repeated expensive stock-backend diagnostics on branch pushes. | Make it manually dispatched. Preserve negative controls and their immutable results for reproducing upstream gaps. |
| The strengthened checker had no normal CI regression task. | Add one offline, product-owned Moon unit task and a planner regression proving checker/fixture edits select it without artifact producers or releases. |

The changes use Python's standard library and existing drivers, packager, Moon
graph and CI gate. No new framework, public option or SDK engine abstraction.

## Design and organization

The three maintained lifetime patches live in
[`src/wasix/runtime/engine`](../../wasix/runtime/engine/README.md). Other
candidate ownership, error, cached-loading and DLL/package controls remain in
[`tools/experiments/wasmer-v8`](../../../tools/experiments/wasmer-v8/expanded-ownership/README.md).
They are not normal release dependencies yet. Failed static-owner and stock
controls preserve regression evidence; they are not alternate shipping backends.

One capability per Store and one shutdown state per native shared memory cover
aliases and cross-Store attachments. Weak Store references permit operations to
outlive Stores; a mutex serializes termination with pointer retirement before
native destruction. All three WASIX attachment callers propagate the additive
fallible result through existing error types. The public SDK exposes none of
this engine machinery.

Combined Wasmer Rust changes touch thirteen existing files and one new file,
with 403 additions and 121 removals. WASIX policy/attachment changes touch four
files, with 27 additions and four removals, plus one internal SDK assignment.
Generated dispatch, DLL payloads, legal metadata and CPU production are extra
work. The historical experiment directory is not the shipping patch size.

## SDK boundaries

| Consumer | Actual dependency path and implication |
| --- | --- |
| WASIX Rust, `oliphaunt-wasix` | Owns the shared engine, module cache, WASIX runtime and AOT loading. Backend corrections and CPU selection belong here or below it. |
| WASIX Node/Bun/Deno/Electron, `@oliphaunt/wasix-ts` | The platform Node-API addon calls WASIX Rust. Package the corrected engine inside the addon; retain existing public options and async/error adapters. |
| WASIX browser | Uses the separate Wasmer JavaScript host. Native Windows V8 evidence does not qualify that host. |
| Native Rust and TypeScript | Use native PostgreSQL bindings/broker independently of WASIX. Preserve existing Windows regression lanes. |
| Kotlin and Swift | Current bindings use the native runtime. Kotlin publishes the Android AAR; JVM compilation/tests do not establish an installed Windows WASIX JVM SDK. Swift's Apple carriers are separate. |

Earlier notes calling for combined installed Rust/Node/JVM qualification were
too broad for the implemented dependency graph. Required engine delivery proof
is installed **WASIX Rust and Node** consumption. A future JVM WASIX adapter
needs its own implementation and qualification. Shared SDK contract, resource
or extension changes must retain their actual native/mobile consumer lanes.

## Validation and release limits

- Offline regressions reject summary-only evidence, missing/duplicate records,
  inconsistent counts, slow waits, unexpected panics and fixture drift.
- Rechecked four immutable native logs from runs
  [37371077177](https://github.com/f0rr0/oliphaunt/actions/runs/37371077177) and
  [37381922545](https://github.com/f0rr0/oliphaunt/actions/runs/37381922545).
  Both toolsets pass each variant. The generated Windows fixture still hashes
  to `0fe010d555802b541ebf359b40e40d205e6f5525ea07c7e141ff832ad479a81a`.
- The complete tracked-file pre-commit gate passes with all patch bytes intact.
- Replayed eight candidate patches against clean pinned registry sources. All
  guarded inputs pass; lifetime, fallible attachment, cached-loading policy and
  native-payload output hashes match both final native qualification receipts.
- The full `ci-workflows:check` gate passes, including pinned actionlint/zizmor,
  capability, affectedness, 71 planner tests and 11 transfer tests. The actual
  affected-unit matrix selects the new checker without Rust setup, a workspace
  install or artifact producers. Unit tasks use the separate test matrix.

Commands: `moon run liboliphaunt-wasix:engine-control-test
ci-tools:js-format-check ci-tools:js-lint ci-workflows:check`, `moon run
repo:prek`, Python syntax compilation, patch replay, native-log revalidation,
and Markdown lint. All pass. Two initial planner-test assertions used the wrong
artifact mapping/empty-dependency representation; correcting the test resolved
them without a production planner change.

No guest or engine implementation changed in this pass. Existing native
evidence retains its original source/run identities; another producer build
would not test new runtime bytes. Local tooling checks are not a new hosted
`Qualified` release gate.

Before activation, make the dependency family and engine carriers normal
declared release inputs, complete notices/provenance, produce the approved
SSE4.1-compatible artifact family for every guest, and qualify installed WASIX
Rust/Node consumption with guest compilation unavailable. Generic host atomics
and resumable cancellation remain outside the supported SDK path. The
[decision ledger](windows-v8-decision-log.md) retains detailed evidence.
The later [root-cause review](windows-v8-root-cause-review.md) specifies the
fallible delivery boundary and records small copy/terminal-contract proposals;
these are tested Linux experiments, not activated or Windows-qualified patches.
