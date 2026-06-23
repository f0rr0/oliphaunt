pub(crate) mod aot;
pub(crate) mod assets;
pub(crate) mod backend;
pub(crate) mod base;
pub(crate) mod builder;
pub(crate) mod client;
pub(crate) mod config;
pub(crate) mod data_dir;
pub(crate) mod engine;
pub(crate) mod errors;
#[cfg(feature = "extensions")]
pub mod extensions;
pub(crate) mod interface;
pub(crate) mod parse;
#[cfg(feature = "extensions")]
pub mod pg_dump;
pub(crate) mod postgres_mod;
pub(crate) mod proxy;
pub(crate) mod server;
pub(crate) mod sync_host_fs;
pub(crate) mod templating;
pub(crate) mod timing;
pub(crate) mod transport;
pub(crate) mod types;
pub(crate) mod wire;

#[doc(hidden)]
pub use assets::{AssetManifestMetadata, asset_manifest_metadata};
pub use base::{
    InstallOptions, InstallOutcome, MountInfo, OliphauntPaths, PgDataTemplate,
    PgDataTemplateManifest, build_pgdata_template, ensure_cluster, install_and_init,
    install_and_init_in, install_default, install_extension_archive, install_extension_bytes,
    install_into, install_with_options, preload_runtime_module,
};
pub use builder::OliphauntBuilder;
pub use client::{GlobalListenerHandle, ListenerHandle, Oliphaunt, Transaction};
pub use config::PostgresConfig;
pub use data_dir::DataDirArchiveFormat;
pub use engine::EngineCapabilities;
pub use errors::OliphauntError;
pub use interface::{
    DataTransferContainer, DebugLevel, DescribeQueryParam, DescribeQueryResult,
    DescribeResultField, ExecProtocolOptions, ExecProtocolResult, FieldInfo, NoticeCallback,
    ParserMap, QueryOptions, Results, RowMode, Serializer, SerializerMap, TypeParser,
};
#[cfg(feature = "extensions")]
pub use pg_dump::PgDumpOptions;
#[doc(hidden)]
pub use postgres_mod::{FsTraceSnapshot, fs_trace_snapshot, reset_fs_trace};
pub use proxy::{
    OliphauntProxy, ProtocolStatsSnapshot, disable_protocol_stats, protocol_stats_snapshot,
    reset_protocol_stats,
};
pub use server::{OliphauntServer, OliphauntServerBuilder};
pub use templating::{QueryTemplate, TemplatedQuery, format_query, quote_identifier};
pub use timing::{PhaseTiming, capture_phase_timings, measure_phase, record_phase_timing};
