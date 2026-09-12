use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BenchmarkReport {
    pub(super) engine: &'static str,
    pub(super) source_model: &'static str,
    pub(super) measurement_model: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) native_tuning: Option<NativeBenchmarkTuningReport>,
    pub(super) rtt_iterations: usize,
    pub(super) speed_scale: f64,
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
pub(super) struct SpeedHotspotDiagnosticReport {
    pub(super) source_model: &'static str,
    pub(super) measurement_model: &'static str,
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
}
