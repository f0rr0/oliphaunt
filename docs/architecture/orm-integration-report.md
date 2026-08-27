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
the default owner-backed or explicit blocking surfaces, and browser Worker
execution. Native server mode and the concurrent WASIX
postmaster are only compatibility baselines.

## Executive decision

Oliphaunt should expose one reusable socketless JavaScript query core directly
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
small socketless adapter that preserves their normal APIs.

For Rust, Oliphaunt must make an explicit product choice:

- If a local Unix socket or authenticated loopback socket is acceptable, expose
  a one-session embedded PostgreSQL endpoint backed by direct, broker, or WASIX.
  Stock SQLx, Diesel, diesel-async, and SeaORM can use it with pool size one
  once endpoint conformance passes.
- If `direct` strictly means no socket and no compatibility endpoint, advertise
  the Oliphaunt Rust query API and a SeaQuery executor. Do not claim direct
  SQLx, Diesel, or SeaORM compatibility.

A custom SQLx driver should not be built. A custom Diesel connection and a
SeaORM proxy are possible research projects, but both have material API and
correctness limitations.

### Build inventory

| Component | What it unlocks | Runtime/protocol work | Recommendation |
| --- | --- | --- | --- |
| Shared JavaScript query core | One decoded, transactional database API for native direct, native broker, both WASIX TypeScript calling contracts, and React Native | Implemented directly in the SDKs over current complete-operation APIs; no C ABI change | Keep as the adapter foundation |
| `OliphauntDialect` | Kysely and the base of the MikroORM integration | Query-client adapter only | Build in the first integration milestone |
| `@oliphaunt/drizzle` session | Drizzle's query, relational, transaction, and migration APIs | Query-client adapter with object/array row modes and parser overrides | Build with Kysely |
| `OliphauntDriver` for MikroORM | Entity manager, unit of work, schema, and migrations | Reuse the Kysely dialect and multi-result execution | Build after the core API and Kysely are stable |
| Browser host hardening | All socketless JavaScript ORMs in real applications | Package-Worker default, transfer policy, bundler/COOP/COEP tests, persistence failure semantics | Treat as part of first-class browser support |
| Multi-tab owner/proxy | Safe sharing of one persistent browser database identity | SharedWorker or leader election, transaction tokens, failover without write replay | Build after single-tab correctness; required before claiming multi-tab support |
| Broker generation and operation IDs | Safe cache invalidation and race-free cancellation | Extend scheduler and broker control IPC | Build before prepared caches or `AbortSignal` claims |
| One-session embedded PostgreSQL endpoint | Stock SQLx, Diesel, diesel-async, SeaORM, and tokio-postgres APIs | Extract the WASIX proxy state machine and add native direct/broker backends | Run a bounded spike, then make an explicit product decision |
| `OliphauntSeaQueryExecutor` | Small, truly socketless Rust query-builder integration | Statement/value codecs over the existing direct API | Build independently of the endpoint decision |
| Constrained `pg-compat` facade | Knex and TypeORM first; possibly Sequelize, Slonik, and Zapatos later | Single-session compatibility over the stable core, with any required lease kept adapter-private | Defer until the first three JavaScript integrations pass |
| Duplex operation ABI | Interactive COPY, pull row streams, complete local endpoint behavior, and advanced client emulation | New C/Rust/broker/TypeScript/WASIX exchange path | Start only for a proven feature requirement |

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
existing endpoint tests do not validate a socketless path or the proposed
cross-runtime one-session endpoint.

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
| SQLx | Endpoint only | Endpoint only | Not applicable | Narrow SQLx 0.8 smoke only; full endpoint suite pending | Shared one-client endpoint |
| Diesel / diesel-async | Endpoint only | Endpoint only | Not applicable | Endpoint path is unvalidated | Shared one-client endpoint |
| SeaORM | Endpoint; proxy research | Endpoint; proxy research | Not applicable | Endpoint path is unvalidated; proxy research only | Endpoint plus upstream proxy-v2 proposal |
| tokio-postgres | Endpoint; in-memory research | Endpoint | Not applicable | Narrow endpoint smoke; full suite pending | `connect_raw` transport spike |
| SeaQuery | Small direct executor | Same executor | Via JS/Wasm bridge only | Small direct executor | Statement/value codec integration |

## Runtime topology and hard boundaries

### Current topology and calling surfaces

| Surface | Execution owner | Physical sessions | Relevant behavior |
| --- | --- | ---: | --- |
| Native direct SDKs | PostgreSQL runs in the application process behind each SDK's serial owner/async-work boundary | One process-wide active direct instance and one serialized session | No socket; native cancellation is out of band; app-facing operations are async/main-safe. The lower-level C ABI remains synchronous |
| Native broker | PostgreSQL runs in one SDK-owned helper per broker handle | One serialized session per helper | Same database API; a dead helper may be relaunched, losing all session state without a generation event today |
| WASIX Rust root | PostgreSQL runs in the WASIX guest retained on an SDK owner thread | One serialized session | Async, cloneable handle; bounded ordered admission; no public cancellation |
| WASIX Rust `blocking` | The direct guest runs on the caller thread and is owned by an exclusive `&mut` handle | One synchronous session | Explicit no-hop option; never selected by a topology flag |
| WASIX TypeScript root | PostgreSQL runs in a package-owned module Worker/worker thread | One serialized session | Default, main-safe entry point; query bytes cross RPC; ORM logic remains in the caller realm |
| WASIX TypeScript `/blocking` | PostgreSQL guest work runs in the importing JavaScript realm | One serialized session | Promise-shaped loading/publication does not make synchronous guest CPU work non-blocking |
| WASIX lightweight endpoint | One embedded backend is exposed locally | One connected client at a time | Standard clients on Rust, Node, Bun, and Deno; no browser endpoint |
| Native server / WASIX postmaster | Normal server/postmaster | Independent sessions | Standard ORM path; not the focus here |

An SDK handle clone is not another connection. `Promise.all` may submit several
operations, but the embedded session executes them serially. An adapter must
not report a pool size above one or imply independent concurrent transactions.

### Consequences for every one-session embedded adapter

| Constraint | Required behavior |
| --- | --- |
| One physical session | Queue ordinary queries and exclusively pin the session for a transaction or leased client |
| Transaction ownership | Database-level calls must not interleave with a callback transaction |
| Session state | Temporary tables, `SET` values, advisory locks, and prepared statements belong to the one session |
| ORM lifecycle | Borrowed handles are not closed by ORM shutdown; owned handles close exactly once |
| Extensions | Native/WASIX artifacts are selected before open; later ORM SQL cannot install missing runtime code |
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

This gives a clean staging decision:

- Initial JavaScript query adapters whose exchanges finish at
  `ReadyForQuery` need no PostgreSQL engine or C ABI work. They do need a
  scheduler-level session reservation and a new raw-protocol encoder.
- Native server-inferred parameter OIDs need a session reservation across two
  complete readiness cycles, but not a partial-response ABI.
- Native cursors, interactive COPY, a complete socket bridge, and idle
  notifications need a bidirectional protocol pump.

A stock Rust PostgreSQL client may issue `Flush`, pipeline work, or require
several frontend/backend exchanges even for prepared queries. Therefore the
embedded Rust endpoint must not inherit the JavaScript adapter's narrower
no-ABI conclusion; its protocol needs are determined by the endpoint
conformance suite.

The current callback stream is output transport, not an ORM row cursor. Native
JavaScript direct callbacks execute synchronously, chunks need not align with
PostgreSQL frames, and callback errors are reported after the runtime drains
back to readiness.

## Shared JavaScript architecture

> **Historical design evidence:** This section records the pressures that led
> to the stable core API, but its proposed `@oliphaunt/query` package, additive
> byte-oriented `query`, and public/session-host lease are superseded. The
> implemented contract puts decoded `query`, byte-preserving `queryRaw`, and
> callback ownership directly on each SDK; adapters may coordinate their own
> private lease without adding one to the stable database surface.

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

### Historical proposed query-client surface (superseded)

```ts
type PostgresNotice = {
  message: string;
  severity?: string;
  code?: string;
  detail?: string;
  hint?: string;
};

interface OliphauntProtocolHandle {
  execProtocolRaw(input: Uint8Array): Promise<Uint8Array>;
}

interface OliphauntDatabaseLike extends OliphauntProtocolHandle {
  transaction<T>(
    callback: (tx: OliphauntProtocolHandle) => Promise<T> | T,
  ): Promise<T>;
  close(): Promise<void>;
}

type OliphauntQueryOptions = {
  rowMode?: 'object' | 'array';
  parsers?: Readonly<Record<number, (value: string) => unknown>>;
  serializers?: Readonly<Record<number, (value: unknown) => string>>;
  paramTypes?: readonly number[];
  onNotice?: (notice: PostgresNotice) => void;
};

type OliphauntQueryResult<T> = {
  rows: T[];
  fields: Array<{ name: string; dataTypeID: number }>;
  affectedRows?: number;
  command?: string;
  rowCount?: number;
};

interface OliphauntQueryable {
  query<T>(
    sql: string,
    params?: readonly unknown[],
    options?: OliphauntQueryOptions,
  ): Promise<OliphauntQueryResult<T>>;

  exec(
    sql: string,
    options?: OliphauntQueryOptions,
  ): Promise<Array<OliphauntQueryResult<unknown>>>;
}

interface OliphauntQueryTransaction extends OliphauntQueryable {
  rollback(): Promise<void>;
  readonly closed: boolean;
}

interface OliphauntQueryClient extends OliphauntQueryable {

  transaction<T>(
    callback: (tx: OliphauntQueryTransaction) => Promise<T>,
  ): Promise<T>;

  refreshArrayTypes(): Promise<void>;
  readonly ready: boolean;
  readonly closed: boolean;
  readonly waitReady: Promise<void>;
  close(): Promise<void>;
}

function createQueryClient(
  database: OliphauntDatabaseLike,
  options?: {
    ownership?: 'borrowed' | 'owned';
    parsers?: Readonly<Record<number, (value: string) => unknown>>;
    serializers?: Readonly<Record<number, (value: unknown) => string>>;
    onNotice?: (notice: PostgresNotice) => void;
  },
): OliphauntQueryClient;
```

`borrowed` must be the default. A factory that opens Oliphaunt for the ORM can
select `owned`. Construction is synchronous for compatibility with Drizzle,
but bootstrap is not: `waitReady` owns catalog discovery, `ready` remains false
until it finishes, and every query, execution, and transaction must await the
same promise before touching the session.

The structural host also needs a symbol-keyed, no-`BEGIN` session lease. Raw
SDK operations queue behind that lease. The Kysely driver holds it from
`acquireConnection()` through `releaseConnection()`, while the query client's
callback transaction holds it across `BEGIN`, the callback, and the final
`COMMIT` or `ROLLBACK`. The existing database callback transaction cannot
serve as this primitive because it owns its own transaction boundaries.

### Historical first query-client analysis: no PostgreSQL engine or C ABI work

The first useful implementation can use complete raw protocol exchanges over a
new scheduler/session lease:

1. Convert ordinary JavaScript parameters into text, binary, or null values.
2. Add a pure protocol encoder that can declare caller-supplied parameter OIDs
   and select result formats. The existing `extendedQuery()` hard-codes zero
   parameter OIDs and text results and cannot be reused unchanged.
3. Use one unnamed `Parse + Bind + Describe + Execute + Sync` cycle when
   generic preparation or explicit `paramTypes` is sufficient.
4. When an OID-keyed serializer needs server inference, reserve the session and
   use the two complete readiness cycles described below before binding.
5. Decode each returned field using its `typeOid`, then produce object or array
   rows and familiar result metadata.
6. Implement callback transactions on the no-`BEGIN` lease, and use one
   simple-query raw exchange for `exec()` while parsing every result set.

This preserves the Kysely, Drizzle, and MikroORM contracts without changing the
native C ABI. The complete adapter qualification still determines which custom
and extension types are supported; generic preparation alone is only a
built-in-type fallback, not a substitute for OID-aware serialization.

Generic preparation should cover:

- `null` and `undefined` as SQL null;
- strings, finite numbers, booleans, and bigint;
- `Date` as an ISO value;
- `Uint8Array` and accepted byte views;
- arrays as correctly escaped PostgreSQL array text;
- acyclic plain records as JSON with a defined bigint policy.

Never interpolate values into SQL. Unsupported class instances, cyclic
structures, and unknown objects should fail before entering PostgreSQL rather
than silently producing `[object Object]`. A `toPostgres(prepareValue)` hook is
a node-postgres compatibility feature and belongs in the later `pg-compat`
facade, not the base PGlite-shaped client.

### Type parsing and serialization

Use a PGlite-compatible default profile because the target upstream adapters
already account for it:

| PostgreSQL type | Default JavaScript value |
| --- | --- |
| bool | `boolean` |
| int2, int4, OID, float4, float8 | `number` |
| int8 | `number` inside the safe range, otherwise `bigint` |
| JSON and JSONB | Parsed JavaScript value |
| date, timestamp, timestamptz | `Date` |
| bytea | `Uint8Array` |
| unknown/custom type | String |
| arrays | Recursively parsed arrays |

Per-query parsers override instance defaults. Drizzle depends on this to keep
date, timestamp, timestamptz, interval, their arrays, and numeric-array OID
`1231` as raw strings so its own column codecs remain authoritative.

At initialization, query `pg_catalog.pg_type` to map array OIDs to element OIDs.
`refreshArrayTypes()` repeats that query after applications create enums or
domains. Registries belong to a client instance, not mutable module-global
state.

Object row mode should document that later duplicate column names overwrite
earlier names, as in common PostgreSQL JavaScript clients. Array row mode
preserves every field and is required for Drizzle field mapping.

### Errors, notices, transactions, and lifecycle

Preserve existing `PostgresError` properties and add familiar aliases:

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

The transaction wrapper should expose `closed` and explicit rollback.
`tx.rollback()` should resolve, mark the transaction closed, and suppress the
outer `COMMIT`. Kysely normally requests rollback by rejecting its deferred
callback instead. The shared state machine must support both paths without a
double rollback or trailing `COMMIT`.

### Full-fidelity parameter inference

Build the complete-cycle session reservation before the first adapters. It is
both the Kysely connection primitive and the basis of parameter inference:

```ts
const QUERY_HOST = Symbol.for('@oliphaunt/query-host/v1');

interface QueryHost {
  acquire(): Promise<ExclusiveWire>;
}

interface ExclusiveWire {
  exchange(
    request: Uint8Array,
    boundary: 'intermediate' | 'operation',
  ): Promise<Uint8Array>;
  release(): Promise<void>;
}
```

Within one native reservation:

1. Send named `Parse + Describe(statement) + Sync`.
2. Read inferred parameter OIDs.
3. Serialize values using per-query or registered OID serializers.
4. Send `Bind + Describe(portal) + Execute + Sync`.
5. Best-effort close the statement at a known boundary.

Use collision-free transient names. If extended-protocol execution fails,
recover with `Sync`, drain through `ReadyForQuery`, then attempt cleanup. If
recovery cannot be proven, poison the handle rather than leaking an ambiguous
statement/session state.

Native direct and broker need scheduler/session work only; each exchange still
finishes at readiness. WASIX can use its partial exchange support, but the
TypeScript binding must hold one serialization slot and publish persistence
at the final idle `ReadyForQuery`. After an error before `Sync`, it must send
`Sync` and drain to readiness or poison the handle. Reservation release must
publish committed autocommit work even when the exclusive callback later
throws.

If an adapter owns and hides the database handle, its own mutex can provide the
reservation. A host reservation is still preferable for borrowed handles
because a raw SDK call or another adapter must not replace a statement between
exchanges.

Do not add a statement cache initially. Schema changes, `search_path`, role
changes, custom types, and broker replacement create invalidation rules. Broker
must expose a generation/reset event before caching is safe; until then, a
restart can silently destroy prepared statements, temp state, and settings.
After a broker generation change, invalidate caches and surface the reset until
the client has an explicit, proven session-reinitialization contract. Do not
silently retry on SQLSTATE `26000`: replacement also loses `search_path`, role
state, temp objects, advisory locks, and transaction context, so even a
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
- an acquired session held from Kysely connection acquisition through release,
  with transaction boundaries controlled by the Kysely driver;
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
the driver and connection. A proof may pass the shared client to Kysely's
structural `PGliteDialect`. The supported API should use Oliphaunt vocabulary
and explicit ownership.

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
CLI migration execution require a temporary PostgreSQL endpoint or a future
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
database-create/drop workflows that close, recreate, or switch a PGlite data
directory need an owned-root factory or must be unsupported. Ordinary schema
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
matching Oliphaunt carrier before open or set `installExtensions: false` where
the TypeORM API allows it. Knex and TypeORM stream APIs depend on
`pg-query-stream` and must be rejected until true row streaming exists. If
Sequelize is added later, reject `TransactionNestMode.separate`; only reuse and
savepoint nesting can fit one physical session.

## Browser-specific product work

### The root Worker entry point is the default ORM host

Use the root `@oliphaunt/wasix-ts` entry point; it owns a package Worker and
keeps PostgreSQL off the browser's main JavaScript agent. The explicit
`@oliphaunt/wasix-ts/blocking` entry point runs synchronous guest work in its
importing agent. It is appropriate only when the application already runs all
database and ORM work in its own Worker, or when blocking is explicitly
acceptable. Do not reintroduce a configuration option that makes this
calling-contract distinction look like ordinary database configuration.

The package Worker already keeps PostgreSQL off the main thread. ORM code and
type parsing may remain in the caller realm; only requests and raw results
cross RPC. Transfer owned `ArrayBuffer` values rather than cloning large byte
arrays. Keep callback-stream chunks bounded and do not describe that callback
as row streaming.

Browser applications must remain cross-origin isolated and preserve the
package's module Worker edge. Test COOP and COEP response headers through a
production-style bundle, not only a unit-test Worker.

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
  realm has no `document`, including the package Worker and an explicitly
  imported `/blocking` database inside an application Worker. A `/blocking`
  database imported in a browser Window uses the portable journal path.
- Chromium's Window-realm synchronous side-module limit means large extension
  carriers require the root entrypoint or `/blocking` inside a Dedicated Worker.

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
- a generation/reset signal after transparent helper replacement;
- prepared/type cache invalidation and loss of temp/session state;
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

The lowest-risk way to preserve their APIs is a single-session embedded wire
endpoint. It is not a concurrent postmaster and need not launch a `postgres`
server process. It lends the embedded backend to one ordinary PostgreSQL client.

Suggested API:

```rust
let database = Oliphaunt::builder()
    .directory(path)
    .direct()
    .open()
    .await?;

let endpoint = database.open_pgwire_endpoint().await?;
assert_eq!(endpoint.max_connections(), 1);

let pool = PgPoolOptions::new()
    .max_connections(1)
    .connect(endpoint.connection_string())
    .await?;
```

While the endpoint owns the session, direct SDK queries return a pinned/busy
error. Prefer a mode-0700 Unix socket on Unix and authenticated IPv4 loopback
on Windows/WASIX. The completed endpoint should reject a second ordinary
connection immediately with SQLSTATE `53300`; the current WASIX sequential
listener instead leaves additional clients waiting.

On disconnect, first cancel and drain through `ReadyForQuery`, then run
`ROLLBACK` and `DISCARD ALL` before admitting another client. If recovery fails
or the client disconnected during COPY, discard and reopen the backend session.
Endpoint close waits for client shutdown, and a broker crash invalidates
connections without retrying a transaction.

The WASIX Rust endpoint already implements much of the framing and reset
behavior. Extract startup, TLS/GSS refusal, one-client admission, batching,
COPY handoff, and reset into a platform-neutral state machine with adapters for:

- WASIX `BackendSession`;
- a pinned native direct session;
- the native broker helper.

Its current cancellation path is not complete: `CancelRequest` is classified,
but PID/secret are not validated, no backend cancellation is invoked, and the
sequential accept loop cannot service the control connection while an ordinary
client owns the backend. TLS and GSS are refused. Treat cancellation as
unsupported until authenticated concurrent control acceptance and a guest
interrupt path are proven.

For broker, host the listener in the helper and return it through control IPC.
Native direct needs the duplex work below before claiming complete COPY and
idle backend-message delivery. One physical session still cannot reproduce
useful cross-session `LISTEN/NOTIFY` behavior.

If this endpoint is judged equivalent to server mode and therefore out of
scope, the honest result is no mainstream Rust ORM support in strict socketless
direct mode.

### Per-library decision

| Library | Normal API over one-session endpoint | Strict socketless option | Decision |
| --- | --- | --- | --- |
| SQLx | `PgConnection` or `PgPool` max one | New custom database/type/macro stack | Use endpoint; do not build custom SQLx |
| Diesel | `PgConnection` and r2d2 max one | Custom `Connection<Backend = Pg>`, unstable | Use endpoint; defer custom connection |
| diesel-async | `AsyncPgConnection` and pool max one | Large custom connection or tokio-postgres spike | Use endpoint |
| SeaORM | Stock PostgreSQL `ConnectOptions` max one | `ProxyDatabaseTrait` proof, semantically partial | Use endpoint; experiment only |
| tokio-postgres | Normal client over endpoint | `Config::connect_raw` supports arbitrary async I/O | Best in-memory client spike |
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

Over the endpoint, use stock `Postgres` and max one connection. Online
`query!` macros and `cargo sqlx prepare` still need a running endpoint or
checked-in offline metadata. Qualify `#[sqlx::test]` separately because it
expects an administrative endpoint that can create, drop, and reconnect to
per-test databases. Parallel tests require distinct roots/endpoints or forced
serialization; ordinary sequential tests do not inherently require a new root.

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

The first JavaScript adapters should not wait for this. It is necessary for
full `pg` semantics, a complete embedded Rust endpoint, and advanced ORM APIs.

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
or adapt these rather than rebuilding guest protocol machinery. The `/blocking`
entrypoint still cannot asynchronously refill a synchronous Wasm callback, even
when imported in an application Worker, so asynchronous COPY IN should require
the root package-Worker contract.

WASIX cancellation needs a real guest/host interrupt path. Worker cancellation
likely needs an out-of-band shared signal because normal RPC cannot run while
synchronous Wasm is executing.

### Capability staging

| Capability | Current foundation | First socketless JS adapter | Later work |
| --- | --- | --- | --- |
| CRUD and returning | Complete extended query | Shared decode/serialize | None |
| Transactions/savepoints | Callback transaction plus scheduler FIFO | No-`BEGIN` lease and ORM mapping | None after early rollback is correct |
| Multi-statement migrations | Raw simple query | Multi-result parser | None |
| Per-query parsers | Field OIDs returned | OID registry/overrides | Custom binary codecs |
| Inferred parameter serializers | Not in high-level native query | Reserved describe/bind cycles | Cache only after reset semantics exist |
| Named prepared statements | Expressible in raw protocol | Logical names only in Drizzle; reject `pg` query `name` | Cache and invalidation |
| Query notices | Raw response contains them | Parse during request | Event policy |
| Cancellation | Native global active cancel; none in WASIX | Explicitly capability-gated | Operation IDs and WASIX interrupt |
| Large result rows | Buffered typed; raw callback output | Buffered only | Pull-based row stream |
| COPY OUT | Raw callback stream | Unsupported in ORM layer | Typed reader |
| COPY IN | Native can prebuffer a complete request | Unsupported in ORM layer | Duplex writer |
| Idle `LISTEN/NOTIFY` | No native idle poll; only one backend | Unsupported | Multi-backend server or new idle pump |
| Full client facade | WASIX lightweight proxy only | Rust spike | Shared duplex endpoint |

The streaming, prepared-name, and COPY restrictions in this table describe the
socketless JavaScript/SeaQuery surface. Stock SQLx, Diesel, and tokio-postgres
over a qualified endpoint should retain real backend prepared statements and
their public streaming/COPY APIs wherever the endpoint conformance suite passes.

## Conformance and validation plan

### Runtime lanes

Run the same JavaScript adapter contract against:

- native TypeScript direct;
- native TypeScript broker;
- every desktop JavaScript host that is claimed;
- WASIX TypeScript `/blocking` in Node;
- WASIX TypeScript root Worker in Node;
- Chromium, Firefox, and WebKit with Worker plus memory storage;
- browser Worker plus IndexedDB;
- browser Worker plus OPFS where supported;
- browser `/blocking` only where intentionally supported;
- two tabs sharing one persistent identity after the multi-tab proxy exists.

Run the Rust endpoint contract against native direct, native broker, and the
WASIX Rust lightweight endpoint.

### JavaScript SQL and type cases

Every JavaScript adapter must cover:

- create/drop schema objects and migration apply/rollback;
- CRUD, upsert, joins, relations, and `RETURNING`;
- null and undefined input;
- bool, int2, int4, safe/unsafe int8, float4/8, numeric, text, and UUID;
- JSON/JSONB including nested data and bigint policy;
- bytea including zero bytes;
- date, time, timestamp, timestamptz, and interval;
- one- and multi-dimensional arrays, null elements, and empty arrays;
- enums, domains, enum arrays, and `refreshArrayTypes()`;
- parser and serializer overrides;
- duplicate output names in object and array modes;
- command tags, row counts, SQLSTATE, and every structured error field.

The Rust endpoint suites use each library's native Rust values and row APIs.
They must cover the same PostgreSQL families, nulls, arrays, enums/domains,
precision, binary/text formats, SQLSTATE fields, and custom types, but they do
not use JavaScript-only concepts such as `undefined`, safe versus unsafe JS
integers, bigint JSON policy, `refreshArrayTypes()`, or object/array row mode.

### Transaction and concurrency cases

- commit, callback rollback, and explicit rollback;
- nested savepoints;
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
- extension selection and persistent reopen;
- production bundle loading with COOP/COEP and Worker assets;
- large bytea/results with measured main-thread responsiveness.

### ORM-specific suites

| ORM/library | Required public-API proof |
| --- | --- |
| Kysely | Compiler, introspector, schema builder, migrations, plugins, transactions/savepoints, streaming rejection |
| Drizzle | Relational and SQL-like APIs, prepared objects, transactions/savepoints/config, migrations |
| MikroORM | Unit of work, entity manager CRUD, relations, cascades, schema generator, migrations, custom types, reopen |
| Knex/TypeORM later | Their migration, transaction, schema, pool, callback/Promise, and lifecycle APIs over `pg-compat` |
| SQLx endpoint | Prepared binary binds, streaming, offline/online macros, max-one pool, cancel, COPY |
| Diesel endpoint | Typed DSL, `sql_query`, migrations, transaction builder, r2d2 max one, COPY |
| diesel-async endpoint | Typed DSL, async transactions, pool max one, cancel/error forwarding |
| SeaORM endpoint | Entity/ActiveModel CRUD, relations, transactions, migrations, pool max one |
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
| Extensions | Select artifacts at open; `CREATE EXTENSION` cannot materialize code |
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
| Broker restart | Expose generation change and invalidate prepared/session state |
| Multi-tab | One fail-fast Web Lock owner today; build a leader proxy first |
| Direct browser | Blocks its realm and has side-module limits; Worker is default |
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
calling contracts. In this checkout the asset-independent suites and packed
package checks passed, but the runtime smokes could not execute because usable
native and staged WASIX runtime assets were absent; this report therefore makes
no fresh real-runtime claim for those lanes.

This completion makes the SDKs adapter-ready; it does not itself make a Kysely,
Drizzle, or PGlite-typed application source-compatible.

### 1. Add Kysely and Drizzle

- Implement `OliphauntDialect` through Kysely's public driver extension.
- Implement `@oliphaunt/drizzle` and propose the stable session upstream.
- Add programmatic migration fixtures.
- Reject streaming and multi-session behavior clearly.

Acceptance: both ORMs pass their public suites in native direct, broker, WASIX
root-Worker, IndexedDB, and OPFS browser lanes.

### 2. Qualify the single-tab browser host

- Test production bundlers, COOP/COEP, transfer behavior, responsiveness,
  Worker failure, and persistence poisoning.

Acceptance: Kysely and Drizzle pass in real single-tab browser builds with
memory, IndexedDB, and OPFS where supported, without blocking the main realm.

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

### 5. Run the Rust compatibility spike

- Extract the WASIX one-client proxy state machine.
- Prototype a pinned native-direct and broker-hosted endpoint.
- Prove SQLx, Diesel, diesel-async, and SeaORM with max-one pools.
- Include COPY, cancellation, failed-transaction disconnect, second-client
  `53300`, and SDK-query rejection while leased.
- In parallel, prototype `tokio-postgres connect_raw` and a SeaQuery executor.

Acceptance: choose either the one-session endpoint as the mainstream Rust ORM
path or an explicit no-direct-ORM policy. Do not leave this ambiguous.

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
- Use it for row streams, interactive COPY, notifications, and the complete
  embedded Rust endpoint.

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

```rust
let endpoint = database.open_pgwire_endpoint().await?;
let mut options = ConnectOptions::new(endpoint.connection_string());
options.max_connections(1);
let orm = Database::connect(options).await?;
```

Users should need to learn only three Oliphaunt-specific facts:

1. choose the native direct/broker/server or WASIX product; WASIX TypeScript's
   root Worker is the default, with caller-blocking work available only from its
   explicit `/blocking` import;
2. select storage and extension artifacts before open;
3. direct topology provides one physical session, so transactions are exclusive and
   pools are never larger than one.

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
