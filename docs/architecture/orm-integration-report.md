# Oliphaunt ORM integration report: native direct, broker, and WASIX/browser

Status: implemented core baseline and ORM-adapter roadmap. Last source and
asset-independent verification: 2026-08-27.

> **Decision update (2026-08-26):** The
> [stable public database API](stable-database-api.md) supersedes this report's
> proposal for a separately packaged `@oliphaunt/query` layer. The shared query,
> codec, description, multi-result, notice, lifecycle, and transaction behavior
> belongs directly in the core SDK surfaces. The ORM-specific adapters and
> qualification work described here should consume that core rather than own a
> second database-client contract.

This report defines the work required for popular JavaScript and Rust
PostgreSQL libraries to use Oliphaunt with minimal new concepts. It focuses on
native direct topology, native broker topology, WASIX direct topology through
caller-owned root or explicit Worker surfaces, and browser Worker execution.
Dedicated native and WASIX server modes, plus the concurrent WASIX postmaster,
are compatibility baselines rather than socketless adapter implementations.

## Executive decision

Oliphaunt exposes one reusable socketless JavaScript query core directly
through every JavaScript database handle, not a separate public client layer or
a different database driver for every ORM. The stable API now owns decoded and
raw rows, PostgreSQL OID codecs, JavaScript parameter serialization, object and
array row modes, multi-statement execution, descriptions, query-scoped notices,
callback transactions, and ownership-aware lifecycle.

The recommended order is:

1. Keep the direct query contract qualified across native, broker, WASIX, and
   React Native; this is implemented by the stable core API.
2. Build Kysely and Drizzle integrations together. Kysely is the smallest proof;
   Drizzle is the highest-value direct ORM surface.
3. Qualify the same adapters in real single-tab browsers.
4. Add MikroORM 7.1+ by reusing the Kysely dialect and shared query core.
5. Build multi-tab database ownership/proxying as its own product milestone; it
   must not block single-tab MikroORM.
6. Consider a deliberately single-session `pg` compatibility facade for Knex
   and TypeORM only after the first three integrations are stable.
7. Treat cursors, interactive COPY, idle `LISTEN`, and complete `pg` emulation
   as a separate protocol project. They must not block ordinary CRUD,
   relations, migrations, and transactions.

Rust has a different boundary. SQLx, Diesel, diesel-async, and SeaORM are
tightly coupled to their PostgreSQL transports and row/value types. There is no
small socketless adapter that preserves their normal APIs. Oliphaunt therefore
keeps two honest products instead of making one handle pretend to be both:

- Stock PostgreSQL Rust libraries use the dedicated `OliphauntServer` or
  `AsyncOliphauntServer`, obtain its connection string, and own all client
  connections through their ordinary APIs. Native server mode has independent
  PostgreSQL sessions; the WASIX server owns one embedded backend and therefore
  requires a pool size of one.
- Strict socketless direct and broker applications use the Oliphaunt Rust query
  API or a small SeaQuery executor. They do not claim direct SQLx, Diesel, or
  SeaORM compatibility.

A custom SQLx driver should not be built. A custom Diesel connection and a
SeaORM proxy are possible research projects, but both have material API and
correctness limitations.

### Build inventory

| Component | What it unlocks | Runtime/protocol work | Recommendation |
| --- | --- | --- | --- |
| Shared JavaScript query core | One decoded, transactional database API for native direct, native broker, both WASIX TypeScript execution surfaces, and React Native | Implemented directly in the SDKs over current complete-operation APIs; no C ABI change | Keep as the adapter foundation |
| `OliphauntDialect` | Kysely and the base of the MikroORM integration | Query-client adapter only | Build in the first integration milestone |
| `@oliphaunt/drizzle` session | Drizzle's query, relational, transaction, and migration APIs | Query-client adapter with object/array row modes and parser overrides | Build with Kysely |
| `OliphauntDriver` for MikroORM | Entity manager, unit of work, schema, and migrations | Reuse the Kysely dialect and multi-result execution | Build after the core API and Kysely are stable |
| Browser host hardening | All socketless JavaScript ORMs in real applications | Explicit Worker path, transfer policy, bundler/COOP/COEP tests, persistence failure semantics | Treat as part of first-class browser support |
| Multi-tab owner/proxy | Safe sharing of one persistent browser database identity | SharedWorker or leader election, transaction tokens, failover without write replay | Build after single-tab correctness; required before claiming multi-tab support |
| Broker generation and operation IDs | Safe cache invalidation and race-free cancellation | Extend scheduler and broker control IPC | Build before prepared caches or `AbortSignal` claims |
| Rust server qualification | Stock SQLx, Diesel, diesel-async, SeaORM, and tokio-postgres APIs | Exercise the existing dedicated native and WASIX server builders through connection strings | Add reproducible per-library suites; use pool size one on WASIX |
| `OliphauntSeaQueryExecutor` | Small, truly socketless Rust query-builder integration | Statement/value codecs over the existing direct API | Build independently of server qualification |
| Constrained `pg-compat` facade | Knex and TypeORM first; possibly Sequelize, Slonik, and Zapatos later | Single-session compatibility over the stable core, with any required lease kept adapter-private | Defer until the first three JavaScript integrations pass |
| Duplex operation ABI | Interactive COPY, pull row streams, and advanced socketless client emulation | New C/Rust/broker/TypeScript/WASIX exchange path | Start only for a proven feature requirement |

Do not build a custom SQLx database implementation or a direct Prisma adapter.
Do not put per-ORM SQL codecs, transaction schedulers, or browser ownership
logic in individual adapters; those belong in shared layers above.

## Evidence and claim boundary

The source and contract statements below are backed by this checkout. Real
runtime qualification is claimed only where a checked-in lane and its required
artifacts actually ran. ORM extension points were checked against the cited
upstream documentation and source.

No direct ORM adapter exists yet, so direct/browser ORM behavior is a design
target, not a passing compatibility claim. Every advertised integration must
pass the conformance matrix in this report.

Earlier exploratory server-mode runs for `pg`, Kysely, Drizzle, SQLx, Diesel,
and SeaORM are not durable repository evidence and are not used to support a
compatibility claim. The in-tree WASIX Rust compatibility test currently proves
only narrow tokio-postgres and SQLx paths. Until reproducible fixtures are
checked in for the other libraries, none is an advertised integration. The
existing server tests do not validate a socketless path and do not by
themselves qualify an ORM's complete public API.

### Target outcome matrix

| Consumer | Native direct | Native broker | WASIX TypeScript/browser | WASIX Rust direct | Intended work |
| --- | --- | --- | --- | --- | --- |
| Kysely | First-class | Same adapter | First-class | Not applicable | Stable query core plus `OliphauntDialect` |
| Drizzle | First-class | Same adapter | First-class | Not applicable | Dedicated Drizzle session on the stable query core |
| MikroORM 7.1+ | First-class after Kysely | Same adapter | First-class after Kysely | Not applicable | Kysely-backed Oliphaunt driver |
| Knex/TypeORM | Later | Later | Only where their bundles are viable | Not applicable | Single-session `pg-compat`, qualified per ORM |
| Sequelize | Deferred | Deferred | Deferred | Not applicable | Only after full leased-client tests |
| Prisma | No direct target | No direct target | No browser target | Not applicable | Use a standard endpoint |
| `pg` / Postgres.js | No socketless target | No socketless target | No browser target | Not applicable | Use a standard endpoint |
| SQLx | No stock direct path; use native server | No stock broker path; use native server | Not applicable | Narrow SQLx 0.8 server smoke only; full suite pending | Qualify dedicated server products |
| Diesel / diesel-async | No stock direct path; use native server | No stock broker path; use native server | Not applicable | Server path is unvalidated | Qualify dedicated server products |
| SeaORM | No stock direct path; use native server; proxy research only | No stock broker path; use native server; proxy research only | Not applicable | Server path is unvalidated; proxy research only | Server qualification plus upstream proxy-v2 proposal |
| tokio-postgres | No stock direct path; use native server; in-memory research only | No stock broker path; use native server | Not applicable | Narrow server smoke; full suite pending | Qualify server; optional `connect_raw` transport spike |
| SeaQuery | Small direct executor | Same executor | Via JS/Wasm bridge only | Small direct executor | Statement/value codec integration |

The matrix keeps its columns focused on socketless adapter work. Dedicated
server mode is not an adapter: native server exposes ordinary independent
PostgreSQL sessions, while the WASIX server exposes one connection at a time.
Both still require the per-library public-API qualification described below;
the connection string alone is not a compatibility claim.

## Runtime topology and hard boundaries

### Current topology and calling surfaces

| Surface | Execution owner | Physical sessions | Relevant behavior |
| --- | --- | ---: | --- |
| Native Rust `Oliphaunt` | Calls block the caller through an exclusive direct or broker handle; direct PostgreSQL uses liboliphaunt's backend pthread | One process-wide active direct instance and one serialized session per database handle | No SDK owner-queue hop; direct cancellation uses a separate `CancelHandle`; `Send + !Sync` |
| Native Rust `AsyncOliphaunt` | The selected direct or broker topology is retained on an SDK owner thread | One serialized session | Cloneable `Send + Sync` asynchronous handle with bounded ordered admission |
| Native TypeScript, Swift, Kotlin, and React Native | PostgreSQL runs behind each SDK/platform serial owner or async-work boundary | One process-wide active direct instance and one serialized session | No socket in direct mode; app-facing operations are async/main-safe. The lower-level C ABI remains synchronous |
| Native broker | PostgreSQL runs in one SDK-owned helper per broker handle | One serialized session per helper | Same database API; helper loss permanently fails that handle, and recovery requires an explicit close plus a new open |
| WASIX Rust `Oliphaunt` | The direct guest runs on the caller thread and is owned by an exclusive `&mut` handle | One synchronous session | No scheduling hop; `!Send + !Sync`; no public cancellation |
| WASIX Rust `AsyncOliphaunt` | PostgreSQL runs in the WASIX guest retained on an SDK owner thread | One serialized session | Cloneable `Send + Sync` async handle; bounded ordered admission; no public cancellation |
| WASIX TypeScript root | PostgreSQL guest work runs in the importing JavaScript realm | One serialized session | Promise-shaped loading/publication does not move synchronous guest CPU work off the caller realm |
| WASIX TypeScript `/worker` | PostgreSQL runs in a package-owned module Worker/worker thread | One serialized session | Main-safe entry point; query bytes cross RPC; ORM logic remains in the caller realm |
| WASIX Rust/TypeScript server | A dedicated server owner exposes one embedded backend locally | One connected client at a time | Standard clients on Rust, Node, Bun, and Deno; lifecycle/URI-only handle; no browser endpoint |
| Native Rust/TypeScript server | A dedicated packaged PostgreSQL process | Independent sessions | Standard ORM path; lifecycle/URI-only handle; not the focus here |
| WASIX postmaster | Normal postmaster product | Independent sessions | Concurrent server baseline, distinct from the embedded server facade |

An SDK handle clone is not another connection. `Promise.all` may submit several
operations, but the embedded session executes them serially. An adapter must
not report a pool size above one or imply independent concurrent transactions
for a direct, broker, or single-backend WASIX database.
Server handles are not database-handle clones: they expose only a connection
string and lifecycle, and an ordinary PostgreSQL driver owns each connection.

### Consequences for every one-session embedded adapter

| Constraint | Required behavior |
| --- | --- |
| One physical session | Queue ordinary queries and exclusively pin the session for a transaction or leased client |
| Transaction ownership | Database-level calls must not interleave with a callback transaction |
| Session state | Temporary tables, `SET` values, advisory locks, and prepared statements belong to the one session |
| ORM lifecycle | Borrowed handles are not closed by ORM shutdown; owned handles close exactly once |
| Extensions | Native/WASIX artifacts, dependencies, and preload settings are selected before open; selection never runs installation SQL, and later ORM SQL cannot materialize missing runtime code |
| Programmatic tooling | Migrations can use the adapter; an external CLI cannot attach to a live browser or socketless process |
| Persistence | WASIX publishes before resolving; a publication failure poisons the handle and is not an ordinary retryable SQL error |
| Root ownership | A persistent identity has one provider owner; simultaneous cross-mode/cross-binding mutation is unsupported |

### Exact protocol ceiling

Native buffered and callback-streamed calls stop at the first
`ReadyForQuery`. Consequently:

- `Parse + Describe + Flush` hangs because `Flush` does not produce readiness.
- One raw input must contain exactly one readiness cycle. Multiple `Sync` cycles
  or pipelining in one input are unsafe.
- `Parse + Describe + Sync` can return `ParameterDescription` and readiness.
  A later `Bind + Describe + Execute + Sync` can execute the retained named
  statement.
- One simple-query message containing several SQL statements is valid because
  it still has one final readiness boundary.

WASIX Rust and WASIX TypeScript use a different guest bridge: their engine can
already return partial/no-readiness exchanges and drive multiple cycles.
TypeScript still needs one serialization lease across those calls and must
defer persistent publication until the final idle readiness boundary.

The implemented structured query core owns complete readiness cycles, inferred
parameter description, and scheduling without exposing a session reservation
or asking adapters to encode raw protocol. Cursors, interactive COPY, pull row
streaming, complete socketless client emulation, and idle notifications still
need the bidirectional protocol project below. Server-mode clients use ordinary
PostgreSQL protocol instead.

A future socketless Rust transport based on `tokio-postgres::connect_raw` may
issue `Flush`, pipeline work, or require several frontend/backend exchanges
even for prepared queries. It must not inherit the JavaScript adapter's narrower
no-ABI conclusion; its protocol needs would be determined by its own
conformance suite. The existing server products already speak ordinary
PostgreSQL wire protocol and do not require that direct-handle experiment.

The current callback stream is output transport, not an ORM row cursor. Native
JavaScript direct callbacks execute synchronously, chunks need not align with
PostgreSQL frames, and callback errors are reported after the runtime drains
back to readiness.

## Shared JavaScript architecture

The stable SDKs own the reusable query contract directly. There is no separate
`@oliphaunt/query` facade, compatibility readiness layer, or public session
lease for an ORM to discover.

The dependency flow should be:

```text
@oliphaunt/ts direct/broker ---+
@oliphaunt/wasix-ts -----------+--> shared SDK query core --> ORM adapters
@oliphaunt/react-native -------+                |
                                                +--> optional pg-compat
```

The common implementation is ESM, DOM-safe, and free of Node, filesystem,
native, Worker, and storage dependencies. Its canonical source is mirrored
exactly into the three JavaScript SDK packages by an enforced repository
contract. `database.query()` is the decoded object/array operation;
`database.queryRaw()` preserves the prior ordered byte-row result.

### Type parsing and serialization

Adapters consume Oliphaunt's precision-preserving defaults rather than mutating
an instance-level PGlite registry:

| PostgreSQL type | Default JavaScript value |
| --- | --- |
| bool | `boolean` |
| int2, int4, OID, float4, float8 | `number` |
| int8 | Decimal string |
| numeric | Decimal string |
| JSON and JSONB | Parsed JavaScript value |
| date, time, timestamp, timestamptz, interval, UUID | String |
| bytea | `Uint8Array` |
| unknown/custom type | String |
| arrays | Recursively parsed arrays |

Immutable per-query OID decoders and encoders handle custom or extension types.
Ambiguous JavaScript parameters are described and encoded while one scheduler
operation retains the session. `undefined`, unsupported objects, incompatible
OIDs, and silent `toString()` fallback are rejected. Explicit typed null, JSON,
array, text, and binary wrappers remain the deterministic path. There is no
mutable global or instance codec registry and no `refreshArrayTypes()` core
method.

Object row mode rejects duplicate column names rather than silently discarding
an earlier value. Array and raw row modes preserve every field and are
available for ORM field mapping.

### Errors, notices, transactions, and lifecycle

Adapters preserve existing `PostgresError` properties and may project familiar
aliases at their own compatibility boundary. The core intentionally exposes
only the canonical names in the left column; it does not publish these aliases
itself:

| Oliphaunt property | Compatibility alias |
| --- | --- |
| `sqlstate` | `code` |
| `schemaName` | `schema` |
| `tableName` | `table` |
| `columnName` | `column` |
| `dataTypeName` | `dataType` |
| `constraintName` | `constraint` |

Query-scoped notices and notifications carried in a response can be dispatched
while parsing it; triggers, functions, and extensions can make self-generated
notifications useful. Continuous idle listener semantics are impossible today
because native has no backend read/poll operation when no request is active.

The core transaction already exposes closed state and explicit rollback.
Rollback marks the handle closed and suppresses outer commit; callback failure
settles rollback before preserving the callback error. Managed callbacks expose
no raw protocol. Exact backend command tags and terminal readiness enforce
ownership without lexing SQL, so adapters must use callback return/failure,
explicit rollback, and savepoints rather than manual lifecycle SQL.

### Full-fidelity parameter inference

The implemented query operation owns its Parse/Describe/Bind cycle and never
exposes an intermediate lease. It resolves parameter OIDs, applies immutable
per-query encoders, binds, executes, and recovers through readiness before the
scheduler admits another caller. An adapter passes values and codecs through
this public structured API rather than constructing raw protocol or reaching
for a private host symbol.

Do not add a statement cache initially. Schema changes, `search_path`, role
changes, custom types, and lifecycle boundaries all require invalidation rules.
Broker helper loss permanently fails the current database handle; discard every
cache with that handle and require an explicit new open. Do not silently retry
on SQLSTATE `26000` or after helper loss: a new session also loses `search_path`,
role state, temp objects, advisory locks, and transaction context, so even a
pre-execute retry can change semantics.

## JavaScript ORM integrations

### Priority and target

| Library | Direct/browser feasibility | Recommendation |
| --- | --- | --- |
| Kysely 0.29+ | Very high | First proof and first-class `OliphauntDialect` |
| Drizzle | High | First-class adapter alongside Kysely |
| MikroORM 7.1+ | High after Kysely | Reuse Kysely dialect and shared client |
| Knex | Medium | Defer to the single-session `pg` phase |
| TypeORM | Medium | Defer; community adapters prove feasibility but use brittle substitution |
| Sequelize | Medium-low | Defer until leased-client/pool emulation is proven |
| Slonik and Zapatos | Medium after `pg` facade | Later |
| Prisma | Low | Do not promise direct/browser support |
| `pg` and Postgres.js | Transport clients, not ORM extension points | Use an endpoint; do not recreate them for the first milestone |

### Kysely

Kysely has a public dialect/driver extension and a built-in PGlite driver since
0.29. Its direct contract is small:

- one logical connection;
- object rows;
- `query(sql, parameters, { rowMode: 'object' })`;
- `affectedRows` converted to bigint;
- an adapter-private connection lease held from Kysely acquisition through
  release; a Kysely transaction enters one Oliphaunt callback transaction and
  routes that transaction's queries until commit/rollback is signalled, rather
  than sending manual lifecycle SQL;
- a client/leader-scoped migration mutex because separate migrators or tabs can
  otherwise interleave a multi-query migration;
- explicit rejection of streaming.

Recommended API:

```ts
const database = await Oliphaunt.open({ topology: 'broker' });

const db = new Kysely<AppDatabase>({
  dialect: new OliphauntDialect({
    database,
    ownership: 'borrowed',
  }),
});
```

Reuse Kysely's PostgreSQL compiler, adapter, and introspector; implement only
the driver and connection. The supported API should use Oliphaunt vocabulary,
explicit ownership, and the core callback-transaction boundary instead of
claiming that the database structurally implements `PGliteInterface`.

Initial support:

- query builder and raw SQL;
- schema builder and introspection;
- programmatic migrations;
- transactions and savepoints;
- plugins and `onCreateConnection`.

`streamQuery()` must fail immediately with a specific unsupported-capability
error.

### Drizzle

Drizzle's PGlite session confirms the exact direct requirements:

- raw queries request object rows;
- mapped queries request positional array rows;
- both can override parsers by OID;
- prepared-query names are accepted but not used as server statement names;
- transactions use a client callback;
- nested transactions use `SAVEPOINT`, `RELEASE SAVEPOINT`, and
  `ROLLBACK TO SAVEPOINT`;
- isolation/access configuration is emitted as `SET TRANSACTION`.

Recommended API:

```ts
import { drizzle } from '@oliphaunt/drizzle';

const database = await Oliphaunt.open();
const db = drizzle(database, { schema });
```

The best long-term location is an upstream `drizzle-orm/oliphaunt` entrypoint.
Until then, `@oliphaunt/drizzle` should own the session implementation. Feeding
Oliphaunt into `drizzle-orm/pglite` is not a good final solution because that
entrypoint imports PGlite OID constants at runtime and would make users install
and bundle PGlite unnecessarily. An out-of-tree session necessarily follows
Drizzle session/dialect internals, so it must pin tested peer-version ranges;
an upstream entrypoint is the stable long-term support path.

Initial support:

- CRUD, joins, `RETURNING`, and upsert;
- relational queries;
- logical prepared-query objects;
- transactions, nested savepoints, and transaction configuration;
- programmatic migrations.

Drizzle Kit cannot attach to a database living inside a browser page or a
socketless native handle. `generate` remains offline, and generated migrations
can run programmatically against the adapter. `push`, `introspect`, Studio, and
CLI migration execution require Oliphaunt server mode or a future
Drizzle Kit custom driver. In browsers, bundle generated migration SQL and
apply it programmatically.

### MikroORM

MikroORM 7.1's PGlite driver reuses its PostgreSQL SQL, schema, and migration
stack through Kysely's `PGliteDialect`. Its connection wrapper:

- distinguishes borrowed from owned PGlite instances;
- applies raw-string date/time parser overrides;
- delegates queries and callback transactions;
- uses `exec()` for multi-statement schema dumps;
- documents row streaming as unsupported.

Recommended API:

```ts
const orm = await MikroORM.init({
  driver: OliphauntDriver,
  entities: [User],
  driverOptions: {
    database,
    ownership: 'borrowed',
  },
});
```

Also allow driver-owned opening:

```ts
driverOptions: {
  open: {
    topology: 'broker',
    storage,
    extensions,
  },
}
```

Implement `OliphauntConnection.createKyselyDialect()` and reuse
`OliphauntDialect`. `executeDump()` calls the shared multi-result `exec()`.

One direct handle is already attached to one PostgreSQL database. MikroORM
database-create/drop workflows that close, recreate, or switch a physical
database identity need an owned-root factory or must be unsupported. Ordinary schema
generation and migrations within the selected database are in scope.

### Later single-session pg compatibility

A later `@oliphaunt/pg-compat` can unlock more libraries, but it must be a
constrained facade, not a node-postgres compatibility claim:

- Promise and callback query forms;
- query configs with `text`, `values`, `rowMode`, and `types`;
- `Client` and `Pool`-shaped values;
- `connect`, `release`, and `end`;
- event-compatible errors and notices;
- `types.getTypeParser`, `setTypeParser`, and built-in OIDs;
- `{ rows, fields, command, rowCount }` results.

`Pool.connect()` must lease the sole session until `release()`.
`pool.query()` waits behind that lease. A configuration above one connection
must fail rather than being ignored.

Initially reject a query config with `name`. In node-postgres, it promises a
per-connection prepared statement, so accepting it as a logical label would be
misleading. Supporting it later requires name/SQL collision checks, reset
invalidation, cleanup, and conformance tests.

Target Knex and TypeORM first. Add Sequelize, Slonik, and Zapatos only after
their own public suites pass. Prisma direct remains out of scope: its
driver-adapter ABI, generated client, schema engine, migrations, and browser
story are a separate product.

TypeORM may automatically issue `CREATE EXTENSION` for UUID generation, citext,
hstore, PostGIS, cube, ltree, vector, and `btree_gist`. Users must preselect the
matching Oliphaunt carrier before open; that selection supplies runtime code but
does not run TypeORM's database-local SQL. Set `installExtensions: false` only
when application migrations own the equivalent installation. Knex and TypeORM
stream APIs depend on `pg-query-stream` and must be rejected until true row
streaming exists. If
Sequelize is added later, reject `TransactionNestMode.separate`; only reuse and
savepoint nesting can fit one physical session.

## Browser-specific product work

### Choose execution placement explicitly

The root `@oliphaunt/wasix-ts` entry point runs PostgreSQL in its importing
JavaScript realm. This is the lowest-overhead path for Node scripts, tests, and
applications that already place their ORM in an application-owned Worker. In a
browser UI realm, prefer `@oliphaunt/wasix-ts/worker`; it owns a package Worker
and keeps synchronous guest execution off the main JavaScript agent. Execution
placement is selected by the entry point rather than database configuration.

With the package Worker, ORM code and type parsing remain in the caller realm;
only requests and raw results cross RPC. Transfer owned `ArrayBuffer` values
rather than cloning large byte arrays. Keep callback-stream chunks bounded and
do not describe that callback as row streaming.

Browser applications must remain cross-origin isolated. Applications using the
explicit Worker surface must also preserve the package's module Worker edge.
Test COOP and COEP response headers through a production-style bundle, not only
a unit-test Worker.

### Storage behavior adapters must preserve

- Memory storage disappears with the owning Worker or page.
- IndexedDB publication is atomic at an operation boundary.
- OPFS follows PostgreSQL recovery ordering but may report unknown state after
  failed multi-file publication.
- Ordinary operations publish before their promises resolve.
- Callback transactions publish once after confirmed commit or rollback.
- A publication failure poisons the live handle. Preserve the typed storage
  error and never retry the SQL automatically.
- Synchronous OPFS access handles are available whenever the database-owning
  realm has no `document`, including the explicit package Worker and a root
  database imported inside an application Worker. A root database imported in
  a browser Window uses the portable journal path.
- Chromium's Window-realm synchronous side-module limit means large extension
  carriers require `/worker` or the root entrypoint inside a Dedicated Worker.

### Multi-tab support is a separate deliverable

Today, persistent browser databases use a fail-fast, origin-scoped exclusive
Web Lock. That enforces one owner but does not proxy queries from another tab.
Memory databases are independent per open. There is no multi-tab leader,
SharedWorker broker, or transaction owner.

Build `@oliphaunt/wasix-ts/multi-tab` after single-tab ORM support works. It
should expose the same query-client contract while one leader owns the actual
Worker and storage lease.

Required semantics:

- identify a database by origin, provider kind, storage name, runtime identity,
  extension set, username, database, and startup settings;
- reject clients whose configuration differs from the active leader;
- serialize every tab through the one physical session;
- make a transaction sticky to its originating tab and transaction token;
- queue other tabs until that transaction ends;
- reference-count client shutdown without closing the leader prematurely;
- reject all in-flight operations on leader loss;
- never replay a write or transaction automatically after failover;
- reopen the last published generation and elect a new leader;
- surface a leader-change event so applications can refresh reads.

A SharedWorker is simplest where available. A BroadcastChannel/Web-Lock leader
election can be the portability fallback. Both paths need real two-tab tests
for leader close, crash, transaction exclusivity, migration races, and reopen.

## Native broker work

The JavaScript adapter must run unchanged over native direct and broker.
Transport selection belongs to `Oliphaunt.open()`; the ORM should not know
whether PostgreSQL is in-process or in a helper.

Broker-specific conformance must cover:

- helper startup failure and early exit;
- failure during an ordinary query;
- helper loss before, during, and after `COMMIT`;
- no transaction replay when outcome is unknown;
- permanent handle failure after helper loss, with no transparent replacement;
- prepared/type cache disposal and documented loss of temp/session state on the
  caller's explicit reopen;
- cancellation on the separately authenticated cancel endpoint;
- close while work is queued or streaming;
- root-lock conflicts;
- the 128 MiB limit on every IPC frame, including a buffered query response or
  backup. Streamed output is limited per chunk, not in aggregate.

Native cancellation currently means `cancel whatever operation is active`. It
is not tied to the Promise that requested it. Add monotonically increasing
operation IDs and `cancelIfActive(id)` through the TypeScript/Rust scheduler and
broker IPC before mapping `AbortSignal`. Otherwise a late abort for query A can
cancel query B.

Deno broker extension assets are a current special case: automatic package
materialization is not available like Node/Bun, so extension selection may
require an explicit runtime directory. ORM docs should not hide that constraint.

## Rust libraries and ORMs

### The unavoidable transport decision

SQLx, Diesel, diesel-async, and SeaORM are not analogous to Kysely or Drizzle.
Their connection, row, value, statement, error, transaction, and pool
implementations are concrete library components.

The lowest-risk way to preserve their APIs is the already separate server
product. It must not be opened through a database handle: that would make
ownership, pooling, cancellation, and close look as though one privileged SDK
session controlled independent client sessions.

```rust,ignore
use oliphaunt::AsyncOliphauntServer;
use sqlx::postgres::PgPoolOptions;

let server = AsyncOliphauntServer::builder().start().await?;
let pool = PgPoolOptions::new()
    .connect(server.connection_string())
    .await?;
```

The server handle exposes only `connection_string`, `is_closed`, and `close`.
The pool owns SQL, transactions, cancellation, and connection lifecycle. Native
server mode runs packaged PostgreSQL with independent sessions, so its pool
size follows the application's workload. The WASIX server exposes one embedded
backend, so downstream pools must set their maximum to one and concurrent
connection rejection, disconnect reset, COPY, TLS/GSS refusal, and cancellation
limits must remain explicit in its qualification evidence.

This endpoint choice does not make direct or broker mode ORM-compatible. Those
database handles remain socketless one-session clients with their own fluent
`Sql` and callback-transaction APIs. An optional `tokio-postgres::connect_raw`
spike may prove an in-memory transport, and a SeaQuery executor remains a small
direct integration, but neither should widen the core database API or add a
dual-role endpoint method.

### Per-library decision

| Library | Normal API over Oliphaunt server | Strict socketless option | Decision |
| --- | --- | --- | --- |
| SQLx | Stock `PgConnection` or `PgPool`; max one on WASIX only | New custom database/type/macro stack | Use server; do not build custom SQLx |
| Diesel | Stock `PgConnection` and r2d2; max one on WASIX only | Custom `Connection<Backend = Pg>`, unstable | Use server; defer custom connection |
| diesel-async | Stock `AsyncPgConnection`; max one on WASIX only | Large custom connection or tokio-postgres spike | Use server |
| SeaORM | Stock PostgreSQL `ConnectOptions`; max one on WASIX only | `ProxyDatabaseTrait` proof, semantically partial | Use server; experiment only |
| tokio-postgres | Normal client connection; max one on WASIX only | `Config::connect_raw` supports arbitrary async I/O | Use server; optional in-memory spike |
| SeaQuery | Not a connection library | Direct statement/value executor | Build as small socketless integration |

### SQLx

Version policy is part of the integration contract. SQLx 0.9.0 and SeaORM
2.0.2 require Rust 1.94, while this Oliphaunt workspace declares Rust 1.93.
Either raise the workspace MSRV after qualification or keep SQLx 0.8 and
SeaORM 1.1 as the Rust-1.93 lanes; do not advertise an unbuildable combination.

Do not build an Oliphaunt SQLx driver:

- `Database` fixes the connection, row, value, statement, argument, and type
  metadata families.
- PostgreSQL connection/stream internals are not arbitrary-transport extension
  points.
- A new database type needs parallel encode/decode and prepared-query code.
- checked macros and offline metadata need that database identity.
- SeaORM's PostgreSQL connector would not automatically use it.
- `sqlx-core` is explicitly semver-exempt.

Over the server connection string, use stock `Postgres`. Set max one connection
for the single-backend WASIX server; native server mode permits independent
sessions. Online `query!` macros and `cargo sqlx prepare` still need a running endpoint or
checked-in offline metadata. Qualify `#[sqlx::test]` separately because it
expects an administrative endpoint that can create, drop, and reconnect to
per-test databases. Parallel tests require distinct roots/endpoints or forced
serialization on WASIX; native server qualification should also cover normal
parallel pools.

### Diesel and diesel-async

A socketless Diesel connection needs `Connection<Backend = Pg>`,
`ConnectionSealed`, `SimpleConnection`, `LoadConnection`, `postgres_backend`,
custom `Row` and `Field` types, PostgreSQL metadata lookup/cache, prepared
caches, transaction state, instrumentation, SQLSTATE mapping, and a sound
synchronous blocking bridge.

Diesel requires
`i-implement-a-third-party-backend-and-opt-into-breaking-changes` for this and
excludes that surface from stability guarantees. It would not make Diesel CLI
understand an already-running in-process database. This is too much maintenance
for the main path.

Stock Diesel `PgConnection` also needs system libpq or a bundled `pq-sys`
build. Oliphaunt's staged runtime libpq does not automatically satisfy that
compile/link dependency; document and test the selected linking strategy.

diesel-async exposes custom traits, but an implementation still needs
execute/load futures, streams and row GATs, transaction management, prepared
statements, types, errors, and instrumentation.

`tokio_postgres::Config::connect_raw` is worth an in-memory transport spike. It
can preserve the tokio-postgres client API and inform diesel-async, but it does
not unlock stock SQLx or synchronous Diesel, and it does not automatically
produce a complete stock diesel-async path. `AsyncPgConnection::try_from(Client)`
requires separately driving the connection and omits normal error/notification
wiring; `try_from_client_and_connection` currently fixes its base transport to
`tokio_postgres::Socket`.

### SeaORM and SeaQuery

SeaORM's `ProxyDatabaseTrait` looks small, but its current contract is not
sufficient for production:

- begin, commit, and rollback return `()`, so backend failures cannot propagate;
- isolation and access-mode configuration are not faithfully represented;
- synchronous `start_rollback` conflicts with an async backend;
- `ProxyRow` is a `BTreeMap<String, Value>`, losing duplicates and position;
- rows are materialized;
- clones share one proxy without a transaction-scoped executor token;
- arrays, ranges, numeric/time values, enums/domains, and extension types need a
  complete conversion layer.

Build only a proof and seek a proxy-v2 interface with fallible transaction
hooks, transaction configuration, and scoped connections before calling it
supported.

SeaQuery is a better small socketless target. It builds PostgreSQL SQL and typed
bind values, and `sea-query-postgres` provides useful `ToSql`/OID mappings.
Build an `OliphauntSeaQueryExecutor` that encodes `Statement` values and decodes
rows. It does not by itself provide SeaORM transactions, streaming, SQLSTATE
behavior, COPY, or notifications.

### Browser Rust

Do not promise SQLx, Diesel, diesel-async, or SeaORM inside browser WebAssembly.
Their normal drivers need runtime and transport facilities absent in browsers.
Rust/Wasm may generate SQL with SeaQuery and call the JavaScript query client,
but that is a new cross-language API, not normal ORM compatibility.

## Advanced protocol project

The first JavaScript adapters should not wait for this. It is necessary only
for advanced socketless behavior such as complete `pg` emulation, interactive
COPY, pull-based row streams, and idle notifications. Dedicated server products
already expose ordinary PostgreSQL protocol and do not depend on this project.

Add an opaque operation/exchange abstraction with:

- session reservation and an operation ID;
- incremental frontend writes with bounded input backpressure;
- backend reads before `ReadyForQuery`;
- transaction/readiness status reporting;
- cancel-and-drain recovery;
- stale-operation rejection;
- finish only after confirmed readiness.

Propagate it through:

1. native C ABI and embedded protocol buffers;
2. Rust FFI, engine session, executor, and pinned handles;
3. broker request frames and helper event loop;
4. TypeScript native binding and runtime interfaces;
5. Node and Deno direct bridges;
6. WASIX query sessions and Worker RPC, reusing the existing internal duplex
   bridge.

The broker cannot implement interactive COPY with another synchronous request
kind. Its loop is blocked while PostgreSQL waits for input. Exchange
start/write/read/end frames need operation IDs and a concurrent input channel.

WASIX Rust already has an internal duplex pump. WASIX TypeScript Worker has a
full-duplex shared-memory byte channel behind its internal `serve` path. Expose
or adapt these rather than rebuilding guest protocol machinery. The root direct
entrypoint still cannot asynchronously refill a synchronous Wasm callback, even
when imported in an application Worker, so asynchronous COPY IN should require
the explicit `/worker` contract.

WASIX cancellation needs a real guest/host interrupt path. Worker cancellation
likely needs an out-of-band shared signal because normal RPC cannot run while
synchronous Wasm is executing.

### Capability staging

| Capability | Current foundation | First socketless JS adapter | Later work |
| --- | --- | --- | --- |
| CRUD and returning | Complete extended query | Shared decode/serialize | None |
| Transactions/savepoints | Callback transaction plus response-derived ownership guard | ORM mapping over the callback | None after early rollback is correct |
| Multi-statement migrations | Structured simple-query `exec` | ORM result projection | None |
| Per-query parsers | Operation-scoped OID decoders | ORM codec mapping | Custom binary codecs |
| Inferred parameter serializers | Owned Parse/Describe/Bind cycle | ORM value mapping | Cache only after reset semantics exist |
| Named prepared statements | Expressible in raw protocol | Logical names only in Drizzle; reject `pg` query `name` | Cache and invalidation |
| Query notices | Ordered structured operation data | ORM result/error mapping | Event policy |
| Cancellation | Native global active cancel; none in WASIX | Explicitly capability-gated | Operation IDs and WASIX interrupt |
| Large result rows | Buffered typed; raw callback output | Buffered only | Pull-based row stream |
| COPY OUT | Raw callback stream | Unsupported in ORM layer | Typed reader |
| COPY IN | Native can prebuffer a complete request | Unsupported in ORM layer | Duplex writer |
| Idle `LISTEN/NOTIFY` | No native idle poll; only one backend | Unsupported | Multi-backend server or new idle pump |
| Full client facade | Dedicated native and WASIX server products | Unsupported socketlessly | Revisit only with proven demand for direct-mode emulation |

The streaming, prepared-name, and COPY restrictions in this table describe the
socketless JavaScript/SeaQuery surface. Stock SQLx, Diesel, and tokio-postgres
over a qualified Oliphaunt server should retain real backend prepared
statements and their public streaming/COPY APIs wherever that server's
conformance suite passes.

## Conformance and validation plan

### Runtime lanes

Run the same JavaScript adapter contract against:

- native TypeScript direct;
- native TypeScript broker;
- every desktop JavaScript host that is claimed;
- WASIX TypeScript root direct in Node;
- WASIX TypeScript `/worker` in Node;
- Chromium, Firefox, and WebKit with Worker plus memory storage;
- browser Worker plus IndexedDB;
- browser Worker plus OPFS where supported;
- browser root direct in both Window and application-owned Worker realms;
- two tabs sharing one persistent identity after the multi-tab proxy exists.

Run the Rust client contract through the dedicated native Rust server and the
single-backend WASIX Rust server. Also prove the WASIX TypeScript server with a
stock client in every claimed non-browser host. Direct and broker remain
separate socketless Oliphaunt APIs and are not server qualification lanes.

### JavaScript SQL and type cases

Every JavaScript adapter must cover:

- create/drop schema objects and migration apply/rollback;
- CRUD, upsert, joins, relations, and `RETURNING`;
- null input and deterministic `undefined` rejection;
- bool, int2, int4, precision-preserving int8, float4/8, numeric, text, and UUID;
- JSON/JSONB including nested data and explicit bigint policy;
- bytea including zero bytes;
- date, time, timestamp, timestamptz, and interval;
- one- and multi-dimensional arrays, null elements, and empty arrays;
- enums, domains, enum arrays, and operation-scoped extension OID codecs;
- per-query decoder and encoder overrides;
- duplicate output names in object and array modes;
- command tags, row counts, SQLSTATE, and every structured error field.

The Rust endpoint suites use each library's native Rust values and row APIs.
They must cover the same PostgreSQL families, nulls, arrays, enums/domains,
precision, binary/text formats, SQLSTATE fields, and custom types, but they do
not use JavaScript-only concepts such as `undefined`, safe versus unsafe JS
integers, bigint JSON policy, or object/array row mode.

### Transaction and concurrency cases

- commit, callback rollback, and explicit rollback;
- nested savepoints;
- direct callback rejection of manual lifecycle and `AND CHAIN`, plus
  response-derived close-only behavior after ownership escape;
- isolation/access configuration;
- a caught statement error followed by `ROLLBACK TO SAVEPOINT` and successful
  continuation;
- concurrent ordinary JavaScript calls proving deterministic serialization;
- a call submitted during a transaction proving no interleaving;
- two attempted transactions proving the second waits or fails clearly;
- close during queued work;
- borrowed versus owned ORM shutdown;
- cancellation before start, during execution, and a late-cancel race;
- no automatic transaction replay after broker or Worker failure.

### Browser and persistence cases

- reopen after each successful mutation;
- one publication after a transaction, including rollback;
- injected IndexedDB and OPFS publication failures;
- poisoned-handle behavior and recovery of the last complete generation;
- page reload and Worker termination;
- second-tab lock failure;
- leader close/crash after the multi-tab proxy exists;
- mismatched runtime/extension/storage configuration in another tab;
- selected-but-not-installed extensions, migration-owned `CREATE EXTENSION`,
  and persistent reopen with the runtime artifact selected again;
- production bundle loading with COOP/COEP and Worker assets;
- large bytea/results with measured main-thread responsiveness.

### ORM-specific suites

| ORM/library | Required public-API proof |
| --- | --- |
| Kysely | Compiler, introspector, schema builder, migrations, plugins, transactions/savepoints, streaming rejection |
| Drizzle | Relational and SQL-like APIs, prepared objects, transactions/savepoints/config, migrations |
| MikroORM | Unit of work, entity manager CRUD, relations, cascades, schema generator, migrations, custom types, reopen |
| Knex/TypeORM later | Their migration, transaction, schema, pool, callback/Promise, and lifecycle APIs over `pg-compat` |
| SQLx server | Prepared binary binds, streaming, offline/online macros, cancel, COPY; ordinary native pool and max-one WASIX pool |
| Diesel server | Typed DSL, `sql_query`, migrations, transaction builder, COPY; ordinary native r2d2 pool and max-one WASIX pool |
| diesel-async server | Typed DSL, async transactions, cancel/error forwarding; ordinary native pool and max-one WASIX pool |
| SeaORM server | Entity/ActiveModel CRUD, relations, transactions, migrations; ordinary native pool and max-one WASIX pool |
| SeaQuery executor | Typed values, PostgreSQL SQL, row decoding, errors, explicit callback transactions |

Passing raw SQL through the shared client is insufficient. Each lane must use
the ORM's public API because relations, transaction nesting, migrations,
prepared queries, and result mapping add behavior above the transport.

## Consolidated gotchas

| Gotcha | Product rule |
| --- | --- |
| Pooling | Direct, broker, and lightweight WASIX are max one; reject higher sizes |
| Parallel promises | They serialize; never market them as concurrent sessions |
| Transactions | Pin one session; reject database-level calls inside the callback |
| ORM ownership | Borrowed by default; close only explicitly owned handles |
| External CLI | Cannot attach to a live socketless/browser database; use a stopped-root runner or programmatic migrations |
| Extensions | Select artifacts/dependencies/preload at open; selection runs no SQL, while ORM-owned `CREATE EXTENSION` cannot materialize missing code |
| int8/numeric | Preserve precision and make adapter mappings explicit |
| Dates | Drizzle needs raw strings for its own decoders |
| Duplicate columns | Object rows overwrite; array rows preserve position |
| Prepared names | Logical only for the first JS adapters; endpoint clients use real backend statements |
| Streaming | Reject in socketless JS/SeaQuery; endpoint clients retain it only after conformance passes |
| COPY | Outside the first socketless JS/SeaQuery surface; endpoint clients require COPY conformance |
| `LISTEN` | Query-scoped self-notifies may appear; useful idle delivery is unsupported |
| Cancellation | Native only and operation-global; add IDs before `AbortSignal` |
| Storage failure | Preserve typed WASIX error and poison state; never auto-retry |
| Broker/Worker crash | Reject in-flight work; never replay unknown transactions |
| Broker loss | Fail the handle permanently; discard caches and require explicit close/open without replay |
| Multi-tab | One fail-fast Web Lock owner today; build a leader proxy first |
| Direct browser | The root blocks its realm and has side-module limits; import `/worker` when the UI realm must stay responsive |
| Cross-binding roots | Do not open one root simultaneously across providers |

## Implementation status and next steps

### Completed: stable direct query contract and shared core

The core prerequisite is implemented directly in native TypeScript, WASIX
TypeScript, and React Native rather than as the superseded
`OliphauntQueryClient` wrapper. It includes decoded object/array rows,
byte-preserving `queryRaw`, explicit and inferred OID serialization,
operation-scoped codecs, `describe`, ordered multi-statement `exec`, notices,
callback transactions, and ownership-aware lifecycle. One canonical
browser-safe query core is mirrored byte-for-byte into all three packages, and
shared fixtures cover multi-results, arrays, notices, malformed frames, COPY
preflight, and readiness recovery. Checked-in native and WASIX smoke programs
exercise the same public structured surface, including both WASIX TypeScript
execution surfaces. In this checkout the asset-independent suites and packed
package checks passed, but the runtime smokes could not execute because usable
native and staged WASIX runtime assets were absent; this report therefore makes
no fresh real-runtime claim for those lanes.

Raw protocol remains a database/root-only escape hatch. Managed transaction
handles expose structured operations and explicit rollback only; their guard
rejects `ROLLBACK`/`ABORT ... AND CHAIN` before dispatch and classifies every
exact backend command tag plus the one terminal readiness status before parsing
results. Other manual transaction lifecycle SQL is unsupported, savepoints
remain valid, and an ownership escape retires the database without speculative
follow-up control.

This completion makes the SDKs adapter-ready; it does not itself make a Kysely,
Drizzle, or PGlite-typed application source-compatible.

### 1. Add Kysely and Drizzle

- Implement `OliphauntDialect` through Kysely's public driver extension.
- Implement `@oliphaunt/drizzle` and propose the stable session upstream.
- Add programmatic migration fixtures.
- Reject streaming and multi-session behavior clearly.

Acceptance: both ORMs pass their public suites in native direct, broker, WASIX
root-direct and explicit-Worker, IndexedDB, and OPFS browser lanes.

### 2. Qualify the single-tab browser host

- Test production bundlers, COOP/COEP, transfer behavior, responsiveness,
  Worker failure, and persistence poisoning.

Acceptance: Kysely and Drizzle pass in real single-tab browser builds with
memory, IndexedDB, and OPFS where supported. The `/worker` entrypoint and a root
import inside an application-owned Worker keep the main realm responsive; a
root import in `Window` is explicitly allowed to monopolize that realm.

### 3. Add MikroORM

- Implement `OliphauntConnection` and `OliphauntDriver` on the Kysely dialect.
- Support borrowed and owned handles.
- Wire multi-statement dump/schema execution.
- Define the database create/drop limitation.

Acceptance: entity lifecycle, relations, cascades, schema generation,
migrations, custom types, and persistent reopen pass in native and browser
lanes.

### 4. Build multi-tab ownership

- Build the SharedWorker or leader/proxy path with transaction tokens and no
  write replay.
- Add configuration matching, reference counting, leader-loss rejection, and
  migration serialization.

Acceptance: two tabs serialize work, keep a transaction exclusive, recover
from the last published generation, and reject mismatched configuration.

### 5. Qualify the Rust server integrations

- Start the existing dedicated native and WASIX sync/async server builders and
  connect through their returned connection strings.
- Prove SQLx, Diesel, diesel-async, SeaORM, and tokio-postgres through their
  public APIs. Exercise ordinary pools on native server and enforce max one on
  the single-backend WASIX server.
- Include prepared binary binds, migrations, COPY, cancellation capability,
  failed-transaction disconnect, WASIX second-client rejection, close with an
  active client, and lifecycle-error replay.
- Prove that server facades expose no SQL, transaction, raw, backup, or cancel
  methods and never imply ownership of an external client's work.
- In parallel, build a SeaQuery executor; keep any
  `tokio-postgres::connect_raw` experiment explicitly non-product until it has
  demand and full transport evidence.

Acceptance: the server path is reproducibly qualified per library and runtime;
direct and broker docs make no stock-ORM claim.

### 6. Decide on broader JavaScript compatibility

- Prototype `pg-compat` with a real leased session, callback/Promise forms,
  type registry, and lifecycle.
- Run Knex and TypeORM suites before expanding the surface.

Acceptance: `pool.query()` cannot interleave with a leased transaction, pool
sizes above one fail, and unsupported `pg` APIs fail deterministically.

### 7. Start duplex protocol work only for proven demand

- Add operation IDs and race-free cancellation first.
- Add pull-based backend reads and incremental writes.
- Propagate through C, Rust, broker IPC, TypeScript bindings, and WASIX Worker.
- Use it for socketless row streams, interactive COPY, notifications, and only
  such direct-mode client emulation as proven demand justifies.

Acceptance: bounded backpressure, cancel recovery, no unread frames across
readiness, and broker/Worker crash cleanup are proven before enabling an ORM
feature.

## Recommended end-state experience

Drizzle:

```ts
const database = await Oliphaunt.open({
  storage: indexedDB('app'),
});

const db = drizzle(database, { schema });
await db.select().from(users);
```

Kysely:

```ts
const database = await Oliphaunt.open({ topology: 'broker' });

const db = new Kysely<AppDatabase>({
  dialect: new OliphauntDialect({ database }),
});
```

MikroORM:

```ts
const orm = await MikroORM.init({
  driver: OliphauntDriver,
  entities,
  driverOptions: { database },
});
```

Rust mainstream ORM:

```rust,ignore
let server = AsyncOliphauntServer::builder().start().await?;
let mut options = ConnectOptions::new(server.connection_string());
// Required for the single-backend WASIX server; native server can use a pool.
options.max_connections(1);
let orm = Database::connect(options).await?;
```

Users should need to learn only three Oliphaunt-specific facts:

1. choose the native direct/broker/server or WASIX product; WASIX TypeScript's
   root runs in the caller realm, with package-owned isolation available from
   its explicit `/worker` import;
2. select storage and extension artifacts before open, then let migrations run
   database-local extension SQL;
3. direct and broker topology provide one physical session, so their
   transactions are exclusive; WASIX server pools are max one, while native
   server mode provides ordinary independent PostgreSQL sessions.

## Repository evidence

- [Native TypeScript database state machine](../../src/sdks/js/src/client.ts)
- [Native TypeScript query codec](../../src/sdks/js/src/query.ts)
- [Native broker runtime](../../src/sdks/js/src/runtime/broker.ts)
- [Native Rust executor](../../src/sdks/rust/src/executor.rs)
- [Native Rust database API](../../src/sdks/rust/src/database.rs)
- [Native C protocol ABI](../../src/runtimes/liboliphaunt/native/include/oliphaunt.h)
- [WASIX TypeScript database](../../src/bindings/wasix-ts/src/database.ts)
- [WASIX TypeScript query codec](../../src/bindings/wasix-ts/src/query.ts)
- [WASIX TypeScript architecture](../../src/bindings/wasix-ts/ARCHITECTURE.md)
- [WASIX Rust one-client proxy](../../src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/proxy.rs)
- [WASIX Rust wire framing](../../src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/wire.rs)
- [Public capability matrix](../../src/docs/content/reference/capabilities.mdx)

## Primary upstream sources

### PGlite and JavaScript

- [PGlite ORM support](https://pglite.dev/docs/orm-support)
- [PGlite API](https://pglite.dev/docs/api)
- [PGlite multi-tab Worker](https://pglite.dev/docs/multi-tab-worker)
- [PGlite public interface](https://github.com/electric-sql/pglite/blob/main/packages/pglite/src/interface.ts)
- [PGlite query and result types](https://github.com/electric-sql/pglite/blob/main/packages/pglite/src/types.ts)
- [Drizzle PGlite integration](https://orm.drizzle.team/docs/connect-pglite)
- [Drizzle PGlite session source](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pglite/session.ts)
- [Kysely PGlite driver source](https://github.com/kysely-org/kysely/blob/master/src/dialect/pglite/pglite-driver.ts)
- [Kysely PGlite dialect config](https://github.com/kysely-org/kysely/blob/master/src/dialect/pglite/pglite-dialect-config.ts)
- [Kysely dialect API](https://kysely-org.github.io/kysely-apidoc/interfaces/Dialect.html)
- [MikroORM PGlite integration](https://mikro-orm.io/docs/usage-with-pglite)
- [MikroORM PGlite connection](https://github.com/mikro-orm/mikro-orm/blob/master/packages/pglite/src/PgliteConnection.ts)
- [Knex PGlite adapter](https://github.com/czeidler/knex-pglite)
- [TypeORM PGlite adapter](https://github.com/muraliprajapati/typeorm-pglite)

### Rust

- [SQLx 0.9.0 documentation](https://docs.rs/sqlx/0.9.0/sqlx/)
- [SQLx 0.9.0 Database trait](https://docs.rs/sqlx/0.9.0/sqlx/database/trait.Database.html)
- [SQLx 0.9.0 checked-query macros](https://docs.rs/sqlx/0.9.0/sqlx/macro.query.html)
- [Diesel 2.3.12 custom connection guidance](https://docs.rs/diesel/2.3.12/diesel/connection/trait.Connection.html)
- [diesel-async 0.9.2 AsyncConnection](https://docs.rs/diesel-async/0.9.2/diesel_async/trait.AsyncConnection.html)
- [SeaORM connection configuration](https://www.sea-ql.org/SeaORM/docs/install-and-config/connection/)
- [SeaORM ProxyDatabaseTrait](https://docs.rs/sea-orm/2.0.2/sea_orm/trait.ProxyDatabaseTrait.html)
- [SeaQuery PostgreSQL values 0.6.1](https://docs.rs/sea-query-postgres/0.6.1/sea_query_postgres/)
- [tokio-postgres 0.7.18 Config](https://docs.rs/tokio-postgres/0.7.18/tokio_postgres/config/struct.Config.html)
