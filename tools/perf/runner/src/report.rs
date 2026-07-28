use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "legacy-oliphaunt")]
pub(super) struct ColdPerfReport {
    pub(super) wasmer_version: &'static str,
    pub(super) wasmer_wasix_version: &'static str,
    pub(super) wasix_runtime_assets: WasixRuntimeAssetReport,
    pub(super) cache_reset_requested: bool,
    pub(super) cache_dir: String,
    pub(super) cache_state_at_start: &'static str,
    pub(super) measurement_model: &'static str,
    pub(super) operations: Vec<PerfOperation>,
    pub(super) experiments: Vec<ColdPerfExperiment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "legacy-oliphaunt")]
pub(super) struct PerfOperation {
    pub(super) name: &'static str,
    pub(super) description: &'static str,
    pub(super) cache_state_before: String,
    pub(super) process_state_before: &'static str,
    pub(super) root_state: &'static str,
    pub(super) query_state: &'static str,
    pub(super) workload: &'static str,
    pub(super) primary_latency_phase: &'static str,
    pub(super) primary_latency_micros: u128,
    pub(super) elapsed_micros: u128,
    pub(super) correct: bool,
    pub(super) phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "legacy-oliphaunt")]
pub(super) struct WarmPerfReport {
    pub(super) wasmer_version: &'static str,
    pub(super) wasmer_wasix_version: &'static str,
    pub(super) wasix_runtime_assets: WasixRuntimeAssetReport,
    pub(super) query_iterations: usize,
    pub(super) connection_iterations: usize,
    pub(super) measurement_model: &'static str,
    pub(super) operations: Vec<PerfOperation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BenchmarkReport {
    pub(super) wasmer_version: &'static str,
    pub(super) wasmer_wasix_version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) wasix_runtime_assets: Option<WasixRuntimeAssetReport>,
    pub(super) source_model: &'static str,
    pub(super) measurement_model: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) native_tuning: Option<NativeBenchmarkTuningReport>,
    pub(super) rtt_iterations: usize,
    pub(super) speed_scale: f64,
    pub(super) preload_micros: u128,
    pub(super) runs: Vec<BenchmarkRun>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BenchmarkRun {
    pub(super) suite: &'static str,
    pub(super) mode: &'static str,
    pub(super) description: &'static str,
    pub(super) open_micros: u128,
    pub(super) connect_micros: Option<u128>,
    pub(super) setup_micros: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) observed_server_peak_rss_bytes: Option<u64>,
    pub(super) tests: Vec<BenchmarkTestResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BenchmarkTestResult {
    pub(super) id: &'static str,
    pub(super) label: String,
    pub(super) unit: &'static str,
    pub(super) operation_count: usize,
    pub(super) sample_count: usize,
    pub(super) trimmed_sample_count: usize,
    pub(super) elapsed_micros: u128,
    pub(super) average_micros: Option<f64>,
    pub(super) min_micros: Option<u128>,
    pub(super) p50_micros: Option<u128>,
    pub(super) p90_micros: Option<u128>,
    pub(super) p95_micros: Option<u128>,
    pub(super) p99_micros: Option<u128>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreparedUpdateReport {
    pub(super) source_model: &'static str,
    pub(super) measurement_model: &'static str,
    pub(super) gate_model: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) wasix_runtime_assets: Option<WasixRuntimeAssetReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) native_tuning: Option<NativeBenchmarkTuningReport>,
    pub(super) rows: usize,
    pub(super) runs: Vec<PreparedUpdateRun>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreparedUpdateRun {
    pub(super) mode: String,
    pub(super) description: String,
    pub(super) protocol_stats: Option<ProtocolStatsSnapshot>,
    pub(super) tests: Vec<PreparedUpdateTest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreparedUpdateTest {
    pub(super) id: &'static str,
    pub(super) label: &'static str,
    pub(super) open_micros: u128,
    pub(super) connect_micros: u128,
    pub(super) setup_micros: u128,
    pub(super) prepare_micros: Option<u128>,
    pub(super) elapsed_micros: u128,
    pub(super) operation_count: usize,
    pub(super) average_micros: f64,
}

#[derive(Debug, Clone)]
pub(super) struct NativeBenchmarkTuning {
    pub(super) durability: NativeDurabilityProfile,
    pub(super) runtime_footprint: RuntimeFootprintProfile,
    pub(super) startup_gucs: Vec<PostgresStartupGuc>,
}

impl Default for NativeBenchmarkTuning {
    fn default() -> Self {
        Self {
            durability: NativeDurabilityProfile::Safe,
            runtime_footprint: RuntimeFootprintProfile::Throughput,
            startup_gucs: Vec::new(),
        }
    }
}

impl NativeBenchmarkTuning {
    fn postgres_startup_assignments(&self) -> Vec<String> {
        let mut assignments = Vec::new();
        for (name, value) in self.runtime_footprint.postgres_gucs() {
            assignments.push(format!("{name}={value}"));
        }
        for (name, value) in self.durability.postgres_gucs() {
            assignments.push(format!("{name}={value}"));
        }
        for guc in &self.startup_gucs {
            assignments.push(format!("{}={}", guc.name.trim(), guc.value));
        }
        assignments
    }

    pub(super) fn native_postgres_control_assignments(&self) -> Vec<String> {
        let mut assignments = Vec::new();
        for (name, value) in self.runtime_footprint.postgres_gucs() {
            assignments.push(format!("{name}={value}"));
        }
        for (name, value) in self.durability.postgres_gucs() {
            assignments.push(format!("{name}={value}"));
        }
        assignments.extend(
            [
                "max_worker_processes=0",
                "max_parallel_workers=0",
                "max_parallel_workers_per_gather=0",
                "autovacuum=off",
                "log_checkpoints=off",
            ]
            .into_iter()
            .map(str::to_owned),
        );
        for guc in &self.startup_gucs {
            assignments.push(format!("{}={}", guc.name.trim(), guc.value));
        }
        assignments
    }

    pub(super) fn report(&self) -> NativeBenchmarkTuningReport {
        NativeBenchmarkTuningReport {
            durability: native_durability_arg(self.durability).to_owned(),
            runtime_footprint: self.runtime_footprint.to_string(),
            startup_gucs: self
                .startup_gucs
                .iter()
                .map(|guc| format!("{}={}", guc.name.trim(), guc.value))
                .collect(),
            postgres_startup_assignments: self.postgres_startup_assignments(),
            native_postgres_control_assignments: self.native_postgres_control_assignments(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeBenchmarkTuningReport {
    pub(super) durability: String,
    pub(super) runtime_footprint: String,
    pub(super) startup_gucs: Vec<String>,
    pub(super) postgres_startup_assignments: Vec<String>,
    pub(super) native_postgres_control_assignments: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WasixRuntimeAssetReport {
    pub(super) source_lane: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) source_fingerprint: Option<String>,
    pub(super) postgres_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pgdata_template_source_lane: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pgdata_template_source_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pgdata_template_postgres_version: Option<String>,
}

#[cfg(feature = "legacy-oliphaunt")]
pub(super) fn wasix_runtime_asset_report() -> Result<WasixRuntimeAssetReport> {
    let metadata =
        oliphaunt_wasix::asset_manifest_metadata().context("read bundled WASIX asset manifest")?;
    Ok(WasixRuntimeAssetReport {
        source_lane: metadata
            .source_lane
            .unwrap_or_else(|| "oliphaunt-wasix".to_owned()),
        source_fingerprint: metadata.source_fingerprint,
        postgres_version: metadata.postgres_version,
        pgdata_template_source_lane: metadata.pgdata_template_source_lane,
        pgdata_template_source_fingerprint: metadata.pgdata_template_source_fingerprint,
        pgdata_template_postgres_version: metadata.pgdata_template_postgres_version,
    })
}

#[cfg(not(feature = "legacy-oliphaunt"))]
pub(super) fn wasix_runtime_asset_report() -> Result<WasixRuntimeAssetReport> {
    legacy_oliphaunt_unavailable("WASIX runtime asset provenance")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "legacy-oliphaunt")]
pub(super) struct IndexedUpdateDiagnosticReport {
    pub(super) source_model: &'static str,
    pub(super) measurement_model: &'static str,
    pub(super) wasix_runtime_assets: WasixRuntimeAssetReport,
    pub(super) cases: Vec<IndexedUpdateDiagnosticCase>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "legacy-oliphaunt")]
pub(super) struct IndexedUpdateDiagnosticCase {
    pub(super) name: &'static str,
    pub(super) description: &'static str,
    pub(super) setup_micros: u128,
    pub(super) elapsed_micros: u128,
    pub(super) operation_count: usize,
    pub(super) stats_before: serde_json::Value,
    pub(super) stats_after: serde_json::Value,
    pub(super) fs_trace: serde_json::Value,
    pub(super) phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
pub(super) struct SpeedHotspotDiagnosticReport {
    pub(super) source_model: &'static str,
    pub(super) measurement_model: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) wasix_runtime_assets: Option<WasixRuntimeAssetReport>,
    pub(super) cases: Vec<SpeedHotspotDiagnosticCase>,
}

#[derive(Debug, Serialize)]
pub(super) struct SpeedHotspotDiagnosticCase {
    pub(super) engine: &'static str,
    pub(super) process_model: &'static str,
    pub(super) id: String,
    pub(super) label: String,
    pub(super) open_micros: Option<u128>,
    pub(super) connect_micros: Option<u128>,
    pub(super) setup_micros: u128,
    pub(super) elapsed_micros: u128,
    pub(super) operation_count: usize,
    pub(super) settings: serde_json::Value,
    pub(super) observed_server_peak_rss_bytes: Option<u64>,
    pub(super) fs_trace: serde_json::Value,
    pub(super) phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "legacy-oliphaunt")]
pub(super) struct BufferCacheDiagnosticReport {
    pub(super) source_model: &'static str,
    pub(super) measurement_model: &'static str,
    pub(super) wasix_runtime_assets: WasixRuntimeAssetReport,
    pub(super) cases: Vec<BufferCacheDiagnosticCase>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "legacy-oliphaunt")]
pub(super) struct BufferCacheDiagnosticCase {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) setup_micros: u128,
    pub(super) settings: serde_json::Value,
    pub(super) relation_sizes: serde_json::Value,
    pub(super) statements: Vec<BufferCacheDiagnosticStatement>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "legacy-oliphaunt")]
pub(super) struct BufferCacheDiagnosticStatement {
    pub(super) sql: String,
    pub(super) elapsed_micros: u128,
    pub(super) explain_rows: serde_json::Value,
    pub(super) fs_trace: serde_json::Value,
    pub(super) wal_state: serde_json::Value,
    pub(super) phases: Vec<PhaseTiming>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "legacy-oliphaunt")]
pub(super) struct ColdPerfExperiment {
    pub(super) name: &'static str,
    pub(super) status: &'static str,
    pub(super) implementation_risk: &'static str,
    pub(super) artifact_size_impact: &'static str,
    pub(super) notes: &'static str,
}
