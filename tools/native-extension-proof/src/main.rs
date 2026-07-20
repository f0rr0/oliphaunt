#![allow(dead_code)]

include!("../../../src/sdks/rust/tests/native_extensions.rs");

fn parse_usize_flag(arguments: &[String], name: &str, default: usize) -> usize {
    let flag = format!("--{name}");
    for (index, argument) in arguments.iter().enumerate() {
        if argument == &flag {
            return arguments
                .get(index + 1)
                .unwrap_or_else(|| panic!("{flag} requires a value"))
                .parse::<usize>()
                .unwrap_or_else(|_| panic!("{flag} must be an unsigned integer"));
        }
        if let Some(value) = argument.strip_prefix(&format!("{flag}=")) {
            return value
                .parse::<usize>()
                .unwrap_or_else(|_| panic!("{flag} must be an unsigned integer"));
        }
    }
    default
}

fn main() {
    if let Some(result) = run_direct_extension_child_from_env() {
        result.expect("native extension proof direct child failed");
        return;
    }
    unsafe {
        std::env::set_var(RELEASE_PROOF_RUNNER_ENV, "1");
    }
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let shard_index = parse_usize_flag(&arguments, "shard-index", 0);
    let shard_count = parse_usize_flag(&arguments, "shard-count", 1);
    run_native_extension_release_proof(shard_index, shard_count);
}
