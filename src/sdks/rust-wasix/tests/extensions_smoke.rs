#![cfg(feature = "extension-vector")]

use anyhow::Result;
use oliphaunt_wasix::{Extension, Oliphaunt};

#[test]
fn vector_extension_works_in_direct_mode() -> Result<()> {
    let mut database = Oliphaunt::builder().extension(Extension::VECTOR).open()?;
    let selected_only = database
        .query("SELECT count(*)::int4 AS count FROM pg_extension WHERE extname = 'vector'")?;
    assert_eq!(selected_only.get_text(0, "count")?, Some("0"));
    database.execute("CREATE EXTENSION vector")?;
    let result = database.query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")?;
    assert_eq!(result.get_text(0, "distance")?, Some("1"));
    database.close()?;
    Ok(())
}
