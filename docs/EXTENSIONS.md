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

Pglite::preload_extensions([extensions::VECTOR, extensions::PG_TRGM])?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

## Available Extensions

Current public constants:

- `extensions::VECTOR`
- `extensions::PG_TRGM`
- `extensions::ALL`

`extensions::ALL` lists every bundled extension that passed the smoke suite for
the current asset set.

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
