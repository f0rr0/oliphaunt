#![doc = include_str!("../README.md")]
#![deny(unsafe_code)]

mod oliphaunt;
mod protocol;

#[cfg(feature = "extensions")]
pub use oliphaunt::extensions;

pub use oliphaunt::{
    DataTransferContainer, DatabaseInitialization, DatabaseStorage, DebugLevel, DescribeQueryParam,
    DescribeQueryResult, DescribeResultField, EngineCapabilities, ExecProtocolOptions,
    ExecProtocolResult, FieldInfo, GlobalListenerHandle, ListenerHandle, NoticeCallback, Oliphaunt,
    OliphauntBuilder, OliphauntError, OliphauntServer, OliphauntServerBuilder, ParserMap,
    PostgresConfig, QueryOptions, QueryTemplate, Results, RowMode, Serializer, SerializerMap,
    TemplatedQuery, Transaction, TypeParser, format_query, quote_identifier,
};
#[cfg(feature = "tools")]
pub use oliphaunt::{PgDumpOptions, PsqlOptions, preflight_wasix_tools};
pub use protocol::messages::{BackendMessage, NoticeMessage, PostgresError};

// Maintainer-facing profiling hooks used by the repository performance runner.
// They stay hidden because they are instrumentation, not the consumer database API.
#[doc(hidden)]
pub use oliphaunt::{
    AssetManifestMetadata, FsTraceSnapshot, PhaseTiming, ProtocolStatsSnapshot,
    asset_manifest_metadata, capture_phase_timings, disable_protocol_stats, fs_trace_snapshot,
    measure_phase, protocol_stats_snapshot, record_phase_timing, reset_fs_trace,
    reset_protocol_stats,
};
