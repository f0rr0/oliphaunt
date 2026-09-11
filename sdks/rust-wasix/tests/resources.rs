use anyhow::{Context, Result};
use oliphaunt_wasix::{CatalogProfile, ClusterSeed, DatabaseStorage, Oliphaunt};
use std::fs;

fn seed(profile: CatalogProfile) -> Result<ClusterSeed> {
    let key = match profile {
        CatalogProfile::Standard => "OLIPHAUNT_TEST_STANDARD_SEED",
        CatalogProfile::Icu => "OLIPHAUNT_TEST_ICU_SEED",
    };
    let archive = std::path::PathBuf::from(std::env::var_os(key).with_context(|| key)?);
    let manifest = archive.with_extension("").with_extension("json");
    Ok(ClusterSeed::new(fs::read(archive)?, fs::read(manifest)?))
}

fn check_profile(database: &mut Oliphaunt, profile: CatalogProfile) -> Result<()> {
    match profile {
        CatalogProfile::Standard => assert_eq!(
            database.query("SELECT (collversion IS NULL)::text AS value FROM pg_collation WHERE collname = 'unicode'")?.get_text(0, "value")?,
            Some("true")
        ),
        CatalogProfile::Icu => assert_eq!(
            database.query("SELECT string_agg(value, ',' ORDER BY value COLLATE \"en-x-icu\") AS value FROM (VALUES ('z'), ('a'), (chr(228))) AS input(value)")?.get_text(0, "value")?,
            Some("a,ä,z")
        ),
    }
    Ok(())
}

fn exercise(profile: CatalogProfile) -> Result<()> {
    let seed = seed(profile)?;
    let mut builder = Oliphaunt::builder().catalog_profile(profile);
    if profile == CatalogProfile::Icu {
        let root = std::path::PathBuf::from(
            std::env::var_os("OLIPHAUNT_TEST_ICU_ROOT").context("OLIPHAUNT_TEST_ICU_ROOT")?,
        );
        let data = fs::read(root.join("share/icu/icudt76l.dat"))?;
        let manifest = fs::read(root.join("manifest.properties"))?;
        let mut tampered = data.clone();
        tampered[0] ^= 1;
        assert_eq!(
            oliphaunt_wasix::IcuData::new(tampered, &manifest)
                .unwrap_err()
                .kind(),
            oliphaunt_wasix::ErrorKind::InvalidConfiguration,
        );
        builder = builder.icu_data(oliphaunt_wasix::IcuData::new(data, manifest)?);
    }
    let mut memory = builder.clone().seed(seed.clone()).open()?;
    check_profile(&mut memory, profile)?;
    assert_eq!(
        memory.query("SELECT 17 AS value")?.get_text(0, "value")?,
        Some("17")
    );
    memory.close()?;

    let workspace = tempfile::tempdir()?;
    let root = workspace.path().join("seeded");
    let mut database = builder
        .clone()
        .storage(DatabaseStorage::Directory(root.clone()))
        .seed(seed)
        .open()?;
    database.execute("CREATE TABLE resource_proof(value integer)")?;
    database.execute("INSERT INTO resource_proof VALUES (17)")?;
    database.close()?;
    drop(database);

    // A seed is initialization input, so even unusable seed bytes are irrelevant on reopen.
    let mut reopened = builder
        .clone()
        .storage(DatabaseStorage::Directory(root))
        .seed(ClusterSeed::new(b"unused".as_slice(), b"unused".as_slice()))
        .open()?;
    assert_eq!(
        reopened
            .query("SELECT sum(value) AS value FROM resource_proof")?
            .get_text(0, "value")?,
        Some("17")
    );
    reopened.close()?;

    for storage in [
        DatabaseStorage::Memory,
        DatabaseStorage::Directory(workspace.path().join("initialized")),
    ] {
        let mut database = builder.clone().storage(storage).open()?;
        check_profile(&mut database, profile)?;
        assert_eq!(
            database.query("SELECT 17 AS value")?.get_text(0, "value")?,
            Some("17")
        );
        database.close()?;
    }
    Ok(())
}

#[test]
#[ignore = "requires compiled WASIX runtime and separately produced resources; run test-resources.sh"]
fn standard_seed_and_initializer_support_memory_directory_and_reopen() -> Result<()> {
    exercise(CatalogProfile::Standard)
}

#[test]
#[ignore = "requires compiled WASIX runtime and separately produced resources; run test-resources.sh"]
fn icu_seed_and_initializer_support_memory_directory_and_reopen() -> Result<()> {
    exercise(CatalogProfile::Icu)
}
