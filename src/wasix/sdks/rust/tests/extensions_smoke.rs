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

#[test]
#[ignore = "repeated native engine lifecycle diagnostic"]
fn vector_extension_repeated_lifecycle() -> Result<()> {
    let cycles: usize = std::env::var("OLIPHAUNT_RESEARCH_LIFECYCLE_CYCLES")
        .ok()
        .map(|value| value.parse())
        .transpose()?
        .unwrap_or(25);
    anyhow::ensure!(
        (1..=500).contains(&cycles),
        "invalid diagnostic cycle count"
    );
    for cycle in 0..cycles {
        {
            let mut database = Oliphaunt::builder().extension(Extension::VECTOR).open()?;
            database.execute("CREATE EXTENSION vector")?;
            assert!(database.query("SELECT 1 / 0").is_err());
            let result =
                database.query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance")?;
            assert_eq!(result.get_text(0, "distance")?, Some("1"));
            database.close()?;
        }
        #[cfg(windows)]
        record_closed_lifecycle_memory(cycle)?;
        eprintln!("completed_extension_lifecycle={cycle}");
    }
    Ok(())
}

#[cfg(windows)]
fn record_closed_lifecycle_memory(cycle: usize) -> Result<()> {
    #[repr(C)]
    struct Counters {
        cb: u32,
        page_faults: u32,
        values: [usize; 9],
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut std::ffi::c_void;
        fn K32GetProcessMemoryInfo(
            process: *mut std::ffi::c_void,
            counters: *mut Counters,
            bytes: u32,
        ) -> i32;
    }
    // The database and all query values have dropped. Allow queued cleanup to
    // run, then measure inside this same process before the next open starts.
    std::thread::sleep(std::time::Duration::from_millis(100));
    let mut counters = Counters {
        cb: std::mem::size_of::<Counters>() as u32,
        page_faults: 0,
        values: [0; 9],
    };
    if unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    eprintln!(
        "closed_extension_lifecycle={cycle} private_bytes={} working_set_bytes={}",
        counters.values[8], counters.values[1]
    );
    Ok(())
}
