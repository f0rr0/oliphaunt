use liboliphaunt_native_bindings::{
    EmbeddedResource, NativeConfig, NativeSession, materialize_embedded_resources,
    register_packaged_resources_dir,
};

const RESOURCES: &[EmbeddedResource] = include!(env!("OLIPHAUNT_EMBEDDED_RESOURCES_RS"));

fn main() -> Result<(), Box<dyn std::error::Error>> {
    register_packaged_resources_dir(materialize_embedded_resources(RESOURCES)?)?;
    let storage = std::path::PathBuf::from(
        std::env::var_os("OLIPHAUNT_INSTALLED_STORAGE").ok_or("storage was not declared")?,
    );
    let mut database = NativeSession::open(NativeConfig::direct(storage.clone()))?;
    database.exec_simple_query(
        "CREATE TABLE installed_answer(value int4); INSERT INTO installed_answer VALUES (42)",
    )?;
    database.close()?;
    let mut database = NativeSession::open(NativeConfig::direct(storage))?;
    let result = database.exec_simple_query("SELECT value FROM installed_answer")?;
    assert!(
        result
            .windows(13)
            .any(|value| value == b"D\0\0\0\x0c\0\x01\0\0\0\x0242")
    );
    database.close()?;
    eprintln!("installed Core Cargo consumer: direct SQL and reopen passed");
    Ok(())
}
