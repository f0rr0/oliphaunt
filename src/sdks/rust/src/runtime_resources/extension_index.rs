use super::*;
use std::path::Component;

/// Resolve exact prebuilt extension artifacts from local release index files.
///
/// The index is only a locator and integrity manifest. Every referenced
/// artifact is checksum-verified, loaded through the same
/// `oliphaunt-extension-artifact-v1` parser used by the package consumer, and
/// resolved transitively by exact dependency names.
pub fn resolve_prebuilt_extension_artifacts_from_indexes(
    options: NativeExtensionArtifactIndexOptions,
) -> Result<NativeExtensionArtifactIndexResolution> {
    if options.target.trim().is_empty() {
        return Err(Error::InvalidConfig(
            "extension artifact index target must not be empty".to_owned(),
        ));
    }
    validate_portable_id(&options.target, "extension artifact index target")?;
    if options.extensions.is_empty() {
        return Ok(NativeExtensionArtifactIndexResolution {
            artifacts: Vec::new(),
            extension_names: Vec::new(),
        });
    }
    if options.indexes.is_empty() {
        return Err(Error::InvalidConfig(
            "external extension selection requires at least one --extension-index <file>"
                .to_owned(),
        ));
    }

    validate_extension_artifact_index_trust_options(&options)?;
    let entries = load_extension_artifact_indexes(
        &options.indexes,
        &options.trusted_signing_keys,
        options.require_signatures,
    )?;
    let mut artifacts = Vec::new();
    let mut extension_names = Vec::new();
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let artifact_cache_dir = options.artifact_cache_dir.as_deref();
    for extension in options.extensions {
        validate_portable_id(&extension, "extension artifact index selection")?;
        visit_extension_artifact_index_entry(
            &extension,
            &options.target,
            &entries,
            artifact_cache_dir,
            &mut visiting,
            &mut visited,
            &mut artifacts,
            &mut extension_names,
        )?;
    }
    extension_names.sort();
    extension_names.dedup();
    Ok(NativeExtensionArtifactIndexResolution {
        artifacts,
        extension_names,
    })
}

/// List exact external extensions advertised by prebuilt artifact indexes.
///
/// This is a discovery path for app/release tooling: it verifies signed indexes
/// when trust roots are configured, then returns the target-specific metadata
/// the publisher recorded for each external extension. Artifact bytes are still
/// verified when a selected extension is resolved for packaging.
pub fn list_prebuilt_extension_artifact_index_catalog(
    options: NativeExtensionArtifactIndexOptions,
) -> Result<NativeExtensionArtifactIndexCatalog> {
    if options.target.trim().is_empty() {
        return Err(Error::InvalidConfig(
            "extension artifact index target must not be empty".to_owned(),
        ));
    }
    validate_portable_id(&options.target, "extension artifact index target")?;
    validate_extension_artifact_index_trust_options(&options)?;
    if options.indexes.is_empty() {
        return Ok(NativeExtensionArtifactIndexCatalog {
            extensions: Vec::new(),
        });
    }
    let entries = load_extension_artifact_indexes(
        &options.indexes,
        &options.trusted_signing_keys,
        options.require_signatures,
    )?;
    let mut extensions = entries
        .values()
        .filter(|entry| entry.target == options.target)
        .map(|entry| NativeExtensionArtifactIndexCatalogEntry {
            sql_name: entry.sql_name.clone(),
            target: entry.target.clone(),
            creates_extension: entry.creates_extension,
            native_module_stem: entry.native_module_stem.clone(),
            dependencies: entry.dependencies.clone(),
            shared_preload_libraries: entry.shared_preload_libraries.clone(),
            mobile_prebuilt: entry.native_module_stem.is_none() || entry.mobile_prebuilt,
            mobile_static_archive_targets: entry.mobile_static_archive_targets.clone(),
            url: entry.url.clone(),
        })
        .collect::<Vec<_>>();
    extensions.sort_by(|left, right| left.sql_name.cmp(&right.sql_name));
    Ok(NativeExtensionArtifactIndexCatalog { extensions })
}

/// Create a local exact prebuilt extension artifact index from validated
/// archive artifacts.
///
/// The index producer verifies every artifact through the same schema parser
/// used by package consumption, rejects built-in release-ready extension names,
/// computes byte counts and SHA-256 digests, and writes relative paths only.
pub fn create_prebuilt_extension_artifact_index(
    options: NativeExtensionArtifactIndexCreateOptions,
) -> Result<NativeExtensionArtifactIndex> {
    validate_extension_artifact_index_create_options(&options)?;
    prepare_output_file(&options.output, options.replace_existing)?;
    let index_parent = options.output.parent().unwrap_or_else(|| Path::new(""));
    let mut seen = BTreeSet::new();
    let mut rows = Vec::new();
    for artifact_path in &options.artifacts {
        let mut row =
            create_extension_artifact_index_row(index_parent, &options.target, artifact_path)?;
        if let Some(base_url) = &options.artifact_base_url {
            row.url = Some(join_extension_artifact_base_url(base_url, &row.path)?);
        }
        if !seen.insert(row.sql_name.clone()) {
            return Err(Error::InvalidConfig(format!(
                "extension artifact index cannot contain duplicate extension '{}'",
                row.sql_name
            )));
        }
        rows.push(row);
    }
    rows.sort_by(|left, right| left.sql_name.cmp(&right.sql_name));
    let text = extension_artifact_index_toml(&rows);
    fs::write(&options.output, text).map_err(|err| {
        Error::Engine(format!(
            "write extension artifact index {}: {err}",
            options.output.display()
        ))
    })?;
    Ok(NativeExtensionArtifactIndex {
        path: options.output,
        target: options.target,
        artifacts: rows,
    })
}

/// Sign an exact prebuilt extension artifact index with Ed25519.
///
/// The detached signature covers the exact index bytes on disk. The signature
/// file is a small TOML sidecar at `<index>.sig` unless an explicit path is
/// supplied.
pub fn sign_prebuilt_extension_artifact_index(
    options: NativeExtensionArtifactIndexSigningOptions,
) -> Result<NativeExtensionArtifactIndexSignature> {
    validate_extension_artifact_index_signing_options(&options)?;
    let index_bytes = fs::read(&options.index).map_err(|err| {
        Error::InvalidConfig(format!(
            "read extension artifact index {} for signing: {err}",
            options.index.display()
        ))
    })?;
    let signature_path = options
        .signature_path
        .clone()
        .unwrap_or_else(|| default_extension_artifact_index_signature_path(&options.index));
    prepare_output_file(&signature_path, options.replace_existing)?;
    let signed = sign_extension_artifact_index_bytes(
        &options.key_id,
        &options.signing_key_hex,
        &index_bytes,
    )?;
    let text = extension_artifact_index_signature_toml(&signed);
    fs::write(&signature_path, text).map_err(|err| {
        Error::Engine(format!(
            "write extension artifact index signature {}: {err}",
            signature_path.display()
        ))
    })?;
    Ok(NativeExtensionArtifactIndexSignature {
        path: signature_path,
        index: options.index,
        key_id: signed.key_id,
        public_key_hex: signed.public_key_hex,
        signature_hex: signed.signature_hex,
    })
}

fn validate_extension_artifact_index_create_options(
    options: &NativeExtensionArtifactIndexCreateOptions,
) -> Result<()> {
    if options.output.as_os_str().is_empty() {
        return Err(Error::InvalidConfig(
            "extension artifact index output path must not be empty".to_owned(),
        ));
    }
    if options.target.trim().is_empty() {
        return Err(Error::InvalidConfig(
            "extension artifact index target must not be empty".to_owned(),
        ));
    }
    validate_portable_id(&options.target, "extension artifact index target")?;
    if options.artifacts.is_empty() {
        return Err(Error::InvalidConfig(
            "extension artifact index requires at least one artifact archive".to_owned(),
        ));
    }
    if let Some(base_url) = &options.artifact_base_url {
        validate_extension_artifact_url(&options.output, base_url)?;
        if !base_url.starts_with("https://") && !base_url.starts_with("file://") {
            return Err(Error::InvalidConfig(format!(
                "extension artifact index base URL '{}' must start with https://",
                base_url
            )));
        }
    }
    Ok(())
}

fn validate_extension_artifact_index_trust_options(
    options: &NativeExtensionArtifactIndexOptions,
) -> Result<()> {
    let mut keys = BTreeMap::new();
    for key in &options.trusted_signing_keys {
        validate_portable_id(&key.key_id, "extension artifact index trusted key id")?;
        let normalized = normalize_hex(&key.public_key_hex);
        decode_hex_fixed::<32>(
            "extension artifact index trusted Ed25519 public key",
            &normalized,
        )?;
        if let Some(previous) = keys.insert(key.key_id.clone(), normalized.clone()) {
            if previous != normalized {
                return Err(Error::InvalidConfig(format!(
                    "extension artifact index trusted key '{}' was provided with multiple public keys",
                    key.key_id
                )));
            }
        }
    }
    if options.require_signatures && options.trusted_signing_keys.is_empty() {
        return Err(Error::InvalidConfig(
            "signed extension artifact indexes require at least one trusted publisher key"
                .to_owned(),
        ));
    }
    Ok(())
}

fn validate_extension_artifact_index_signing_options(
    options: &NativeExtensionArtifactIndexSigningOptions,
) -> Result<()> {
    if options.index.as_os_str().is_empty() {
        return Err(Error::InvalidConfig(
            "extension artifact index signing path must not be empty".to_owned(),
        ));
    }
    if !options.index.is_file() {
        return Err(Error::InvalidConfig(format!(
            "extension artifact index {} must be an existing file before signing",
            options.index.display()
        )));
    }
    validate_portable_id(&options.key_id, "extension artifact index signing key id")?;
    decode_hex_fixed::<32>(
        "extension artifact index Ed25519 signing key",
        &options.signing_key_hex,
    )?;
    Ok(())
}

fn create_extension_artifact_index_row(
    index_parent: &Path,
    target: &str,
    artifact_path: &Path,
) -> Result<NativeExtensionArtifactIndexArtifact> {
    let metadata = fs::metadata(artifact_path).map_err(|err| {
        Error::InvalidConfig(format!(
            "stat extension artifact {} for index: {err}",
            artifact_path.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(Error::InvalidConfig(format!(
            "extension artifact index can only reference archive files, got {}",
            artifact_path.display()
        )));
    }
    let prepared =
        PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
            artifact_path,
        )])?;
    let loaded = load_prebuilt_extension_artifact(&prepared.artifacts()[0].root)?;
    if let Some(native_target) = &loaded.native_target {
        if native_target != target {
            return Err(Error::InvalidConfig(format!(
                "extension artifact {} declares nativeTarget='{}' but index target is '{}'",
                artifact_path.display(),
                native_target,
                target
            )));
        }
    }
    if Extension::by_release_ready_sql_name(&loaded.sql_name).is_some() {
        return Err(Error::InvalidConfig(format!(
            "extension artifact index cannot override built-in release-ready extension '{}'",
            loaded.sql_name
        )));
    }
    let relative = artifact_path.strip_prefix(index_parent).map_err(|_| {
        Error::InvalidConfig(format!(
            "extension artifact {} must be inside index directory {} so the index can record a relative path",
            artifact_path.display(),
            index_parent.display()
        ))
    })?;
    validate_relative_artifact_path(index_parent, "artifact path", relative)?;
    let mobile_static_archive_targets =
        mobile_static_archive_targets(&loaded.mobile_static_archives);
    Ok(NativeExtensionArtifactIndexArtifact {
        sql_name: loaded.sql_name,
        target: target.to_owned(),
        creates_extension: loaded.creates_extension,
        native_module_stem: loaded.native_module_stem,
        dependencies: loaded.dependencies,
        shared_preload_libraries: loaded.shared_preload_libraries,
        mobile_prebuilt: loaded.mobile_prebuilt,
        mobile_static_archive_targets,
        path: relative.to_path_buf(),
        url: None,
        sha256: sha256_file_hex(artifact_path)?,
        bytes: metadata.len(),
    })
}

fn extension_artifact_index_toml(rows: &[NativeExtensionArtifactIndexArtifact]) -> String {
    let mut text = format!(
        "schema = {schema}\npg_major = 18\n",
        schema = toml_string(EXTENSION_ARTIFACT_INDEX_LAYOUT)
    );
    for row in rows {
        text.push_str(&format!(
            "\n[[artifacts]]\nsql_name = {}\ntarget = {}\ncreates_extension = {}\n",
            toml_string(&row.sql_name),
            toml_string(&row.target),
            row.creates_extension,
        ));
        if let Some(stem) = &row.native_module_stem {
            text.push_str(&format!("native_module_stem = {}\n", toml_string(stem)));
        }
        text.push_str(&format!(
            "dependencies = {}\nshared_preload_libraries = {}\nmobile_prebuilt = {}\nmobile_static_archive_targets = {}\npath = {}\n",
            toml_string_array(&row.dependencies),
            toml_string_array(&row.shared_preload_libraries),
            row.mobile_prebuilt,
            toml_string_array(&row.mobile_static_archive_targets),
            toml_string(&row.path.to_string_lossy()),
        ));
        if let Some(url) = &row.url {
            text.push_str(&format!("url = {}\n", toml_string(url)));
        }
        text.push_str(&format!(
            "sha256 = {}\nbytes = {}\n",
            toml_string(&row.sha256),
            row.bytes,
        ));
    }
    text
}

fn toml_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push_str(&format!("\\u{:04x}", ch as u32)),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn toml_string_array(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| toml_string(value))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn validate_extension_artifact_url(index_path: &Path, url: &str) -> Result<()> {
    if url.trim() != url || url.is_empty() || url.chars().any(char::is_control) {
        return Err(Error::InvalidConfig(format!(
            "extension artifact index {} has invalid artifact URL '{}'",
            index_path.display(),
            url
        )));
    }
    if url.starts_with("https://") || url.starts_with("file://") {
        return Ok(());
    }
    Err(Error::InvalidConfig(format!(
        "extension artifact index {} artifact URL '{}' must start with https:// or file://",
        index_path.display(),
        url
    )))
}

fn join_extension_artifact_base_url(base_url: &str, relative: &Path) -> Result<String> {
    validate_relative_artifact_path(Path::new("extension-index"), "artifact URL path", relative)?;
    let relative = relative
        .components()
        .map(|component| match component {
            Component::Normal(part) => part
                .to_str()
                .map(percent_encode_url_path_segment)
                .ok_or_else(|| {
                    Error::InvalidConfig(format!(
                        "extension artifact URL path '{}' must be valid UTF-8",
                        relative.display()
                    ))
                }),
            _ => Err(Error::InvalidConfig(format!(
                "extension artifact URL path '{}' must be relative",
                relative.display()
            ))),
        })
        .collect::<Result<Vec<_>>>()?
        .join("/");
    let separator = if base_url.ends_with('/') { "" } else { "/" };
    Ok(format!("{base_url}{separator}{relative}"))
}

fn percent_encode_url_path_segment(segment: &str) -> String {
    let mut out = String::new();
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn load_extension_artifact_indexes(
    index_paths: &[PathBuf],
    trusted_signing_keys: &[NativeExtensionArtifactIndexTrustRoot],
    require_signatures: bool,
) -> Result<BTreeMap<(String, String), ExtensionArtifactIndexEntry>> {
    let mut entries = BTreeMap::new();
    for index_path in index_paths {
        let index =
            load_extension_artifact_index(index_path, trusted_signing_keys, require_signatures)?;
        for entry in index {
            let key = (entry.target.clone(), entry.sql_name.clone());
            if entries.insert(key.clone(), entry).is_some() {
                return Err(Error::InvalidConfig(format!(
                    "extension artifact indexes define duplicate artifact for target '{}' extension '{}'",
                    key.0, key.1
                )));
            }
        }
    }
    Ok(entries)
}

fn load_extension_artifact_index(
    index_path: &Path,
    trusted_signing_keys: &[NativeExtensionArtifactIndexTrustRoot],
    require_signatures: bool,
) -> Result<Vec<ExtensionArtifactIndexEntry>> {
    verify_extension_artifact_index_signature_if_required(
        index_path,
        trusted_signing_keys,
        require_signatures,
    )?;
    let text = fs::read_to_string(index_path).map_err(|err| {
        Error::InvalidConfig(format!(
            "read extension artifact index {}: {err}",
            index_path.display()
        ))
    })?;
    let parsed = toml::from_str::<ExtensionArtifactIndexToml>(&text).map_err(|err| {
        Error::InvalidConfig(format!(
            "parse extension artifact index {}: {err}",
            index_path.display()
        ))
    })?;
    if parsed.schema != EXTENSION_ARTIFACT_INDEX_LAYOUT {
        return Err(Error::InvalidConfig(format!(
            "extension artifact index {} has schema='{}', expected '{}'",
            index_path.display(),
            parsed.schema,
            EXTENSION_ARTIFACT_INDEX_LAYOUT
        )));
    }
    if parsed.pg_major != 18 {
        return Err(Error::InvalidConfig(format!(
            "extension artifact index {} targets PostgreSQL {}; Oliphaunt native packages require PostgreSQL 18",
            index_path.display(),
            parsed.pg_major
        )));
    }
    if parsed.artifacts.is_empty() {
        return Err(Error::InvalidConfig(format!(
            "extension artifact index {} must contain at least one [[artifacts]] entry",
            index_path.display()
        )));
    }
    let base = index_path.parent().unwrap_or_else(|| Path::new(""));
    let mut out = Vec::new();
    for artifact in parsed.artifacts {
        validate_portable_id(&artifact.sql_name, "extension artifact index sql_name")?;
        validate_portable_id(&artifact.target, "extension artifact index target")?;
        if let Some(stem) = &artifact.native_module_stem {
            validate_portable_id(stem, "extension artifact index native_module_stem")?;
        }
        for dependency in &artifact.dependencies {
            validate_portable_id(dependency, "extension artifact index dependency")?;
        }
        for library in &artifact.shared_preload_libraries {
            validate_portable_id(library, "extension artifact index shared_preload_libraries")?;
        }
        for target in &artifact.mobile_static_archive_targets {
            validate_portable_id(
                target,
                "extension artifact index mobile_static_archive_targets",
            )?;
        }
        validate_sha256_hex(index_path, &artifact.sha256)?;
        if Extension::by_release_ready_sql_name(&artifact.sql_name).is_some() {
            return Err(Error::InvalidConfig(format!(
                "extension artifact index {} cannot override built-in release-ready extension '{}'",
                index_path.display(),
                artifact.sql_name
            )));
        }
        let relative = PathBuf::from(&artifact.path);
        validate_relative_artifact_path(index_path, "artifact path", &relative)?;
        if let Some(url) = &artifact.url {
            validate_extension_artifact_url(index_path, url)?;
        }
        out.push(ExtensionArtifactIndexEntry {
            index_path: index_path.to_path_buf(),
            sql_name: artifact.sql_name,
            target: artifact.target,
            creates_extension: artifact.creates_extension,
            native_module_stem: artifact.native_module_stem,
            dependencies: sorted_deduped_strings(&artifact.dependencies),
            shared_preload_libraries: sorted_deduped_strings(&artifact.shared_preload_libraries),
            mobile_prebuilt: artifact.mobile_prebuilt,
            mobile_static_archive_targets: sorted_deduped_strings(
                &artifact.mobile_static_archive_targets,
            ),
            relative_path: relative.clone(),
            path: base.join(relative),
            url: artifact.url,
            sha256: artifact.sha256.to_ascii_lowercase(),
            bytes: artifact.bytes,
        });
    }
    Ok(out)
}

fn validate_sha256_hex(index_path: &Path, value: &str) -> Result<()> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err(Error::InvalidConfig(format!(
        "extension artifact index {} has invalid sha256 '{}'",
        index_path.display(),
        value
    )))
}

fn verify_extension_artifact_index_signature_if_required(
    index_path: &Path,
    trusted_signing_keys: &[NativeExtensionArtifactIndexTrustRoot],
    require_signatures: bool,
) -> Result<()> {
    if trusted_signing_keys.is_empty() && !require_signatures {
        return Ok(());
    }
    if trusted_signing_keys.is_empty() {
        return Err(Error::InvalidConfig(
            "signed extension artifact index verification requires at least one trusted publisher key"
                .to_owned(),
        ));
    }
    let signature_path = default_extension_artifact_index_signature_path(index_path);
    let signature_text = fs::read_to_string(&signature_path).map_err(|err| {
        Error::InvalidConfig(format!(
            "read extension artifact index signature {} for {}: {err}",
            signature_path.display(),
            index_path.display()
        ))
    })?;
    let signature = toml::from_str::<ExtensionArtifactIndexSignatureToml>(&signature_text)
        .map_err(|err| {
            Error::InvalidConfig(format!(
                "parse extension artifact index signature {}: {err}",
                signature_path.display()
            ))
        })?;
    if signature.schema != EXTENSION_ARTIFACT_INDEX_SIGNATURE_LAYOUT {
        return Err(Error::InvalidConfig(format!(
            "extension artifact index signature {} has schema='{}', expected '{}'",
            signature_path.display(),
            signature.schema,
            EXTENSION_ARTIFACT_INDEX_SIGNATURE_LAYOUT
        )));
    }
    if signature.algorithm != "ed25519" {
        return Err(Error::InvalidConfig(format!(
            "extension artifact index signature {} has algorithm='{}', expected 'ed25519'",
            signature_path.display(),
            signature.algorithm
        )));
    }
    validate_portable_id(
        &signature.key_id,
        "extension artifact index signature key id",
    )?;
    validate_sha256_hex_like(
        &signature_path,
        "extension artifact index signature",
        &signature.signature,
        128,
    )?;
    let trusted = trusted_signing_keys
        .iter()
        .find(|key| key.key_id == signature.key_id)
        .ok_or_else(|| {
            Error::InvalidConfig(format!(
                "extension artifact index signature {} uses untrusted key '{}'",
                signature_path.display(),
                signature.key_id
            ))
        })?;
    let trusted_public_key = normalize_hex(&trusted.public_key_hex);
    if let Some(public_key) = &signature.public_key {
        let signature_public_key = normalize_hex(public_key);
        decode_hex_fixed::<32>(
            "extension artifact index signature public key",
            &signature_public_key,
        )?;
        if signature_public_key != trusted_public_key {
            return Err(Error::InvalidConfig(format!(
                "extension artifact index signature {} public key does not match trusted key '{}'",
                signature_path.display(),
                signature.key_id
            )));
        }
    }
    let index_bytes = fs::read(index_path).map_err(|err| {
        Error::InvalidConfig(format!(
            "read extension artifact index {} for signature verification: {err}",
            index_path.display()
        ))
    })?;
    verify_extension_artifact_index_signature_bytes(
        &trusted_public_key,
        &signature.signature,
        &index_bytes,
        &signature_path,
    )
}

fn default_extension_artifact_index_signature_path(index_path: &Path) -> PathBuf {
    let mut value = index_path.as_os_str().to_os_string();
    value.push(".sig");
    PathBuf::from(value)
}

fn validate_sha256_hex_like(
    path: &Path,
    label: &str,
    value: &str,
    expected_len: usize,
) -> Result<()> {
    if value.len() == expected_len && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err(Error::InvalidConfig(format!(
        "{} {} has invalid {} '{}'",
        label,
        path.display(),
        if expected_len == 64 { "sha256" } else { "hex" },
        value
    )))
}

#[derive(Debug)]
struct SignedExtensionArtifactIndex {
    key_id: String,
    public_key_hex: String,
    signature_hex: String,
}

#[cfg(feature = "extension-signing")]
fn sign_extension_artifact_index_bytes(
    key_id: &str,
    signing_key_hex: &str,
    index_bytes: &[u8],
) -> Result<SignedExtensionArtifactIndex> {
    use ed25519_dalek::{Signer, SigningKey};

    let signing_key_bytes = decode_hex_fixed::<32>(
        "extension artifact index Ed25519 signing key",
        signing_key_hex,
    )?;
    let signing_key = SigningKey::from_bytes(&signing_key_bytes);
    let public_key = signing_key.verifying_key().to_bytes();
    let signature = signing_key.sign(index_bytes).to_bytes();
    Ok(SignedExtensionArtifactIndex {
        key_id: key_id.to_owned(),
        public_key_hex: hex_bytes(&public_key),
        signature_hex: hex_bytes(&signature),
    })
}

#[cfg(not(feature = "extension-signing"))]
fn sign_extension_artifact_index_bytes(
    _key_id: &str,
    _signing_key_hex: &str,
    _index_bytes: &[u8],
) -> Result<SignedExtensionArtifactIndex> {
    Err(Error::InvalidConfig(
        "signing extension artifact indexes requires an oliphaunt-extension-index binary built with the extension-signing feature"
            .to_owned(),
    ))
}

#[cfg(feature = "extension-signing")]
fn verify_extension_artifact_index_signature_bytes(
    public_key_hex: &str,
    signature_hex: &str,
    index_bytes: &[u8],
    signature_path: &Path,
) -> Result<()> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let public_key = decode_hex_fixed::<32>(
        "extension artifact index trusted Ed25519 public key",
        public_key_hex,
    )?;
    let signature =
        decode_hex_fixed::<64>("extension artifact index Ed25519 signature", signature_hex)?;
    let public_key = VerifyingKey::from_bytes(&public_key).map_err(|err| {
        Error::InvalidConfig(format!(
            "extension artifact index signature {} has invalid Ed25519 public key: {err}",
            signature_path.display()
        ))
    })?;
    let signature = Signature::from_bytes(&signature);
    public_key.verify(index_bytes, &signature).map_err(|err| {
        Error::InvalidConfig(format!(
            "extension artifact index signature {} failed verification: {err}",
            signature_path.display()
        ))
    })
}

#[cfg(not(feature = "extension-signing"))]
fn verify_extension_artifact_index_signature_bytes(
    _public_key_hex: &str,
    _signature_hex: &str,
    _index_bytes: &[u8],
    _signature_path: &Path,
) -> Result<()> {
    Err(Error::InvalidConfig(
        "verifying signed extension artifact indexes requires an oliphaunt-resources binary built with the extension-signing feature"
            .to_owned(),
    ))
}

fn extension_artifact_index_signature_toml(signature: &SignedExtensionArtifactIndex) -> String {
    format!(
        "schema = {}\nalgorithm = \"ed25519\"\nkey_id = {}\npublic_key = {}\nsignature = {}\n",
        toml_string(EXTENSION_ARTIFACT_INDEX_SIGNATURE_LAYOUT),
        toml_string(&signature.key_id),
        toml_string(&signature.public_key_hex),
        toml_string(&signature.signature_hex),
    )
}

fn normalize_hex(value: &str) -> String {
    value
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .map(|byte| (byte as char).to_ascii_lowercase())
        .collect()
}

fn decode_hex_fixed<const N: usize>(label: &str, value: &str) -> Result<[u8; N]> {
    let value = normalize_hex(value);
    if value.len() != N * 2 {
        return Err(Error::InvalidConfig(format!(
            "{label} must be {} hex characters",
            N * 2
        )));
    }
    let mut out = [0u8; N];
    let bytes = value.as_bytes();
    for index in 0..N {
        let high = hex_nibble(bytes[index * 2])
            .ok_or_else(|| Error::InvalidConfig(format!("{label} contains a non-hex character")))?;
        let low = hex_nibble(bytes[index * 2 + 1])
            .ok_or_else(|| Error::InvalidConfig(format!("{label} contains a non-hex character")))?;
        out[index] = (high << 4) | low;
    }
    Ok(out)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(feature = "extension-signing")]
pub(super) fn hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn visit_extension_artifact_index_entry(
    sql_name: &str,
    target: &str,
    entries: &BTreeMap<(String, String), ExtensionArtifactIndexEntry>,
    artifact_cache_dir: Option<&Path>,
    visiting: &mut BTreeSet<String>,
    visited: &mut BTreeSet<String>,
    artifacts: &mut Vec<NativePrebuiltExtensionArtifact>,
    extension_names: &mut Vec<String>,
) -> Result<()> {
    if Extension::by_release_ready_sql_name(sql_name).is_some() {
        return Ok(());
    }
    if visited.contains(sql_name) {
        return Ok(());
    }
    if !visiting.insert(sql_name.to_owned()) {
        return Err(Error::InvalidConfig(format!(
            "cyclic extension artifact index dependency involving '{sql_name}'"
        )));
    }
    let entry = entries
        .get(&(target.to_owned(), sql_name.to_owned()))
        .ok_or_else(|| missing_extension_artifact_index_entry(sql_name, target, entries))?;
    let artifact_path = verify_extension_artifact_index_entry(entry, artifact_cache_dir)?;
    let prepared =
        PreparedPrebuiltExtensionArtifacts::prepare(&[NativePrebuiltExtensionArtifact::new(
            &artifact_path,
        )])?;
    let loaded = load_prebuilt_extension_artifact(&prepared.artifacts()[0].root)?;
    if loaded.sql_name != entry.sql_name {
        return Err(Error::InvalidConfig(format!(
            "extension artifact index {} maps '{}' to {}, but artifact manifest declares '{}'",
            entry.index_path.display(),
            entry.sql_name,
            entry.path.display(),
            loaded.sql_name
        )));
    }
    for dependency in loaded.dependencies() {
        visit_extension_artifact_index_entry(
            dependency,
            target,
            entries,
            artifact_cache_dir,
            visiting,
            visited,
            artifacts,
            extension_names,
        )?;
    }
    visiting.remove(sql_name);
    visited.insert(sql_name.to_owned());
    artifacts.push(NativePrebuiltExtensionArtifact::new(artifact_path));
    extension_names.push(sql_name.to_owned());
    Ok(())
}

fn missing_extension_artifact_index_entry(
    sql_name: &str,
    target: &str,
    entries: &BTreeMap<(String, String), ExtensionArtifactIndexEntry>,
) -> Error {
    let available_targets = entries
        .keys()
        .filter_map(|(entry_target, entry_sql_name)| {
            (entry_sql_name == sql_name).then_some(entry_target.as_str())
        })
        .collect::<BTreeSet<_>>();
    let target_hint = if available_targets.is_empty() {
        "no targets are available".to_owned()
    } else {
        format!(
            "available target(s): {}",
            available_targets.into_iter().collect::<Vec<_>>().join(",")
        )
    };
    Error::InvalidConfig(format!(
        "extension artifact index has no artifact for extension '{sql_name}' target '{target}' ({target_hint})"
    ))
}

fn verify_extension_artifact_index_entry(
    entry: &ExtensionArtifactIndexEntry,
    artifact_cache_dir: Option<&Path>,
) -> Result<PathBuf> {
    if entry.path.is_file() {
        verify_extension_artifact_index_file(entry, &entry.path)?;
        return Ok(entry.path.clone());
    }

    let Some(url) = &entry.url else {
        return Err(Error::InvalidConfig(format!(
            "stat extension artifact {} from index {}: file is missing and the index row has no url",
            entry.path.display(),
            entry.index_path.display()
        )));
    };
    let Some(cache_dir) = artifact_cache_dir else {
        return Err(Error::InvalidConfig(format!(
            "extension artifact {} from index {} is URL-backed; pass --extension-cache <dir> so '{}' can be downloaded and verified",
            entry.sql_name,
            entry.index_path.display(),
            url
        )));
    };
    let cache_path = extension_artifact_cache_path(cache_dir, entry)?;
    if cache_path.is_file() {
        verify_extension_artifact_index_file(entry, &cache_path)?;
        return Ok(cache_path);
    }
    download_extension_artifact_to_cache(entry, url, &cache_path)?;
    verify_extension_artifact_index_file(entry, &cache_path)?;
    Ok(cache_path)
}

fn verify_extension_artifact_index_file(
    entry: &ExtensionArtifactIndexEntry,
    path: &Path,
) -> Result<()> {
    let metadata = fs::metadata(path).map_err(|err| {
        Error::InvalidConfig(format!(
            "stat extension artifact {} from index {}: {err}",
            path.display(),
            entry.index_path.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(Error::InvalidConfig(format!(
            "extension artifact {} from index {} must be a file",
            path.display(),
            entry.index_path.display()
        )));
    }
    if metadata.len() != entry.bytes {
        return Err(Error::InvalidConfig(format!(
            "extension artifact {} from index {} has {} bytes, expected {}",
            path.display(),
            entry.index_path.display(),
            metadata.len(),
            entry.bytes
        )));
    }
    let sha256 = sha256_file_hex(path)?;
    if sha256 != entry.sha256 {
        return Err(Error::InvalidConfig(format!(
            "extension artifact {} from index {} has sha256 {}, expected {}",
            path.display(),
            entry.index_path.display(),
            sha256,
            entry.sha256
        )));
    }
    Ok(())
}

fn extension_artifact_cache_path(
    cache_dir: &Path,
    entry: &ExtensionArtifactIndexEntry,
) -> Result<PathBuf> {
    validate_relative_artifact_path(cache_dir, "cached artifact path", &entry.relative_path)?;
    Ok(cache_dir.join(&entry.target).join(&entry.relative_path))
}

fn download_extension_artifact_to_cache(
    entry: &ExtensionArtifactIndexEntry,
    url: &str,
    cache_path: &Path,
) -> Result<()> {
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| Error::Engine(format!("create {}: {err}", parent.display())))?;
    }
    let tmp_path = cache_path.with_file_name(format!(
        ".{}.{}.tmp",
        cache_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("artifact"),
        unique_timestamp_suffix()
    ));
    let download_result = download_extension_artifact_url(url, &tmp_path);
    if let Err(error) = download_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    verify_extension_artifact_index_file(entry, &tmp_path)?;
    fs::rename(&tmp_path, cache_path).map_err(|err| {
        Error::Engine(format!(
            "publish downloaded extension artifact {} to cache {}: {err}",
            url,
            cache_path.display()
        ))
    })?;
    Ok(())
}

fn download_extension_artifact_url(url: &str, output: &Path) -> Result<()> {
    if let Some(path) = url.strip_prefix("file://") {
        let source = PathBuf::from(path);
        fs::copy(&source, output).map_err(|err| {
            Error::InvalidConfig(format!(
                "copy extension artifact URL {} to {}: {err}",
                url,
                output.display()
            ))
        })?;
        return Ok(());
    }
    download_extension_artifact_https_url(url, output)
}

#[cfg(feature = "extension-download")]
fn download_extension_artifact_https_url(url: &str, output: &Path) -> Result<()> {
    let response = ureq::get(url).call().map_err(|err| {
        Error::InvalidConfig(format!("download extension artifact URL {url}: {err}"))
    })?;
    let mut reader = response.into_reader();
    let mut file = File::create(output)
        .map_err(|err| Error::Engine(format!("create {}: {err}", output.display())))?;
    io::copy(&mut reader, &mut file).map_err(|err| {
        Error::Engine(format!(
            "write downloaded extension artifact URL {} to {}: {err}",
            url,
            output.display()
        ))
    })?;
    Ok(())
}

#[cfg(not(feature = "extension-download"))]
fn download_extension_artifact_https_url(url: &str, _output: &Path) -> Result<()> {
    Err(Error::InvalidConfig(format!(
        "extension artifact URL {url} requires an oliphaunt-resources binary built with the extension-download feature"
    )))
}
