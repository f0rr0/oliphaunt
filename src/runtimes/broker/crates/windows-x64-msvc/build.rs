use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::PathBuf;

const SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const PRODUCT: &str = "oliphaunt-broker";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const KIND: &str = "broker-helper";
const TARGET: &str = "x86_64-pc-windows-msvc";
const RELATIVE: &str = "bin/oliphaunt-broker.exe";
const VC_RUNTIME_RECEIPT: &str = "bin/windows-vc-runtime.sha256";
const ALLOWED_VC_RUNTIME_DLLS: [&str; 3] =
    ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

fn main() {
    emit_manifest();
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn parse_checksum_lines(text: &str, label: &str) -> BTreeMap<String, String> {
    if !text.ends_with('\n') || text.contains('\r') {
        panic!("{label} must use canonical LF-terminated lines");
    }
    let mut values = BTreeMap::new();
    let mut previous: Option<&str> = None;
    for line in text.lines() {
        let (digest, relative) = line
            .split_once("  ")
            .unwrap_or_else(|| panic!("malformed {label} line"));
        if !valid_sha256(digest)
            || relative.is_empty()
            || relative.contains("  ")
            || relative.starts_with('/')
            || relative.contains("\\")
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            panic!("invalid {label} entry {relative:?}");
        }
        if previous.is_some_and(|value| value >= relative) {
            panic!("{label} entries must be unique and bytewise sorted");
        }
        previous = Some(relative);
        values.insert(relative.to_owned(), digest.to_owned());
    }
    values
}

fn emit_manifest() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let payload_dir = manifest_dir.join("payload");
    let checksum = payload_dir.join("sha256");
    println!("cargo::rerun-if-changed={}", checksum.display());
    if !checksum.is_file() {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!(
                "missing packaged oliphaunt-broker checksum under {}",
                payload_dir.display()
            );
        }
        return;
    }

    let checksum_text =
        fs::read_to_string(&checksum).expect("read packaged oliphaunt-broker payload checksums");
    let checksums = parse_checksum_lines(&checksum_text, "payload/sha256");
    let allowed: BTreeSet<String> = [RELATIVE.to_owned(), VC_RUNTIME_RECEIPT.to_owned()]
        .into_iter()
        .chain(
            ALLOWED_VC_RUNTIME_DLLS
                .iter()
                .map(|name| format!("bin/{name}")),
        )
        .collect();
    if !checksums.contains_key(RELATIVE) || !checksums.contains_key(VC_RUNTIME_RECEIPT) {
        panic!("Windows broker payload must contain its executable and VC runtime receipt");
    }
    if checksums.keys().any(|relative| !allowed.contains(relative)) {
        panic!("Windows broker payload checksum contains an undeclared member");
    }

    let receipt_path = payload_dir.join(VC_RUNTIME_RECEIPT);
    let receipt_text =
        fs::read_to_string(&receipt_path).expect("read packaged Windows VC runtime receipt");
    let receipt = parse_checksum_lines(&receipt_text, VC_RUNTIME_RECEIPT);
    if receipt.is_empty() {
        panic!("Windows broker VC runtime receipt must not be empty");
    }
    for (name, digest) in &receipt {
        if !ALLOWED_VC_RUNTIME_DLLS.contains(&name.as_str()) {
            panic!("Windows broker VC runtime receipt contains undeclared {name}");
        }
        if checksums.get(&format!("bin/{name}")) != Some(digest) {
            panic!("Windows broker VC runtime receipt and payload checksum disagree for {name}");
        }
    }
    let expected_members = receipt
        .keys()
        .map(|name| format!("bin/{name}"))
        .chain([RELATIVE.to_owned(), VC_RUNTIME_RECEIPT.to_owned()])
        .collect::<BTreeSet<_>>();
    if checksums.keys().cloned().collect::<BTreeSet<_>>() != expected_members {
        panic!("Windows broker payload must exactly match its import-derived VC runtime receipt");
    }

    let manifest = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {SCHEMA:?}\nproduct = {PRODUCT:?}\nversion = {VERSION:?}\nkind = {KIND:?}\ntarget = {TARGET:?}\n",
    );
    for (relative, digest) in checksums {
        let source = payload_dir.join(&relative);
        println!("cargo::rerun-if-changed={}", source.display());
        if !source.is_file() {
            panic!(
                "missing packaged oliphaunt-broker payload {}",
                source.display()
            );
        }
        text.push_str(&format!(
            "\n[[files]]\nsource = {:?}\nrelative = {relative:?}\nsha256 = {digest:?}\nexecutable = {}\n",
            source.display().to_string(),
            relative == RELATIVE,
        ));
    }
    fs::write(&manifest, text).expect("write oliphaunt-broker artifact manifest");
    println!("cargo::metadata=manifest={}", manifest.display());
}
