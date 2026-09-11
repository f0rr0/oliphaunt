#![deny(unsafe_code)]
#![no_std]
//! Resource identities and immutable bytes, without runtime or filesystem dependencies.

/// A package-owned resource: relative path, bytes, SHA-256, and executable bit.
/// A trailing slash declares a directory, with empty bytes and executable=false.
pub type EmbeddedResource = (&'static str, &'static [u8], &'static str, bool);

/// A versioned native extension and its package-owned resources.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtensionDescriptor {
    /// PostgreSQL extension name.
    pub sql_name: &'static str,
    /// Independently released artifact product.
    pub product: &'static str,
    /// Extension package release version; contrib follows the SDK runtime.
    pub version: Option<&'static str>,
    /// Native runtime release expected by the artifact.
    pub runtime_version: &'static str,
    /// Verified release resources embedded by the extension package.
    pub resources: &'static [EmbeddedResource],
}

/// Explicitly selected ICU data from the optional ICU crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IcuData {
    /// Native runtime release expected by this carrier.
    pub native_runtime_version: &'static str,
    /// ICU carrier package version.
    pub version: &'static str,
    /// WASIX runtime release expected by this carrier.
    pub runtime_version: &'static str,
    /// Package-owned ICU files and receipt.
    pub resources: &'static [EmbeddedResource],
    /// Portable WASIX ICU archive.
    pub wasix_archive: Option<&'static [u8]>,
    /// SHA-256 of the portable archive.
    pub wasix_archive_sha256: Option<&'static str>,
    /// SHA-256 of the installed logical ICU data tree.
    pub wasix_data_tree_sha256: Option<&'static str>,
    /// Matching ICU catalog seed, owned by this optional package.
    pub wasix_seed_archive: Option<&'static [u8]>,
    /// Matching ICU catalog seed manifest.
    pub wasix_seed_manifest: Option<&'static [u8]>,
}

/// Immutable resources owned by an independently released WASIX package.
///
/// Applications use the descriptor exported by their extension crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WasixPackage {
    product: &'static str,
    version: &'static str,
    runtime_version: &'static str,
    archives: &'static [(&'static str, &'static [u8], &'static str)],
    aot_manifest: &'static str,
    aot_artifacts: &'static [(&'static str, &'static [u8])],
}

impl WasixPackage {
    /// Package-owned product.
    pub const fn product(self) -> &'static str {
        self.product
    }
    /// Package-owned version.
    pub const fn version(self) -> &'static str {
        self.version
    }
    /// Package-owned runtime version.
    pub const fn runtime_version(self) -> &'static str {
        self.runtime_version
    }
    /// Package-owned archives.
    pub const fn archives(self) -> &'static [(&'static str, &'static [u8], &'static str)] {
        self.archives
    }
    /// Package-owned aot manifest.
    pub const fn aot_manifest(self) -> &'static str {
        self.aot_manifest
    }
    /// Package-owned aot artifacts.
    pub const fn aot_artifacts(self) -> &'static [(&'static str, &'static [u8])] {
        self.aot_artifacts
    }

    /// Construct a descriptor in a generated extension package.
    ///
    /// # Safety
    /// Every AOT artifact must have been produced by the trusted Oliphaunt build
    /// for the declared engine and target. The manifest and archive identities
    /// must belong to that same release. A caller-provided hash alone does not
    /// establish this trust: arbitrary serialized native code is not safe input.
    #[doc(hidden)]
    #[allow(unsafe_code)]
    pub const unsafe fn from_trusted_release(
        product: &'static str,
        version: &'static str,
        runtime_version: &'static str,
        archives: &'static [(&'static str, &'static [u8], &'static str)],
        aot_manifest: &'static str,
        aot_artifacts: &'static [(&'static str, &'static [u8])],
    ) -> Self {
        Self {
            product,
            version,
            runtime_version,
            archives,
            aot_manifest,
            aot_artifacts,
        }
    }
}

/// A selected WASIX extension; package resources are omitted for bundled contrib.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WasixExtensionDescriptor {
    /// PostgreSQL extension name.
    pub sql_name: &'static str,
    /// Resources from the independently versioned extension crate.
    pub package: Option<&'static WasixPackage>,
}
