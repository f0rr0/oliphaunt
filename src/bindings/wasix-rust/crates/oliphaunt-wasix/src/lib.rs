#![doc = include_str!("../README.md")]
#![deny(unsafe_code)]

mod oliphaunt;
mod protocol;

#[cfg(feature = "extensions")]
pub use oliphaunt::extensions;

pub use oliphaunt::{
    DataDirArchiveFormat, DataTransferContainer, DescribeQueryParam, DescribeQueryResult,
    DescribeResultField, EngineCapabilities, ExecProtocolOptions, ExecProtocolResult, FieldInfo,
    GlobalListenerHandle, ListenerHandle, NoticeCallback, Oliphaunt, OliphauntBuilder,
    OliphauntError, OliphauntServer, OliphauntServerBuilder, ParserMap, PostgresConfig,
    QueryOptions, QueryTemplate, Results, RowMode, Serializer, SerializerMap, TemplatedQuery,
    Transaction, TypeParser, format_query, quote_identifier,
};
#[cfg(feature = "tools")]
pub use oliphaunt::{PgDumpOptions, PsqlOptions, preflight_wasix_tools};
pub use protocol::messages::{BackendMessage, DatabaseError, NoticeMessage};

#[doc(hidden)]
pub use oliphaunt::{
    AssetManifestMetadata, DebugLevel, FsTraceSnapshot, InstallOptions, InstallOutcome, MountInfo,
    OliphauntPaths, OliphauntProxy, PgDataTemplate, PgDataTemplateManifest, PhaseTiming,
    ProtocolStatsSnapshot, asset_manifest_metadata, build_pgdata_template, capture_phase_timings,
    disable_protocol_stats, ensure_cluster, fs_trace_snapshot, install_and_init,
    install_and_init_in, install_default, install_extension_archive, install_extension_bytes,
    install_into, install_with_options, measure_phase, preload_runtime_module,
    protocol_stats_snapshot, record_phase_timing, reset_fs_trace, reset_protocol_stats,
};
