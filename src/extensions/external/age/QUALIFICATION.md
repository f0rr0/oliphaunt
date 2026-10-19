# Apache AGE 1.8 qualification

**Draft: blocked by upstream traversal-cache correctness. Do not merge or describe AGE as qualified.**

This adds Apache AGE 1.8.0 for PostgreSQL 18, pinned to
`e43dc1a12b78fba4acef9835b2b10379b8d243b4`. The official release is
[PG18/v1.8.0-rc0](https://github.com/apache/age/releases/tag/PG18/v1.8.0-rc0)
(July 9, 2026; GitHub marks it as a release, despite the tag suffix).
PGlite's published AGE package currently contains version 1.7.0.

## Blocking correctness findings

Both failures reproduce with the unmodified pinned AGE source on stock
PostgreSQL 18. They are not explained by Oliphaunt's embedded backend.

| Trigger | Expected | Observed |
| --- | --- | --- |
| Cache a variable-length traversal; delete its edge inside a transaction; run the traversal; roll back | Original route is visible again | The cached empty graph remains in use |
| Writer deletes an edge but has not committed; another session caches the still-visible route; writer commits | Reader's next READ COMMITTED query sees no route | Reader retains the route although the edge table contains zero rows |

The first reproduction is retained in `src/test-fixtures/extensions/age.sql`.
It intentionally fails until the upstream defect is resolved. A successful
42-test upstream regression suite did not cover either case.

At the pinned source,
[`is_ggctx_invalid`](https://github.com/apache/age/blob/e43dc1a12b78fba4acef9835b2b10379b8d243b4/src/backend/utils/adt/age_global_graph.c#L235)
returns solely from a per-graph shared version counter once that counter is
nonzero. Cypher mutations increment that counter before commit. Neither
transaction rollback nor the later visibility of another transaction's commit
changes the counter, so a cache built at the intermediate state can remain
valid indefinitely. Checking only rollback callbacks would leave the second
failure unresolved.

A fix needs cache validity tied to PostgreSQL snapshot visibility and correct
commit/abort/subtransaction behavior, with both regressions and repeated
READ COMMITTED / REPEATABLE READ queries tested. This draft contains no
speculative correctness patch.

## Minimal stock PostgreSQL reproductions

Build the pinned source with normal PGXS (`make PG_CONFIG=/path/to/pg_config`
and `make install`), then use `psql -X -v ON_ERROR_STOP=1` against PostgreSQL 18.
In every session run `LOAD 'age'; SET search_path = ag_catalog, public;`.
Initialize once:

```sql
CREATE EXTENSION age;
LOAD 'age';
SET search_path = ag_catalog, public;
SELECT create_graph('cache_probe');
SELECT * FROM cypher('cache_probe', $$
  CREATE (:Person {name: 'Alice'})-[:KNOWS]->(:Person {name: 'Bob'})
$$) AS (v agtype);
```

Use this traversal as `Q` in the steps below:

```sql
SELECT * FROM cypher('cache_probe', $$
  MATCH (a)-[:KNOWS*1..2]->(b) RETURN a.name, b.name
$$) AS (a agtype, b agtype);
```

For rollback, in one session run `Q`, then:

```sql
BEGIN;
SELECT * FROM cypher('cache_probe', $$
  MATCH ()-[r:KNOWS]->() DELETE r
$$) AS (v agtype);
-- Run Q here: correctly returns no rows.
ROLLBACK;
-- Run Q again: should return Alice/Bob, but returns no rows.
SELECT count(*) FROM cache_probe."KNOWS"; -- 1, proving the edge was restored
```

For concurrent commit, recreate the fixture and use two fresh sessions:

1. A: `BEGIN`, then the same Cypher `DELETE` above; keep the transaction open.
2. B: run `Q`; it correctly returns Alice/Bob because A has not committed.
3. A: `COMMIT`.
4. B: run `Q` again under the default READ COMMITTED isolation. It incorrectly
   still returns Alice/Bob. `SELECT count(*) FROM cache_probe."KNOWS"` returns 0.

## Narrower cache-policy assessment

The pinned source defines only `age.enable_containment`; it has no GUC that
turns traversal caching off. That setting controls property-filter planning,
not the graph cache.

There is an existing, upstream-tested SQL cache-reset API:

```sql
SELECT ag_catalog.age_delete_global_graphs(NULL);
```

Calling it as a separate statement after rollback, or in the reader after the
other session commits, makes **both reproductions pass** on stock PostgreSQL
18. It is a useful manual recovery step and leaves caching inside the next
query intact. It is not a persistent disabled-cache mode: that query creates
another backend-local cache, which can become stale again.

Adding this call to LOAD/post-create activation does not protect subsequent
transactions. Transparent use before every query would require an execution
policy covering native, WASIX, pgwire, nested SPI and subtransaction entry
points. It would also need to preserve live traversal contexts held by active
portals/cursors instead of freeing them. The public SQL reset API alone does
not establish those guarantees, so the draft does not inject it globally or
alter the retained regression to call it.

A precise snapshot-lifetime guard remains a plausible follow-up, but merely
checking snapshot xmin/xmax is insufficient: the in-progress transaction set
can change without those bounds changing. Command/subtransaction visibility,
cache construction during concurrent commits, and REPEATABLE READ snapshots
also need tests. No partial snapshot guard is presented as a qualified fix.

## Implementation and observed checks

| Surface | Implemented | Observed locally |
| --- | --- | --- |
| Source and legal data | Exact official commit, independent Apache Git mirror, frozen Apache/PostgreSQL licenses and NOTICE | Both source hosts resolve the pin; source acquisition fault suite and metadata validation pass |
| Native Linux | Standard PGXS producer, catalog and session activation | Builds against Oliphaunt PG18.4 headers; embedded load/create/write/traversal and close/reopen pass for the original basic fixture; strengthened rollback fixture fails |
| Upstream regression | Unmodified AGE source on stock PG18 | 42/42 tests pass; separate rollback and concurrent-commit probes fail |
| Static registration | Isolated per-target generated parser/scanner/keywords/SQL; 53 source files; renamed module hooks | Host compilation of the exact static recipe passes; no overlap with 10,905 defined native core symbols |
| Windows | Generated sources, DLL init/fini exports, PostgreSQL string/getpid compatibility, handle-based CSV path containment | Clean source-generation/Meson recipe probe and SQL ABI tests pass; Windows filesystem/junction test requires Windows |
| WASIX | 32-bit graphid SQL, side module, generated export closure, Cargo feature and assets package | Source compilation, SJLJ import check, sealed core relink, canonical export generation, extension packaging and Linux x64 AOT execution pass through graph setup; materialization passes; direct lifecycle reproduces the same rollback failure |
| SDKs and release | Catalog projections, all four Cargo feature forwarding paths, independent release product and carrier metadata | Model checks, relevant contract tests, full release checks, formatting and shell syntax pass |

The actual WASIX test command (after building the runtime and AGE artifacts) was:

```sh
OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT="$PWD/target/age-extension-artifacts" \
OLIPHAUNT_WASM_AOT_VERIFY=full CARGO_BUILD_JOBS=2 \
cargo test -p oliphaunt-wasix --locked --no-default-features \
  --features extension-age --lib age_aot_ -- --nocapture --test-threads=1
```

It reports one passing materialization test and one failing direct/restart
test, with `AGE variable-length traversal failed: <NULL>` at the retained
rollback assertion. This is a real execution failure, not a missing artifact
or loader failure.

Native macOS, Windows MSVC, actual Android/iOS execution, full cross-platform
AOT lifecycle, and exact-commit CI qualification remain outstanding. Static
host compilation is not a claim of mobile runtime qualification. No observed
passing qualification is fabricated in the evidence catalog.

## Remaining work

1. Correct the upstream cache visibility defect and make the retained rollback
   regression pass on both stock and embedded PostgreSQL.
2. Add the concurrent-commit case to a maintained multi-session regression,
   including savepoints and REPEATABLE READ.
3. Complete Windows and Apple/mobile target builds and lifecycle evidence.
4. Qualify native and WASIX direct, restart, physical restore, server and
   materialization modes on the final commit before removing draft status.
