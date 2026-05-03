# Extensions

Bundled SQL extensions are enabled explicitly. The runtime installs only the
extension archives a database asks for.

## Usage

Enable extensions before opening a database:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

let mut db = Pglite::builder()
    .temporary()
    .extension(extensions::VECTOR)
    .extension(extensions::PG_TRGM)
    .extension(extensions::HSTORE)
    .open()?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Enable an extension after opening:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

let mut db = Pglite::builder().temporary().open()?;
db.enable_extension(extensions::VECTOR)?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Preload extension artifacts before a hot path:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

Pglite::preload_extensions([extensions::VECTOR, extensions::PG_TRGM, extensions::HSTORE])?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

## Available Extensions

Current public constants:

- `extensions::AGE`
- `extensions::AMCHECK`
- `extensions::AUTO_EXPLAIN`
- `extensions::BLOOM`
- `extensions::BTREE_GIN`
- `extensions::BTREE_GIST`
- `extensions::CITEXT`
- `extensions::CUBE`
- `extensions::DICT_INT`
- `extensions::DICT_XSYN`
- `extensions::EARTHDISTANCE`
- `extensions::FILE_FDW`
- `extensions::FUZZYSTRMATCH`
- `extensions::HSTORE`
- `extensions::INTARRAY`
- `extensions::ISN`
- `extensions::LO`
- `extensions::LTREE`
- `extensions::PAGEINSPECT`
- `extensions::PG_BUFFERCACHE`
- `extensions::PG_FREESPACEMAP`
- `extensions::PG_HASHIDS`
- `extensions::PG_IVM`
- `extensions::PG_SURGERY`
- `extensions::PG_TEXTSEARCH`
- `extensions::VECTOR`
- `extensions::PG_TRGM`
- `extensions::PG_UUIDV7`
- `extensions::PG_VISIBILITY`
- `extensions::PG_WALINSPECT`
- `extensions::PGTAP`
- `extensions::SEG`
- `extensions::TABLEFUNC`
- `extensions::TCN`
- `extensions::TSM_SYSTEM_ROWS`
- `extensions::TSM_SYSTEM_TIME`
- `extensions::UNACCENT`
- `extensions::ALL`

`extensions::ALL` lists every bundled extension that passed the smoke suite for
the current asset set. The asset manifest also carries non-public extension
build candidates so they can be smoke-tested before becoming API. `pgcrypto`,
PostGIS, and `uuid-ossp` are not packaged yet because they need pinned WASIX
native dependency stacks.

## Server Mode

Extensions can also be enabled for a local Postgres server:

```rust,no_run
use pglite_oxide::{extensions, PgliteServer};

let server = PgliteServer::builder()
    .temporary()
    .extension(extensions::VECTOR)
    .start()?;
# server.shutdown()?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Any Postgres client using the server URL can then run SQL against the enabled
extension.

## Safety

Extension files are installed into the database root before
`CREATE EXTENSION IF NOT EXISTS ...` runs. Archive extraction is path-safe and
hash-checked against the asset manifest.
