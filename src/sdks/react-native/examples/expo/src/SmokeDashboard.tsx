import {
  Oliphaunt,
  runOliphauntReactNativeBenchmark,
  type EngineCapabilities,
  type EngineModeSupport,
  type PackageSizeReport,
  type OliphauntDatabase,
  type ReactNativeBenchmarkOptions,
  type ReactNativeBenchmarkReport,
  type ReactNativeBenchmarkWorkload,
} from '@oliphaunt/react-native';
import {
  runPostgresGamutWorkload,
  runPostgresLifecycleResumeCheck,
  type ActivityItem,
  type OperationCheck,
  type PerfReport,
  type ProjectRollup,
} from './postgres-workload';
import {
  runExpoSQLiteBenchmark,
  type ExpoSQLiteBenchmarkReport,
} from './sqlite-benchmark';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type RunState = 'idle' | 'running' | 'passed' | 'failed';
type RunnerMode = 'smoke' | 'benchmark' | 'crash-write' | 'crash-verify';
type BenchmarkPreset = 'full' | 'quick';

type SmokeReport = {
  engine: string;
  rawProtocolTransport: string;
  selectOne: string;
  parameterRoundTrip: string;
  jsTimerTicks: number;
  elapsedMs: number;
};

type AppReport = {
  smoke?: SmokeReport;
  perf?: PerfReport;
  benchmark?: ReactNativeBenchmarkReport;
  sqliteBenchmark?: ExpoSQLiteBenchmarkReport;
  crashRecovery?: {
    phase: 'write' | 'verify';
    root: string;
    value: string;
    openMs: number;
    elapsedMs: number;
  };
  modes?: EngineModeSupport[];
  capabilities?: EngineCapabilities;
  packageSize?: PackageSizeReport | null;
  projects?: ProjectRollup[];
  activity?: ActivityItem[];
  checks?: OperationCheck[];
  lifecycle?: OperationCheck;
};

type SmokeGlobalState = {
  databasePromise?: Promise<OliphauntDatabase>;
  databaseInstance?: OliphauntDatabase;
  runPromise?: Promise<void>;
};

type OpenTuning = {
  durability: 'safe' | 'balanced' | 'fastDev';
  runtimeFootprint: 'throughput' | 'balancedMobile' | 'smallMobile';
  startupGUCs?: string[];
  walSegmentSizeMB: string;
  root?: string;
};

type BenchmarkTuning = Pick<
  ReactNativeBenchmarkOptions,
  | 'warmupIterations'
  | 'rawRttIterations'
  | 'typedRttIterations'
  | 'parameterizedRttIterations'
  | 'insertRows'
  | 'lookupIterations'
  | 'aggregateIterations'
  | 'updateIterations'
  | 'checkpointIterations'
  | 'largeResultRows'
>;

const smokeGlobalKey = '__OLIPHAUNT_EXPO_SMOKE_STATE__';
const initialUrlTimeoutMs = 2_500;
let initialLaunchUrlPromise: Promise<string | null> | undefined;

function smokeGlobalState(): SmokeGlobalState {
  const root = globalThis as unknown as Record<string, SmokeGlobalState | undefined>;
  root[smokeGlobalKey] ??= {};
  return root[smokeGlobalKey];
}

export default function HomeScreen() {
  const [state, setState] = useState<RunState>('idle');
  const [report, setReport] = useState<AppReport>({});
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    const smokeState = smokeGlobalState();
    if (smokeState.runPromise) {
      await smokeState.runPromise;
      return;
    }
    const runPromise = (async () => {
      setState('running');
      setError(null);
      const started = now();
      const liveness = startTimerLivenessProbe();
      const stage = (name: string, extra?: Record<string, unknown>) =>
        logSmokeStage(started, name, extra);
      let runner: RunnerMode = 'smoke';

      try {
        runner = await resolveRunnerMode();
        if (runner === 'benchmark') {
          await runBenchmark(started, liveness, stage, setReport, setState);
          return;
        }
        if (runner === 'crash-write' || runner === 'crash-verify') {
          await runCrashRecoveryPhase(runner, started, liveness, stage, setReport, setState);
          return;
        }

        stage('metadata:start');
        const [modes, packageSize] = await Promise.all([
          Oliphaunt.supportedModes(),
          Oliphaunt.packageSizeReport().catch(() => null),
        ]);
        stage('metadata:done', {
          modes: modes.length,
          packageBytes: packageSize?.packageBytes ?? null,
        });
        const extensions = extensionsForPackage(packageSize);
        stage('extensions:selected', {
          extensions,
          mobileStaticRegistryState: packageSize?.mobileStaticRegistryState ?? null,
          mobileStaticRegistryRegistered: packageSize?.mobileStaticRegistryRegistered ?? [],
        });
        const databaseOpen = await openDatabase(stage, extensions);
        stage('open:done', { openMs: databaseOpen.openMs });
        const db = databaseOpen.database;
        stage('capabilities:start');
        const capabilities = await db.capabilities();
        assertNativeDirectCapabilities(capabilities);
        stage('capabilities:done', { engine: capabilities.engine });

        stage('query:select1:start');
        const select = await db.query('SELECT 1::text AS value');
        const selectOne = select.getText(0, 'value') ?? '';
        stage('query:select1:done', { value: selectOne });
        stage('query:parameter:start');
        const parameterized = await db.query('SELECT $1::text AS value', ['hello']);
        const parameterRoundTrip = parameterized.getText(0, 'value') ?? '';
        stage('query:parameter:done', { value: parameterRoundTrip });
        stage('workload:start');
        const workload = await runPostgresGamutWorkload(db, databaseOpen.openMs, {
          extensions,
          onCheckStage: check =>
            stage(`workload:${check.status}`, {
              name: check.name,
              checkElapsedMs: check.elapsedMs === undefined ? undefined : Math.round(check.elapsedMs),
            }),
        });
        stage('workload:done', {
          checks: workload.checks.length,
          rows: workload.perf.rows,
        });
        const lifecycle = await runLifecycleResumeValidation(db, stage);
        liveness.stop();
        const checks = lifecycle ? [...workload.checks, lifecycle] : workload.checks;
        const perf = lifecycle
          ? { ...workload.perf, checks: String(checks.length) }
          : workload.perf;

        const smoke = {
          engine: capabilities.engine,
          rawProtocolTransport: capabilities.rawProtocolTransport,
          selectOne,
          parameterRoundTrip,
          jsTimerTicks: liveness.ticks(),
          elapsedMs: now() - started,
        };
        const nextReport = {
          smoke,
          perf,
          modes,
          capabilities,
          packageSize,
          projects: workload.projects,
          activity: workload.activity,
          checks,
          lifecycle,
        };
        setReport(nextReport);
        setState('passed');
        console.log(
          'OLIPHAUNT_EXPO_SMOKE_PASS',
          JSON.stringify({
            elapsedMs: Math.round(now() - started),
            smoke,
            perf,
            lifecycle,
            packageBytes: packageSize?.packageBytes ?? null,
            projectCount: workload.projects.length,
            activityCount: workload.activity.length,
            checkCount: checks.length,
          }),
        );
        (globalThis as Record<string, unknown>).__OLIPHAUNT_EXPO_SMOKE_REPORT__ = nextReport;
      } catch (err) {
        liveness.stop();
        const message = err instanceof Error ? err.message : String(err);
        stage('failed', { error: message });
        setError(message);
        setState('failed');
        console.error(
          failureTagForRunner(runner),
          JSON.stringify({
            elapsedMs: Math.round(now() - started),
            error: message,
          }),
        );
      }
    })();
    smokeState.runPromise = runPromise;
    try {
      await runPromise;
    } finally {
      if (smokeState.runPromise === runPromise) {
        smokeState.runPromise = undefined;
      }
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => void run(), 0);
    return () => clearTimeout(timeout);
  }, [run]);

  const statusTone = useMemo(() => {
    switch (state) {
      case 'passed':
        return styles.statusPassed;
      case 'failed':
        return styles.statusFailed;
      case 'running':
        return styles.statusRunning;
      default:
        return styles.statusIdle;
    }
  }, [state]);

  return (
    <View style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>liboliphaunt React Native</Text>
              <Text style={styles.title}>Field ops task board</Text>
            </View>
            <View
              accessibilityLabel={`liboliphaunt-smoke-status-${state}`}
              collapsable={false}
              testID={`liboliphaunt-smoke-status-${state}`}
              style={[styles.statusPill, statusTone]}
            >
              {state === 'running' ? <ActivityIndicator size="small" color="#102033" /> : null}
              <Text style={styles.statusText}>{state}</Text>
            </View>
          </View>

          <View style={styles.metricsGrid}>
            <Metric label="platform" value={Platform.OS} />
            <Metric
              label="engine"
              value={report.smoke?.engine ?? firstAvailableMode(report.modes) ?? 'pending'}
            />
            <Metric label="transport" value={report.smoke?.rawProtocolTransport ?? 'pending'} />
            <Metric label="rows" value={report.perf?.rows ?? 'pending'} />
            <Metric
              label={report.benchmark ? 'typed p90' : 'SELECT p90'}
              value={
                report.benchmark
                  ? formatLatency(benchmarkWorkload(report.benchmark, 'typed_select_rtt'))
                  : report.perf
                    ? `${report.perf.selectP90Ms.toFixed(2)} ms`
                    : 'pending'
              }
            />
            <Metric
              label="SQLite p90"
              value={
                report.sqliteBenchmark
                  ? formatLatency(benchmarkWorkload(report.sqliteBenchmark, 'sqlite_parameterized_select_rtt'))
                  : 'pending'
              }
            />
            <Metric label="package" value={formatBytes(report.packageSize?.packageBytes)} />
            <Metric label="checks" value={report.perf?.checks ?? 'pending'} />
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Validation</Text>
            {error ? (
              <Text testID="liboliphaunt-smoke-error" style={styles.errorText}>
                {error}
              </Text>
            ) : (
              <Text
                accessibilityLabel="liboliphaunt-smoke-result"
                testID="liboliphaunt-smoke-result"
                style={styles.resultText}
              >
                {formatResult(report)}
              </Text>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Project Rollup</Text>
            {(report.projects ?? []).map((project) => (
              <View key={project.name} style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>{project.name}</Text>
                  <Text style={styles.rowMeta}>
                    {project.done}/{project.total} done, {project.blocked} blocked
                  </Text>
                </View>
                <Text style={styles.rowValue}>{project.estimate} pts</Text>
              </View>
            ))}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Current Queue</Text>
            {(report.activity ?? []).map((item) => (
              <View key={`${item.title}-${item.owner}`} style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>{item.title}</Text>
                  <Text style={styles.rowMeta}>{item.owner}</Text>
                </View>
                <Text style={styles.statusBadge}>{item.status}</Text>
              </View>
            ))}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Postgres Coverage</Text>
            {(report.checks ?? []).map((check) => (
              <View key={check.name} style={styles.checkRow}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>{check.name}</Text>
                  <Text style={styles.rowMeta}>{check.detail}</Text>
                </View>
                <Text style={styles.rowValue}>{check.elapsedMs.toFixed(1)} ms</Text>
              </View>
            ))}
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={state === 'running'}
            onPress={() => void run()}
            style={({ pressed }) => [
              styles.button,
              pressed && state !== 'running' ? styles.buttonPressed : null,
              state === 'running' ? styles.buttonDisabled : null,
            ]}
          >
            <Text style={styles.buttonText}>
              {state === 'running' ? 'Running workload' : 'Run workload'}
            </Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

async function resolveRunnerMode(): Promise<RunnerMode> {
  const envRunner = process.env.EXPO_PUBLIC_OLIPHAUNT_RUNNER;
  if (
    envRunner === 'benchmark' ||
    envRunner === 'crash-write' ||
    envRunner === 'crash-verify'
  ) {
    return envRunner;
  }
  const url = await resolveInitialLaunchUrl();
  if (!url) {
    return 'smoke';
  }
  const urlRunner = extractQueryParam(url, 'liboliphauntRunner');
  if (
    urlRunner === 'benchmark' ||
    urlRunner === 'crash-write' ||
    urlRunner === 'crash-verify'
  ) {
    return urlRunner;
  }
  if (url.includes('liboliphauntRunner=benchmark') || url.includes('benchmark=1')) {
    return 'benchmark';
  }
  return 'smoke';
}

function failureTagForRunner(runner: RunnerMode): string {
  switch (runner) {
    case 'benchmark':
      return 'OLIPHAUNT_EXPO_BENCH_FAIL';
    case 'crash-write':
    case 'crash-verify':
      return 'OLIPHAUNT_EXPO_CRASH_RECOVERY_FAIL';
    case 'smoke':
      return 'OLIPHAUNT_EXPO_SMOKE_FAIL';
  }
}

async function shouldRunLifecycleSmoke(): Promise<boolean> {
  if (process.env.EXPO_PUBLIC_OLIPHAUNT_LIFECYCLE_SMOKE === '1') {
    return true;
  }
  const url = await resolveInitialLaunchUrl();
  return Boolean(url?.includes('liboliphauntLifecycle=1') || url?.includes('lifecycle=1'));
}

async function runLifecycleResumeValidation(
  db: OliphauntDatabase,
  stage: (name: string, extra?: Record<string, unknown>) => void,
): Promise<OperationCheck | undefined> {
  if (!(await shouldRunLifecycleSmoke())) {
    return undefined;
  }
  const transition = await waitForBackgroundAndForeground(stage);
  stage('lifecycle:sql:start', { states: transition.states.join('>') });
  const check = await runPostgresLifecycleResumeCheck(db);
  const detail = `${check.detail}; app states ${transition.states.join(' -> ')}`;
  stage('lifecycle:sql:done', { elapsedMs: check.elapsedMs, detail });
  return { ...check, detail };
}

function waitForBackgroundAndForeground(
  stage: (name: string, extra?: Record<string, unknown>) => void,
): Promise<{ states: AppStateStatus[] }> {
  const states: AppStateStatus[] = [AppState.currentState];
  let sawBackground = false;
  stage('lifecycle:ready', { state: AppState.currentState });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.remove();
      reject(
        new Error(
          `timed out waiting for background/foreground lifecycle transition; states=${states.join('>')}`,
        ),
      );
    }, 90_000);

    const finish = () => {
      clearTimeout(timeout);
      subscription.remove();
      resolve({ states });
    };

    const subscription = AppState.addEventListener('change', (nextState) => {
      states.push(nextState);
      stage('lifecycle:state', { state: nextState });
      if (nextState === 'background' || nextState === 'inactive') {
        sawBackground = true;
        return;
      }
      if (sawBackground && nextState === 'active') {
        finish();
      }
    });
  });
}

async function runBenchmark(
  started: number,
  liveness: { ticks: () => number; stop: () => void },
  stage: (name: string, extra?: Record<string, unknown>) => void,
  setReport: (report: AppReport) => void,
  setState: (state: RunState) => void,
) {
  stage('benchmark:start');
  const openConfig = await resolveOpenTuning();
  const benchmarkPreset = await resolveBenchmarkPreset();
  const benchmarkOptions = benchmarkOptionsForPreset(benchmarkPreset);
  const metadata = {
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    runner: 'expo-dev-client',
    benchmarkPreset,
    durability: openConfig.durability,
    runtimeFootprint: openConfig.runtimeFootprint,
    startupGUCs: openConfig.startupGUCs?.join(',') ?? '',
    walSegmentSizeMB: openConfig.walSegmentSizeMB,
  };
  stage('benchmark:liboliphaunt:start');
  const report = await runOliphauntReactNativeBenchmark(Oliphaunt, {
    open: openConfig as ReactNativeBenchmarkOptions['open'],
    requirePackageSizeReport: true,
    ...benchmarkOptions,
    metadata,
  });
  stage('benchmark:sqlite:start');
  const sqliteBenchmark = await runExpoSQLiteBenchmark({
    durability: openConfig.durability,
    warmupIterations: benchmarkOptions.warmupIterations,
    simpleRttIterations: benchmarkOptions.typedRttIterations,
    parameterizedRttIterations: benchmarkOptions.parameterizedRttIterations,
    insertRows: benchmarkOptions.insertRows,
    lookupIterations: benchmarkOptions.lookupIterations,
    aggregateIterations: benchmarkOptions.aggregateIterations,
    updateIterations: benchmarkOptions.updateIterations,
    checkpointIterations: benchmarkOptions.checkpointIterations,
    largeResultRows: benchmarkOptions.largeResultRows,
    metadata,
  });
  liveness.stop();
  const nextReport: AppReport = {
    benchmark: report,
    sqliteBenchmark,
    capabilities: report.capabilities,
    packageSize: report.packageSizeReport,
  };
  setReport(nextReport);
  setState('passed');
  stage('benchmark:done', {
    elapsedMs: Math.round(report.elapsedMs),
    sqliteElapsedMs: Math.round(sqliteBenchmark.elapsedMs),
  });
  console.log(
    'OLIPHAUNT_EXPO_BENCH_PASS',
    JSON.stringify({
      ...report,
      elapsedMs: Math.round(report.elapsedMs),
      sqliteBenchmark,
      appElapsedMs: Math.round(now() - started),
      jsTimerTicks: liveness.ticks(),
      packageBytes: report.packageSizeReport?.packageBytes ?? null,
    }),
  );
  (globalThis as Record<string, unknown>).__OLIPHAUNT_EXPO_BENCH_REPORT__ = nextReport;
}

async function runCrashRecoveryPhase(
  runner: Extract<RunnerMode, 'crash-write' | 'crash-verify'>,
  started: number,
  liveness: { ticks: () => number; stop: () => void },
  stage: (name: string, extra?: Record<string, unknown>) => void,
  setReport: (report: AppReport) => void,
  setState: (state: RunState) => void,
) {
  const openTuning = await resolveOpenTuning();
  if (!openTuning.root) {
    throw new Error('crash recovery runner requires liboliphauntRoot');
  }
  stage('crash:open:start', { phase: runner, root: openTuning.root });
  const databaseOpen = await openDatabase(stage, []);
  const db = databaseOpen.database;
  const capabilities = await db.capabilities();
  assertNativeDirectCapabilities(capabilities);

  if (runner === 'crash-write') {
    const value = `crash-${Platform.OS}-${Math.round(started)}`;
    stage('crash:write:start', { value });
    await db.execute(`
      CREATE TABLE IF NOT EXISTS rn_crash_recovery (
        id integer PRIMARY KEY,
        value text NOT NULL,
        written_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO rn_crash_recovery (id, value)
      VALUES (1, '${sqlLiteral(value)}')
      ON CONFLICT (id)
      DO UPDATE SET value = excluded.value, written_at = CURRENT_TIMESTAMP;
    `);
    const check = await db.query('SELECT value FROM rn_crash_recovery WHERE id = 1');
    const persisted = check.getText(0, 'value') ?? '';
    if (persisted !== value) {
      throw new Error(`crash recovery write readback mismatch: ${persisted}`);
    }
    liveness.stop();
    const payload = {
      phase: 'write' as const,
      root: openTuning.root,
      value,
      openMs: databaseOpen.openMs,
      elapsedMs: now() - started,
    };
    setReport({ crashRecovery: payload, capabilities });
    setState('passed');
    stage('crash:write:ready', { value });
    console.log(
      'OLIPHAUNT_EXPO_CRASH_WRITE_READY',
      JSON.stringify({
        ...payload,
        elapsedMs: Math.round(payload.elapsedMs),
        jsTimerTicks: liveness.ticks(),
      }),
    );
    return;
  }

  stage('crash:verify:start');
  const recovered = await db.query('SELECT value FROM rn_crash_recovery WHERE id = 1');
  const value = recovered.getText(0, 'value') ?? '';
  if (!value.startsWith(`crash-${Platform.OS}-`)) {
    throw new Error(`crash recovery verification found unexpected value '${value}'`);
  }
  await db.execute('INSERT INTO rn_crash_recovery (id, value) VALUES (2, \'verified\') ON CONFLICT (id) DO UPDATE SET value = excluded.value');
  await db.close();
  liveness.stop();
  const payload = {
    phase: 'verify' as const,
    root: openTuning.root,
    value,
    openMs: databaseOpen.openMs,
    elapsedMs: now() - started,
  };
  setReport({ crashRecovery: payload, capabilities });
  setState('passed');
  stage('crash:verify:done', { value });
  console.log(
    'OLIPHAUNT_EXPO_CRASH_RECOVERY_PASS',
    JSON.stringify({
      ...payload,
      elapsedMs: Math.round(payload.elapsedMs),
      jsTimerTicks: liveness.ticks(),
    }),
  );
  (globalThis as Record<string, unknown>).__OLIPHAUNT_EXPO_CRASH_RECOVERY_REPORT__ = payload;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

async function openDatabase(
  stage?: (name: string, extra?: Record<string, unknown>) => void,
  extensions: readonly string[] = [],
): Promise<{ database: OliphauntDatabase; openMs: number }> {
  const smokeState = smokeGlobalState();
  if (smokeState.databaseInstance) {
    stage?.('open:reuse-instance');
    return { database: smokeState.databaseInstance, openMs: 0 };
  }
  if (!smokeState.databasePromise) {
    stage?.('open:start');
    const openTuning = await resolveOpenTuning();
    const started = now();
    const { root, ...tuning } = openTuning;
    const config = {
      engine: 'nativeDirect',
      ...(root ? { root } : { temporary: true }),
      ...tuning,
      extensions,
      username: 'postgres',
      database: 'postgres',
    } as Parameters<typeof Oliphaunt.open>[0] & OpenTuning;
    smokeState.databasePromise = Oliphaunt.open(config).then((database) => {
      smokeState.databaseInstance = database;
      (database as unknown as { __liboliphauntOpenMs?: number }).__liboliphauntOpenMs = now() - started;
      stage?.('open:resolved', {
        openMs: (database as unknown as { __liboliphauntOpenMs?: number }).__liboliphauntOpenMs,
      });
      return database;
    });
  } else {
    stage?.('open:reuse-promise');
  }
  const database = await smokeState.databasePromise;
  return {
    database,
    openMs: (database as unknown as { __liboliphauntOpenMs?: number }).__liboliphauntOpenMs ?? 0,
  };
}

async function resolveOpenTuning(): Promise<OpenTuning> {
  const url = await resolveInitialLaunchUrl();
  const runtimeFootprint = String(
    process.env.EXPO_PUBLIC_OLIPHAUNT_RUNTIME_FOOTPRINT ??
    extractQueryParam(url, 'liboliphauntRuntimeFootprint') ??
    'balancedMobile',
  );
  const durability = String(
    process.env.EXPO_PUBLIC_OLIPHAUNT_DURABILITY ??
    extractQueryParam(url, 'liboliphauntDurability') ??
    'balanced',
  );
  const rawStartupGUCs = String(
    process.env.EXPO_PUBLIC_OLIPHAUNT_STARTUP_GUCS ??
    extractQueryParam(url, 'liboliphauntStartupGUCs') ??
    '',
  );
  const startupGUCs = rawStartupGUCs
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return {
    durability: normalizeDurability(durability),
    runtimeFootprint: normalizeRuntimeFootprint(runtimeFootprint),
    startupGUCs: startupGUCs.length > 0 ? startupGUCs : undefined,
    walSegmentSizeMB: String(
      process.env.EXPO_PUBLIC_OLIPHAUNT_WAL_SEGSIZE_MB ??
      extractQueryParam(url, 'liboliphauntWalSegsizeMB') ??
      '16',
    ),
    root: optionalNonBlankString(
      process.env.EXPO_PUBLIC_OLIPHAUNT_ROOT ??
      extractQueryParam(url, 'liboliphauntRoot'),
      'liboliphauntRoot',
    ),
  };
}

async function resolveBenchmarkPreset(): Promise<BenchmarkPreset> {
  const url = await resolveInitialLaunchUrl();
  const rawPreset = String(
    process.env.EXPO_PUBLIC_OLIPHAUNT_BENCHMARK_PRESET ??
    extractQueryParam(url, 'liboliphauntBenchmarkPreset') ??
    'full',
  );
  return normalizeBenchmarkPreset(rawPreset);
}

function resolveInitialLaunchUrl(): Promise<string | null> {
  initialLaunchUrlPromise ??= Promise.race([
    Linking.getInitialURL().catch(() => null),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), initialUrlTimeoutMs);
    }),
  ]);
  return initialLaunchUrlPromise;
}

function normalizeBenchmarkPreset(value: string): BenchmarkPreset {
  switch (value) {
    case 'full':
      return 'full';
    case 'quick':
      return 'quick';
    default:
      throw new Error(`unknown benchmark preset '${value}'`);
  }
}

function benchmarkOptionsForPreset(preset: BenchmarkPreset): BenchmarkTuning {
  switch (preset) {
    case 'full':
      return {
        warmupIterations: 75,
        rawRttIterations: 750,
        typedRttIterations: 750,
        parameterizedRttIterations: 750,
        insertRows: 1_500,
        lookupIterations: 750,
        aggregateIterations: 300,
        updateIterations: 300,
        checkpointIterations: 20,
        largeResultRows: 750,
      };
    case 'quick':
      return {
        warmupIterations: 10,
        rawRttIterations: 75,
        typedRttIterations: 75,
        parameterizedRttIterations: 75,
        insertRows: 250,
        lookupIterations: 75,
        aggregateIterations: 40,
        updateIterations: 40,
        checkpointIterations: 3,
        largeResultRows: 250,
      };
  }
}

function optionalNonBlankString(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
  return value;
}

function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeDurability(value: string): OpenTuning['durability'] {
  switch (value) {
    case 'safe':
      return 'safe';
    case 'balanced':
      return 'balanced';
    case 'fast-dev':
    case 'fastDev':
      return 'fastDev';
    default:
      throw new Error(`unsupported durability profile: ${value}`);
  }
}

function normalizeRuntimeFootprint(value: string): OpenTuning['runtimeFootprint'] {
  switch (value) {
    case 'throughput':
      return 'throughput';
    case 'balanced-mobile':
    case 'balancedMobile':
      return 'balancedMobile';
    case 'small-mobile':
    case 'smallMobile':
      return 'smallMobile';
    default:
      throw new Error(`unsupported runtime footprint profile: ${value}`);
  }
}

function extractQueryParam(url: string | null, name: string): string | undefined {
  if (!url) {
    return undefined;
  }
  const queryStart = url.indexOf('?');
  if (queryStart < 0) {
    return undefined;
  }
  const queryEnd = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, queryEnd < 0 ? undefined : queryEnd);
  for (const part of query.split('&')) {
    const [rawKey, rawValue = ''] = part.split('=', 2);
    if (decodeURIComponent(rawKey) === name) {
      return decodeURIComponent(rawValue.replace(/\+/g, ' '));
    }
  }
  return undefined;
}

const EXAMPLE_EXTENSIONS = ['vector'] as const;

function extensionsForPackage(packageSize: PackageSizeReport | null): string[] {
  if (!packageSize || packageSize.mobileStaticRegistryState !== 'complete') {
    return [];
  }
  const available = new Set(packageSize.extensions.map((extension) => extension.name));
  const registered = new Set(packageSize.mobileStaticRegistryRegistered);
  return EXAMPLE_EXTENSIONS.filter((extension) => available.has(extension) && registered.has(extension));
}

function assertNativeDirectCapabilities(capabilities: EngineCapabilities) {
  if (capabilities.engine !== 'nativeDirect') {
    throw new Error(`expected nativeDirect, got ${capabilities.engine}`);
  }
  if (capabilities.rawProtocolTransport !== 'jsi-array-buffer') {
    throw new Error(`expected JSI ArrayBuffer transport, got ${capabilities.rawProtocolTransport}`);
  }
  if (!capabilities.protocolRaw || !capabilities.simpleQuery) {
    throw new Error('nativeDirect must expose raw protocol and simple query support');
  }
}

function firstAvailableMode(modes: EngineModeSupport[] | undefined): string | undefined {
  return modes?.find((mode) => mode.available)?.engine;
}

function formatResult(report: AppReport): string {
  if (report.benchmark) {
    return formatBenchmarkResult(report.benchmark, report.sqliteBenchmark);
  }
  if (report.crashRecovery) {
    return [
      `crash phase = ${report.crashRecovery.phase}`,
      `root = ${report.crashRecovery.root}`,
      `value = ${report.crashRecovery.value}`,
      `open = ${report.crashRecovery.openMs.toFixed(2)} ms`,
      `elapsed = ${report.crashRecovery.elapsedMs.toFixed(2)} ms`,
    ].join('\n');
  }
  if (!report.smoke || !report.perf) {
    return 'Waiting for native workload results.';
  }
  return [
    `SELECT 1 = ${report.smoke.selectOne}`,
    `parameter = ${report.smoke.parameterRoundTrip}`,
    `done = ${report.perf.doneRows}`,
    `blocked = ${report.perf.blockedRows}`,
    `checksum = ${report.perf.checksum}`,
    `events = ${report.perf.events}`,
    `checks = ${report.perf.checks}`,
    `backup = ${formatBytes(Number(report.perf.backupBytes))}`,
    `stream = ${formatBytes(Number(report.perf.streamBytes))}`,
    `raw protocol = ${formatBytes(Number(report.perf.rawBytes))}`,
    `constraint SQLSTATE = ${report.perf.constraintSqlstate}`,
    `cancel SQLSTATE = ${report.perf.cancelSqlstate}`,
    `open = ${report.perf.openMs.toFixed(2)} ms`,
    `schema = ${report.perf.schemaMs.toFixed(2)} ms`,
    `seed = ${report.perf.seedMs.toFixed(2)} ms`,
    `update = ${report.perf.updateMs.toFixed(2)} ms`,
    `select p50/p90/p99 = ${report.perf.selectP50Ms.toFixed(2)} / ${report.perf.selectP90Ms.toFixed(2)} / ${report.perf.selectP99Ms.toFixed(2)} ms`,
    `JS timer ticks = ${report.smoke.jsTimerTicks}`,
    `elapsed = ${report.smoke.elapsedMs.toFixed(2)} ms`,
  ].join('\n');
}

function formatBenchmarkResult(
  report: ReactNativeBenchmarkReport,
  sqliteBenchmark?: ExpoSQLiteBenchmarkReport,
): string {
  const lines = [
    `engine = ${report.engine}`,
    `transport = ${report.rawProtocolTransport}`,
    `open = ${report.openMs.toFixed(2)} ms`,
    `raw RTT p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(report, 'raw_simple_query_rtt'))}`,
    `typed RTT p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(report, 'typed_select_rtt'))}`,
    `param RTT p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(report, 'parameterized_select_rtt'))}`,
    `lookup p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(report, 'indexed_lookup'))}`,
    `aggregate p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(report, 'indexed_aggregate'))}`,
    `update p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(report, 'indexed_update'))}`,
    `background checkpoint p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(report, 'background_checkpoint'))}`,
    `insert throughput = ${formatThroughput(benchmarkWorkload(report, 'transaction_insert'))}`,
    `large result p90 = ${formatLatency(benchmarkWorkload(report, 'large_result_raw'))}`,
    `elapsed = ${report.elapsedMs.toFixed(2)} ms`,
    `JS timer ticks = ${report.jsTimerTicks}`,
  ];
  if (sqliteBenchmark) {
    lines.push(
      `sqlite open = ${sqliteBenchmark.openMs.toFixed(2)} ms`,
      `sqlite RTT p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(sqliteBenchmark, 'sqlite_parameterized_select_rtt'))}`,
      `sqlite lookup p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(sqliteBenchmark, 'sqlite_indexed_lookup'))}`,
      `sqlite update p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(sqliteBenchmark, 'sqlite_indexed_update'))}`,
      `sqlite checkpoint p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(sqliteBenchmark, 'sqlite_wal_checkpoint'))}`,
      `sqlite insert throughput = ${formatThroughput(benchmarkWorkload(sqliteBenchmark, 'sqlite_transaction_insert'))}`,
      `sqlite large result p90 = ${formatLatency(benchmarkWorkload(sqliteBenchmark, 'sqlite_large_result'))}`,
    );
  }
  return lines.join('\n');
}

function benchmarkWorkload(
  report: Pick<ReactNativeBenchmarkReport, 'workloads'>,
  id: string,
): ReactNativeBenchmarkWorkload | undefined {
  return report.workloads.find((workload) => workload.id === id);
}

function formatLatency(workload: ReactNativeBenchmarkWorkload | undefined): string {
  return workload?.latency ? `${workload.latency.p90Ms.toFixed(2)} ms` : 'pending';
}

function formatLatencyTriplet(workload: ReactNativeBenchmarkWorkload | undefined): string {
  if (!workload?.latency) {
    return 'pending';
  }
  const latency = workload.latency;
  return `${latency.p50Ms.toFixed(2)} / ${latency.p90Ms.toFixed(2)} / ${latency.p99Ms.toFixed(2)} ms`;
}

function formatThroughput(workload: ReactNativeBenchmarkWorkload | undefined): string {
  return workload?.throughput
    ? `${Math.round(workload.throughput.rowsPerSecond)} rows/s`
    : 'pending';
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return 'pending';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function logSmokeStage(started: number, stage: string, extra?: Record<string, unknown>) {
  console.log(
    'OLIPHAUNT_EXPO_SMOKE_STAGE',
    JSON.stringify({
      elapsedMs: Math.round(now() - started),
      stage,
      ...(extra ?? {}),
    }),
  );
}

function startTimerLivenessProbe(): { ticks: () => number; stop: () => void } {
  let active = true;
  let ticks = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timeout = setTimeout(() => {
      if (!active) {
        return;
      }
      ticks += 1;
      schedule();
    }, 0);
  };
  schedule();
  return {
    ticks: () => ticks,
    stop: () => {
      active = false;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    },
  };
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#eef2f6',
  },
  safeArea: {
    flex: 1,
  },
  content: {
    padding: 18,
    gap: 14,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  headerText: {
    flex: 1,
  },
  eyebrow: {
    color: '#4f6678',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  title: {
    color: '#13202b',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 34,
    marginTop: 3,
    maxWidth: 270,
  },
  statusPill: {
    alignItems: 'center',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 10,
  },
  statusIdle: {
    backgroundColor: '#d8dde6',
  },
  statusRunning: {
    backgroundColor: '#d7e8f7',
  },
  statusPassed: {
    backgroundColor: '#cfe8dc',
  },
  statusFailed: {
    backgroundColor: '#f1d0cf',
  },
  statusText: {
    color: '#102033',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metric: {
    backgroundColor: '#ffffff',
    borderColor: '#d6dde4',
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: '48%',
    flexGrow: 1,
    minHeight: 84,
    padding: 12,
  },
  metricLabel: {
    color: '#667789',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  metricValue: {
    color: '#13202b',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 23,
    marginTop: 8,
  },
  panel: {
    backgroundColor: '#13202b',
    borderRadius: 8,
    padding: 16,
  },
  panelTitle: {
    color: '#9fc7dd',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  resultText: {
    color: '#eef7fb',
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
    fontSize: 12,
    letterSpacing: 0,
    lineHeight: 18,
  },
  errorText: {
    color: '#ffc8c8',
    fontSize: 13,
    letterSpacing: 0,
    lineHeight: 19,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    color: '#32485c',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  row: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: '#d6dde4',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 64,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  checkRow: {
    alignItems: 'flex-start',
    backgroundColor: '#ffffff',
    borderColor: '#d6dde4',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 76,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowMain: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    color: '#172533',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0,
  },
  rowMeta: {
    color: '#607285',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0,
  },
  rowValue: {
    color: '#0c6f5c',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0,
  },
  statusBadge: {
    backgroundColor: '#e7edf3',
    borderRadius: 8,
    color: '#263747',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 5,
    textTransform: 'uppercase',
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#0f6cbd',
    borderRadius: 8,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonPressed: {
    backgroundColor: '#0b5799',
  },
  buttonDisabled: {
    backgroundColor: '#8daac1',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0,
  },
});
