use std::env;
use std::fs;
use std::path::PathBuf;

const SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const PRODUCT: &str = "oliphaunt-broker";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const KIND: &str = "broker-helper";
const TARGET: &str = "x86_64-unknown-linux-gnu";
const RELATIVE: &str = "bin/oliphaunt-broker";

fn main() {
    emit_manifest();
}

fn emit_manifest() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let source = manifest_dir.join("payload").join(RELATIVE);
    let checksum = manifest_dir.join("payload").join("sha256");
    println!("cargo::rerun-if-changed={}", source.display());
    println!("cargo::rerun-if-changed={}", checksum.display());
    if !source.is_file() || !checksum.is_file() {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!(
                "missing packaged oliphaunt-broker payload or checksum under {}",
                manifest_dir.join("payload").display()
            );
        }
        return;
    }
    let sha256 = fs::read_to_string(&checksum)
        .expect("read packaged oliphaunt-broker payload checksum");
    let sha256 = sha256.trim();
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        panic!("invalid packaged oliphaunt-broker payload checksum");
    }
    let manifest = out_dir.join("oliphaunt-artifact.toml");
    let text = format!(
        "schema = {SCHEMA:?}\nproduct = {PRODUCT:?}\nversion = {VERSION:?}\nkind = {KIND:?}\ntarget = {TARGET:?}\n\n[[files]]\nsource = {:?}\nrelative = {RELATIVE:?}\nsha256 = {sha256:?}\nexecutable = true\n",
        source.display().to_string(),
    );
    fs::write(&manifest, text).expect("write oliphaunt-broker artifact manifest");
    println!("cargo::metadata=manifest={}", manifest.display());
}
