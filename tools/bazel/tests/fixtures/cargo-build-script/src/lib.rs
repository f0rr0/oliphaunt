include!(concat!(env!("OUT_DIR"), "/observed.rs"));

pub fn observed() -> u32 {
    assert_eq!(module_path!(), "public_probe_library");
    BUILD_SCRIPT_VALUE
}

#[test]
fn generated_value_is_consumed() {
    assert_eq!(observed(), 42);
}
