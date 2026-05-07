# Extensions

Bundled SQL extensions are enabled explicitly. The runtime installs only the
extension assets each database asks for.

The public extension API is available through the default feature set. If you
disable default features, enable `extensions`; it currently implies `bundled`
because extension constants are backed by packaged, smoke-tested extension
payloads.

## Enable Extensions At Open Time

The builder path is the easiest option and resolves bundled extension
dependencies before the database opens.

```rust,no_run
use pglite_oxide::{extensions, Pglite};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Pglite::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .extension(extensions::PG_TRGM)
        .open()?;
    db.close()?;
    Ok(())
}
```

You can also add multiple extensions at once:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Pglite::builder()
        .temporary()
        .extensions([extensions::HSTORE, extensions::LTREE, extensions::UNACCENT])
        .open()?;
    db.close()?;
    Ok(())
}
```

## Enable Extensions After Open

Use `enable_extension(...)` when you want to install an extension into an
already-open direct database:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Pglite::temporary()?;
    db.enable_extension(extensions::VECTOR)?;
    db.close()?;
    Ok(())
}
```

For dependency-heavy extensions, prefer the builder path. Builder requests are
resolved as a set before open, while `enable_extension(...)` installs the
extension you name into the current root.

## Preload Extension Artifacts

Use `preload_extensions(...)` when an extension-backed first query sits on a hot
path:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    Pglite::preload_extensions([extensions::VECTOR, extensions::PG_TRGM])?;
    Ok(())
}
```

## Server And CLI Usage

Extensions work in server mode too:

```rust,no_run
use pglite_oxide::{extensions, PgliteServer};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = PgliteServer::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .start()?;
    server.shutdown()?;
    Ok(())
}
```

The proxy CLI accepts SQL extension names:

```sh
pglite-proxy --temporary --extension vector --extension pg_trgm --print-uri
```

## Available Bundled Extensions

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
- `extensions::VECTOR`

`extensions::ALL` is the slice of all currently public bundled extensions.
`extensions::by_sql_name(...)` resolves a bundled extension constant from its SQL
name, for example `"vector"` or `"pg_trgm"`.

## Not Currently Available

The generated extension catalog currently tracks additional candidates that are
not part of the bundled public surface:

- `pgcrypto`
- `uuid-ossp`
- `postgis`

They are not in `extensions::ALL` and do not have public constants in the
current asset set.

## Safety And Install Behavior

Bundled extension archives are installed into the database root before their SQL
setup runs. Archive extraction is path-safe and validated against the packaged
asset manifest.
