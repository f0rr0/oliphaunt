# oliphaunt-icu

Optional ICU data and matching PostgreSQL catalog seeds for Oliphaunt.

```toml
[dependencies]
oliphaunt = "0.2"
oliphaunt-icu = "0.2"
```

```rust
let db = oliphaunt::Oliphaunt::builder()
    .icu(oliphaunt_icu::ICU)
    .open()?;
```

The package embeds the current native target's seed and ICU data. WASIX
consumers use `oliphaunt-wasix-icu` with `oliphaunt-wasix` instead.
Base runtime carriers include only the standard seed.
