/// Benchmark targets used by the native release contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BenchmarkTarget {
    /// Native direct Rust SDK.
    NativeDirect,
    /// Native broker mode.
    NativeBroker,
    /// Native server mode.
    NativeServer,
    /// SQLite comparison target.
    Sqlite,
}

/// Metrics tracked before native defaults are allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BenchmarkMetric {
    /// Warm open time.
    WarmOpen,
    /// Cold open time.
    ColdOpen,
    /// Direct simple-query round trip.
    SimpleQueryRtt,
    /// Typed query overhead.
    TypedQueryOverhead,
    /// Batched write throughput.
    BatchedWrites,
    /// Large result streaming throughput.
    LargeResultStreaming,
    /// Backup and restore latency.
    BackupRestore,
    /// Resident memory footprint.
    MemoryFootprint,
    /// Packaged artifact size.
    ArtifactSize,
    /// Crash recovery latency.
    CrashRecovery,
}

/// Comparison operator for a performance gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PerformanceOperator {
    /// Lower values are better and must be at or below the threshold.
    LessThanOrEqual,
    /// Higher values are better and must be at or above the threshold.
    GreaterThanOrEqual,
}

/// One release/performance gate.
#[derive(Debug, Clone, PartialEq)]
pub struct PerformanceGate {
    /// Metric being gated.
    pub metric: BenchmarkMetric,
    /// Target being measured.
    pub target: BenchmarkTarget,
    /// Operator used against `threshold`.
    pub operator: PerformanceOperator,
    /// Numeric threshold in the metric's documented unit.
    pub threshold: f64,
    /// Unit for the threshold, for example `ms`, `ops/s`, or `bytes`.
    pub unit: &'static str,
}

/// Set of gates required before a runtime becomes a default.
#[derive(Debug, Clone, PartialEq)]
pub struct PerformanceGateSet {
    /// Gates in evaluation order.
    pub gates: Vec<PerformanceGate>,
}

impl PerformanceGateSet {
    /// Baseline native-direct gates. These are intentionally explicit so CI
    /// can later attach real measurements without inventing policy.
    pub fn native_direct_release_baseline() -> Self {
        Self {
            gates: vec![
                PerformanceGate {
                    metric: BenchmarkMetric::WarmOpen,
                    target: BenchmarkTarget::NativeDirect,
                    operator: PerformanceOperator::LessThanOrEqual,
                    threshold: 75.0,
                    unit: "ms",
                },
                PerformanceGate {
                    metric: BenchmarkMetric::SimpleQueryRtt,
                    target: BenchmarkTarget::NativeDirect,
                    operator: PerformanceOperator::LessThanOrEqual,
                    threshold: 3.0,
                    unit: "ms",
                },
                PerformanceGate {
                    metric: BenchmarkMetric::LargeResultStreaming,
                    target: BenchmarkTarget::NativeDirect,
                    operator: PerformanceOperator::GreaterThanOrEqual,
                    threshold: 1.0,
                    unit: "baseline",
                },
            ],
        }
    }
}
