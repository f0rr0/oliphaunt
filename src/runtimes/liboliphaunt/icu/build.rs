use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

const ARTIFACT_SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const ARTIFACT_PRODUCT: &str = "oliphaunt-icu";
const ARTIFACT_KIND: &str = "icu-data";
const ARTIFACT_TARGET: &str = "portable";
const PACKAGED_ICU_ARCHIVE: &str = "payload/icu-data.tar.zst";

fn main() {
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_ICU_DATA_DIR");
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD");

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let out = out_dir.join("generated_icu.rs");
    if let Some(archive) = find_packaged_icu_archive() {
        println!("cargo:rerun-if-changed={}", archive.display());
        let extracted_root = unpack_icu_archive(&archive, &out_dir.join("icu-data-expanded"));
        write_generated_icu(&out, Some(&archive));
        emit_artifact_manifest(&out_dir, &extracted_root);
    } else if let Some(icu_root) = find_icu_data_root() {
        emit_rerun_directives(&icu_root);
        let archive = out_dir.join("icu-data.tar.zst");
        write_icu_archive(&icu_root, &archive);
        write_generated_icu(&out, Some(&archive));
        emit_artifact_manifest(&out_dir, &icu_root);
    } else {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!(
                "release packaging requires package-local ICU data under payload/icu-data.tar.zst or payload/share/icu"
            );
        }
        write_generated_icu(&out, None);
    }
}

fn find_packaged_icu_archive() -> Option<PathBuf> {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let archive = manifest_dir.join(PACKAGED_ICU_ARCHIVE);
    archive.is_file().then_some(archive)
}

fn find_icu_data_root() -> Option<PathBuf> {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    for candidate in icu_candidates(&manifest_dir) {
        if let Some(root) = canonical_icu_data_root(&candidate) {
            return Some(root);
        }
    }
    None
}

fn icu_candidates(manifest_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.push(manifest_dir.join("payload/share/icu"));
    if let Some(path) = env::var_os("OLIPHAUNT_ICU_DATA_DIR") {
        candidates.push(PathBuf::from(path));
    }
    if let Some(repo) = repo_root_from_manifest_dir(manifest_dir) {
        candidates.push(repo.join("target/oliphaunt-wasix/icu/share/icu"));
        candidates.push(repo.join("target/oliphaunt-wasix/wasix-build/work/icu-wasix/share/icu"));
        candidates.push(repo.join("target/liboliphaunt-pg18/icu/share/icu"));
        candidates.push(repo.join("target/liboliphaunt-pg18/install/share/icu"));
        candidates.push(repo.join("target/native-liboliphaunt-pg18/install/share/icu"));
        if let Ok(entries) = fs::read_dir(repo.join("target")) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if name.starts_with("liboliphaunt-pg18-") {
                    candidates.push(path.join("icu/share/icu"));
                }
            }
        }
    }
    candidates
}

fn repo_root_from_manifest_dir(manifest_dir: &Path) -> Option<&Path> {
    manifest_dir.ancestors().find(|candidate| {
        candidate.join("Cargo.toml").is_file()
            && candidate
                .join("src/runtimes/liboliphaunt/icu/Cargo.toml")
                .is_file()
    })
}

fn unpack_icu_archive(archive: &Path, destination: &Path) -> PathBuf {
    if destination.exists() {
        fs::remove_dir_all(destination).expect("remove previously unpacked ICU data archive");
    }
    fs::create_dir_all(destination).expect("create ICU data archive destination");
    let file = fs::File::open(archive).expect("open packaged ICU data archive");
    let decoder = zstd::stream::read::Decoder::new(file).expect("decode packaged ICU data archive");
    let mut archive_reader = tar::Archive::new(decoder);
    let entries = archive_reader
        .entries()
        .expect("read packaged ICU data archive entries");
    for entry in entries {
        let mut entry = entry.expect("read packaged ICU data archive entry");
        let path = entry
            .path()
            .expect("read packaged ICU data archive entry path")
            .into_owned();
        let relative = icu_archive_relative_path(&path);
        let destination_path = destination.join(&relative);
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            fs::create_dir_all(&destination_path).expect("create ICU data archive directory");
            continue;
        }
        if !entry_type.is_file() {
            panic!(
                "packaged ICU data archive entry {} has unsupported type {:?}",
                path.display(),
                entry_type
            );
        }
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent).expect("create ICU data archive entry parent");
        }
        entry
            .unpack(&destination_path)
            .expect("unpack packaged ICU data archive entry");
    }
    let root = destination.join("share/icu");
    canonical_icu_data_root(&root).expect("packaged ICU data archive contains share/icu data")
}

fn icu_archive_relative_path(path: &Path) -> PathBuf {
    let mut relative = PathBuf::new();
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => {
                relative.push(part);
                components.push(part.to_owned());
            }
            _ => panic!("unsafe packaged ICU data archive entry {}", path.display()),
        }
    }
    let under_share_icu = components.first().and_then(|part| part.to_str()) == Some("share")
        && components.get(1).and_then(|part| part.to_str()) == Some("icu");
    if !under_share_icu {
        panic!(
            "packaged ICU data archive entry {} must stay under share/icu",
            path.display()
        );
    }
    relative
}

fn canonical_icu_data_root(candidate: &Path) -> Option<PathBuf> {
    if icu_root_contains_data(candidate) {
        return Some(candidate.to_path_buf());
    }
    let entries = fs::read_dir(candidate).ok()?;
    let mut dirs = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    dirs.sort();
    dirs.into_iter().find(|path| icu_root_contains_data(path))
}

fn icu_root_contains_data(root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_file() && name.starts_with("icudt") && name.ends_with(".dat") {
            return true;
        }
        if path.is_dir() && name.starts_with("icudt") && directory_has_file(&path) {
            return true;
        }
    }
    false
}

fn directory_has_file(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| entry.path().is_file())
}

fn emit_rerun_directives(root: &Path) {
    println!("cargo:rerun-if-changed={}", root.display());
    visit_files(root, &mut |path| {
        println!("cargo:rerun-if-changed={}", path.display());
    });
}

fn visit_files(path: &Path, f: &mut impl FnMut(&Path)) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit_files(&path, f);
        } else if path.is_file() {
            f(&path);
        }
    }
}

fn write_icu_archive(icu_root: &Path, archive: &Path) {
    let file = fs::File::create(archive).expect("create ICU data archive");
    let encoder = zstd::stream::write::Encoder::new(file, 19).expect("create zstd encoder");
    let mut builder = tar::Builder::new(encoder);
    for source in collect_files(icu_root).expect("collect ICU data files") {
        let relative = source
            .strip_prefix(icu_root)
            .expect("ICU file stays under ICU root");
        let archive_path = Path::new("share/icu").join(relative);
        builder
            .append_path_with_name(&source, &archive_path)
            .expect("append ICU data file");
    }
    let encoder = builder.into_inner().expect("finish ICU tar archive");
    encoder.finish().expect("finish ICU zstd archive");
}

fn write_generated_icu(out: &Path, archive: Option<&Path>) {
    let text = match archive {
        Some(archive) => format!(
            "pub const HAS_ICU_DATA: bool = true;\n\
             pub fn icu_data_archive() -> Option<&'static [u8]> {{ Some(include_bytes!({archive:?})) }}\n",
            archive = archive.to_string_lossy(),
        ),
        None => "pub const HAS_ICU_DATA: bool = false;\npub fn icu_data_archive() -> Option<&'static [u8]> { None }\n"
            .to_owned(),
    };
    fs::write(out, text).expect("write generated ICU data module");
}

fn emit_artifact_manifest(out_dir: &Path, icu_root: &Path) {
    let version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by Cargo");
    let manifest_path = out_dir.join("oliphaunt-artifact.toml");
    let files = collect_files(icu_root).expect("collect ICU data files for manifest");
    let mut text = format!(
        "schema = {ARTIFACT_SCHEMA:?}\nproduct = {ARTIFACT_PRODUCT:?}\nversion = {version:?}\nkind = {ARTIFACT_KIND:?}\ntarget = {ARTIFACT_TARGET:?}\n"
    );
    for file in files {
        let relative = file
            .strip_prefix(icu_root)
            .expect("ICU file stays under ICU root")
            .to_string_lossy()
            .replace('\\', "/");
        let sha256 = sha256_file(&file).expect("hash ICU data file");
        text.push_str(&format!(
            "\n[[files]]\nsource = {:?}\nrelative = {:?}\nsha256 = {:?}\nexecutable = false\n",
            file.display().to_string(),
            format!("share/icu/{relative}"),
            sha256,
        ));
    }
    fs::write(&manifest_path, text).expect("write ICU Cargo artifact manifest");
    println!("cargo::metadata=manifest={}", manifest_path.display());
}

fn collect_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_files_inner(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files_inner(path: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files_inner(&path, files)?;
        } else if path.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
