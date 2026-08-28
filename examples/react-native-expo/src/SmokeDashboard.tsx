import {
  Oliphaunt,
  type DatabaseStorage,
  type OliphauntDatabase,
  type QueryResult,
} from '@oliphaunt/react-native';
import {
  GENERATED_MOBILE_EXTENSION_METADATA_SHA256,
  GENERATED_MOBILE_EXTENSION_PLAN,
  GENERATED_MOBILE_EXTENSION_SMOKE,
} from './generated/extension-smoke';
import {
  runMobileBindingProof,
  runMobileReleaseExtensionProof,
  runPostgresLifecycleResumeCheck,
  type OperationCheck,
} from './mobile-smoke';
import {
  runExpoSQLiteBenchmark,
  type ExpoSQLiteBenchmarkReport,
  type ReactNativeBenchmarkWorkload,
} from './sqlite-benchmark';
import {
  EXPO_SMOKE_PASS_TAG,
  serializeExpoSmokePassReceipt,
} from './smoke-pass-receipt';
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
type CatalogProfile = 'standard' | 'icu';

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
  benchmark?: NativeBenchmarkReport;
  sqliteBenchmark?: ExpoSQLiteBenchmarkReport;
  crashRecovery?: {
    phase: 'write' | 'verify';
    storageLabel: string;
    value: string;
    openMs: number;
    elapsedMs: number;
    postgresSettings: PostgresSettings;
  };
  checks?: OperationCheck[];
  lifecycle?: OperationCheck;
  icuProof?: OperationCheck;
  extensionProof?: OperationCheck[];
};

type SmokeGlobalState = {
  databasePromise?: Promise<OliphauntDatabase>;
  databaseInstance?: OliphauntDatabase;
  runPromise?: Promise<void>;
};

type OpenTuning = {
  startupGUCs?: Readonly<Record<string, string>>;
  storage?: DatabaseStorage;
  storageLabel?: string;
};

type BenchmarkTuning = {
  readonly warmupIterations: number;
  readonly typedRttIterations: number;
  readonly parameterizedRttIterations: number;
  readonly insertRows: number;
  readonly checkpointIterations: number;
};

type PostgresSettings = Readonly<Record<string, string>>;

type NativeBenchmarkReport = {
  readonly schemaVersion: 1;
  readonly engine: 'direct';
  readonly rawProtocolTransport: 'jsi-array-buffer';
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly openMs: number;
  readonly closeMs: number;
  readonly jsTimerTicks: number;
  readonly metadata: Record<string, string | number | boolean | null>;
  readonly postgresSettings: PostgresSettings;
  readonly workloads: ReactNativeBenchmarkWorkload[];
};

const smokeGlobalKey = '__OLIPHAUNT_EXPO_SMOKE_STATE__';
const initialUrlTimeoutMs = 2_500;
const defaultSmokeStorageName =
  `installed-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const packagedCatalogProfile = process.env.EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE;
const packagedCatalogProfileProbeSql =
  process.env.EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_SQL;
const packagedCatalogProfileProbeExpected =
  process.env.EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_EXPECTED;
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

        if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
          throw new Error(`installed mobile release proof does not support platform ${Platform.OS}`);
        }
        const extensionPlan = mobileReleaseExtensionProofPlan();
        const extensions = extensionPlan.map((extension) => extension.sqlName);
        stage('extensions:selected', { extensions });
        const databaseOpen = await openDatabase(stage, extensions);
        stage('open:done', { openMs: databaseOpen.openMs });
        const db = databaseOpen.database;
        stage('extensions:activation:start', { count: extensionPlan.length });
        const extensionProofResult = await runMobileReleaseExtensionProof(
          db,
          extensionPlan,
          check =>
            stage(`extensions:${check.status}`, {
              name: check.name,
              checkElapsedMs: check.elapsedMs === undefined ? undefined : Math.round(check.elapsedMs),
            }),
        );
        const extensionProof = extensionProofResult.checks;
        stage('extensions:activation:done', { checks: extensionProof.length });

        stage('query:select1:start');
        const select = await db.query('SELECT 1::text AS value');
        const selectOne = requiredQueryText(select, 'value');
        stage('query:select1:done', { value: selectOne });
        stage('query:parameter:start');
        const parameterized = await db.query('SELECT $1::text AS value', ['hello']);
        const parameterRoundTrip = requiredQueryText(parameterized, 'value');
        stage('query:parameter:done', { value: parameterRoundTrip });
        const bindingProof = await runMobileBindingProof(
          db,
          check =>
            stage(`binding:${check.status}`, {
              name: check.name,
              checkElapsedMs: check.elapsedMs === undefined ? undefined : Math.round(check.elapsedMs),
            }),
        );
        const lifecycle = await runLifecycleResumeValidation(db, stage);
        const profileProof = await runCatalogProfileReopenProof(db, extensions, stage);
        const icuProof = profileProof.check;
        liveness.stop();
        const checks = [
          ...extensionProof,
          ...bindingProof,
          ...(icuProof ? [icuProof] : []),
          ...(lifecycle ? [lifecycle] : []),
        ];

        const smoke = {
          engine: 'direct',
          rawProtocolTransport: 'jsi-array-buffer',
          selectOne,
          parameterRoundTrip,
          jsTimerTicks: liveness.ticks(),
          elapsedMs: now() - started,
        };
        const nextReport = {
          smoke,
          checks,
          lifecycle,
          icuProof,
          extensionProof,
        };
        const smokePassReceipt = serializeExpoSmokePassReceipt({
          platform: Platform.OS,
          extensions,
          activatedExtensions: extensionProofResult.activatedExtensions,
          extensionCatalogComplete: extensionProofResult.extensionCatalogComplete,
          pgTextsearchEnglishBm25: extensionProofResult.pgTextsearchEnglishBm25,
          extensionCatalogSha256: GENERATED_MOBILE_EXTENSION_METADATA_SHA256,
          catalogProfile: profileProof.catalogProfile,
          icuRuntimeProof: profileProof.catalogProfile === 'icu',
        });
        setReport(nextReport);
        (globalThis as Record<string, unknown>).__OLIPHAUNT_EXPO_SMOKE_REPORT__ = nextReport;
        setState('passed');
        console.log(EXPO_SMOKE_PASS_TAG, smokePassReceipt);
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
              <Text style={styles.title}>Installed runtime smoke</Text>
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
              value={report.smoke?.engine ?? report.benchmark?.engine ?? 'pending'}
            />
            <Metric label="transport" value={report.smoke?.rawProtocolTransport ?? 'pending'} />
            <Metric label="contract" value={report.smoke ? 'passed' : 'pending'} />
            <Metric
              label={report.benchmark ? 'typed p90' : 'SELECT p90'}
              value={
                report.benchmark
                  ? formatLatency(benchmarkWorkload(report.benchmark, 'typed_select_rtt'))
                  : 'not benchmarked'
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
            <Metric label="checks" value={report.checks ? String(report.checks.length) : 'pending'} />
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
              {state === 'running' ? 'Running smoke' : 'Run smoke'}
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

async function runCatalogProfileReopenProof(
  db: OliphauntDatabase,
  extensions: readonly string[],
  stage: (name: string, extra?: Record<string, unknown>) => void,
): Promise<{ catalogProfile: CatalogProfile; check: OperationCheck }> {
  const started = now();
  const catalogProfile = selectedCatalogProfile();
  const sql = requiredPublicEnvironment(
    'EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_SQL',
    packagedCatalogProfileProbeSql,
  );
  const expected = requiredPublicEnvironment(
    'EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_EXPECTED',
    packagedCatalogProfileProbeExpected,
  );
  stage('catalog-profile:start', { catalogProfile });
  await assertCatalogProfileProbe(db, sql, expected, catalogProfile);
  const marker = `marker-${Platform.OS}-${Math.round(started)}`;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS oliphaunt_mobile_reopen_marker (
      id integer PRIMARY KEY,
      value text NOT NULL
    )
  `);
  await db.execute(
    `
    INSERT INTO oliphaunt_mobile_reopen_marker (id, value)
    VALUES (1, $1)
    ON CONFLICT (id) DO UPDATE SET value = excluded.value
    `,
    [marker],
  );
  await db.close();
  const smokeState = smokeGlobalState();
  smokeState.databaseInstance = undefined;
  smokeState.databasePromise = undefined;
  const reopened = (await openDatabase(stage, extensions)).database;
  const persisted = await reopened.query(
    'SELECT value FROM oliphaunt_mobile_reopen_marker WHERE id = 1',
  );
  const reopenedMarker = requiredQueryText(persisted, 'value');
  if (reopenedMarker !== marker) {
    throw new Error(`database reopen marker mismatch: expected '${marker}', got '${reopenedMarker}'`);
  }
  await assertCatalogProfileProbe(reopened, sql, expected, catalogProfile);
  const elapsedMs = now() - started;
  const detail = `catalogProfile=${catalogProfile}; probe=${expected}; reopen marker persisted`;
  stage('catalog-profile:done', { detail, elapsedMs });
  return {
    catalogProfile,
    check: { name: 'packaged catalog profile and reopen', detail, elapsedMs },
  };
}

async function assertCatalogProfileProbe(
  db: OliphauntDatabase,
  sql: string,
  expected: string,
  profile: CatalogProfile,
): Promise<void> {
  const result = await db.query(`SELECT (${sql})::text AS result`);
  const actual = requiredQueryText(result, 'result');
  if (actual !== expected) {
    throw new Error(`${profile} packaged catalog probe failed: expected '${expected}', got '${actual}'`);
  }
}

function selectedCatalogProfile(): CatalogProfile {
  const profile = requiredPublicEnvironment(
    'EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE',
    packagedCatalogProfile,
  );
  if (profile !== 'standard' && profile !== 'icu') {
    throw new Error(`unsupported packaged catalog profile '${profile}'`);
  }
  return profile;
}

function requiredPublicEnvironment(name: string, value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`installed mobile qualification requires ${name}`);
  }
  return value;
}

function mobileReleaseExtensionProofPlan() {
  return GENERATED_MOBILE_EXTENSION_PLAN.map((extension) => {
    const smokeStatements = (
      GENERATED_MOBILE_EXTENSION_SMOKE as Readonly<Record<string, readonly string[]>>
    )[extension.sqlName];
    if (smokeStatements === undefined) {
      throw new Error(`mobile extension ${extension.sqlName} has no canonical smoke recipe`);
    }
    return {
      sqlName: extension.sqlName,
      createsExtension: extension.createsExtension,
      selectedExtensionDependencies: extension.selectedExtensionDependencies,
      activationSql: activationSqlForExtension(extension),
      smokeStatements,
    };
  });
}

function activationSqlForExtension(extension: {
  readonly sqlName: string;
  readonly createsExtension: boolean;
}): readonly string[] {
  if (extension.createsExtension) {
    return [`CREATE EXTENSION "${extension.sqlName}"`];
  }
  if (extension.sqlName === 'auto_explain') {
    return [
      "LOAD 'auto_explain'",
      "SET auto_explain.log_min_duration = '0'",
      "SET auto_explain.log_analyze = 'true'",
      "SET auto_explain.log_level = 'NOTICE'",
    ];
  }
  throw new Error(
    `generated mobile extension ${extension.sqlName} does not create an extension and has no runtime proof`,
  );
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
    startupGUCs: JSON.stringify(openConfig.startupGUCs ?? {}),
  };
  stage('benchmark:liboliphaunt:start');
  const report = await runNativeBenchmark(openConfig, benchmarkOptions, metadata, liveness.ticks);
  stage('benchmark:sqlite:start');
  const sqliteBenchmark = await runExpoSQLiteBenchmark({
    durability: 'balanced',
    warmupIterations: benchmarkOptions.warmupIterations,
    simpleRttIterations: benchmarkOptions.typedRttIterations,
    parameterizedRttIterations: benchmarkOptions.parameterizedRttIterations,
    insertRows: benchmarkOptions.insertRows,
    lookupIterations: benchmarkOptions.typedRttIterations,
    aggregateIterations: benchmarkOptions.parameterizedRttIterations,
    updateIterations: benchmarkOptions.parameterizedRttIterations,
    checkpointIterations: benchmarkOptions.checkpointIterations,
    largeResultRows: benchmarkOptions.insertRows,
    metadata,
  });
  liveness.stop();
  const nextReport: AppReport = {
    benchmark: report,
    sqliteBenchmark,
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
    }),
  );
  (globalThis as Record<string, unknown>).__OLIPHAUNT_EXPO_BENCH_REPORT__ = nextReport;
}

async function runNativeBenchmark(
  tuning: OpenTuning,
  options: BenchmarkTuning,
  metadata: Record<string, string | number | boolean | null>,
  timerTicks: () => number,
): Promise<NativeBenchmarkReport> {
  const startedAt = new Date().toISOString();
  const started = now();
  const { storageLabel: _storageLabel, ...openConfig } = tuning;
  const openStarted = now();
  const db = await Oliphaunt.open(openConfig);
  const openMs = now() - openStarted;
  let closeMs = 0;

  try {
    const postgresSettings = await readPostgresSettings(db);
    for (let index = 0; index < options.warmupIterations; index += 1) {
      await db.query('SELECT 1');
    }
    const workloads = [
      await benchmarkLatency('typed_select_rtt', 'SELECT 1 query round trip', options.typedRttIterations, () =>
        db.query('SELECT 1'),
      ),
      await benchmarkLatency(
        'parameterized_select_rtt',
        'parameterized query round trip',
        options.parameterizedRttIterations,
        () => db.query('SELECT $1::integer', [1]),
      ),
    ];

    await db.execute('DROP TABLE IF EXISTS oliphaunt_expo_benchmark');
    await db.execute('CREATE TABLE oliphaunt_expo_benchmark(id integer PRIMARY KEY, value text NOT NULL)');
    const insertStarted = now();
    await db.execute(
      'INSERT INTO oliphaunt_expo_benchmark SELECT value, md5(value::text) FROM generate_series(1, $1::integer) AS value',
      [options.insertRows],
    );
    const insertMs = now() - insertStarted;
    workloads.push({
      id: 'transaction_insert',
      description: 'set-based transaction insert',
      throughput: {
        rows: options.insertRows,
        totalMs: insertMs,
        rowsPerSecond: insertMs === 0 ? 0 : options.insertRows * 1_000 / insertMs,
      },
      rows: options.insertRows,
    });
    workloads.push(
      await benchmarkLatency(
        'background_checkpoint',
        'checkpoint latency',
        options.checkpointIterations,
        () => db.execute('CHECKPOINT'),
      ),
    );

    const closeStarted = now();
    await db.close();
    closeMs = now() - closeStarted;
    return {
      schemaVersion: 1,
      engine: 'direct',
      rawProtocolTransport: 'jsi-array-buffer',
      startedAt,
      elapsedMs: now() - started,
      openMs,
      closeMs,
      jsTimerTicks: timerTicks(),
      metadata,
      postgresSettings,
      workloads,
    };
  } finally {
    await db.close().catch(() => undefined);
  }
}

async function benchmarkLatency(
  id: string,
  description: string,
  iterations: number,
  operation: () => Promise<unknown>,
): Promise<ReactNativeBenchmarkWorkload> {
  const samples: number[] = [];
  const started = now();
  for (let index = 0; index < iterations; index += 1) {
    const sampleStarted = now();
    await operation();
    samples.push(now() - sampleStarted);
  }
  const totalMs = now() - started;
  samples.sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * fraction))] ?? 0;
  return {
    id,
    description,
    latency: {
      iterations,
      totalMs,
      minMs: samples[0] ?? 0,
      meanMs: iterations === 0 ? 0 : totalMs / iterations,
      p50Ms: percentile(0.5),
      p90Ms: percentile(0.9),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: samples[samples.length - 1] ?? 0,
    },
  };
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
  if (!openTuning.storage || !openTuning.storageLabel) {
    throw new Error('crash recovery runner requires explicit persistent storage');
  }
  stage('crash:open:start', { phase: runner, storage: openTuning.storageLabel });
  const databaseOpen = await openDatabase(stage, []);
  const db = databaseOpen.database;
  const postgresSettings = await readPostgresSettings(db);
  assertSafeCrashSettings(postgresSettings);

  if (runner === 'crash-write') {
    const value = `crash-${Platform.OS}-${Math.round(started)}`;
    stage('crash:write:start', { value });
    await db.execute(`
      CREATE TABLE IF NOT EXISTS rn_crash_recovery (
        id integer PRIMARY KEY,
        value text NOT NULL,
        written_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.execute(
      `
      INSERT INTO rn_crash_recovery (id, value)
      VALUES (1, $1)
      ON CONFLICT (id)
      DO UPDATE SET value = excluded.value, written_at = CURRENT_TIMESTAMP
      `,
      [value],
    );
    const check = await db.query('SELECT value FROM rn_crash_recovery WHERE id = 1');
    const persisted = requiredQueryText(check, 'value');
    if (persisted !== value) {
      throw new Error(`crash recovery write readback mismatch: ${persisted}`);
    }
    liveness.stop();
    const payload = {
      phase: 'write' as const,
      storageLabel: openTuning.storageLabel,
      value,
      openMs: databaseOpen.openMs,
      elapsedMs: now() - started,
      postgresSettings,
    };
    setReport({ crashRecovery: payload });
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
  const value = requiredQueryText(recovered, 'value');
  if (!value.startsWith(`crash-${Platform.OS}-`)) {
    throw new Error(`crash recovery verification found unexpected value '${value}'`);
  }
  await db.execute('INSERT INTO rn_crash_recovery (id, value) VALUES (2, \'verified\') ON CONFLICT (id) DO UPDATE SET value = excluded.value');
  await db.close();
  liveness.stop();
  const payload = {
    phase: 'verify' as const,
    storageLabel: openTuning.storageLabel,
    value,
    openMs: databaseOpen.openMs,
    elapsedMs: now() - started,
    postgresSettings,
  };
  setReport({ crashRecovery: payload });
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

async function readPostgresSettings(db: OliphauntDatabase): Promise<PostgresSettings> {
  const names = [
    'shared_buffers',
    'wal_buffers',
    'wal_segment_size',
    'min_wal_size',
    'max_wal_size',
    'synchronous_commit',
    'fsync',
    'full_page_writes',
    'io_method',
  ] as const;
  const columns = names.map((name) => `current_setting('${name}') AS ${name}`).join(', ');
  const row = await db.query(`SELECT ${columns}`);
  return Object.fromEntries(
    names.map((name) => {
      return [name, requiredQueryText(row, name)];
    }),
  );
}

function requiredQueryText(result: QueryResult, column: string, row = 0): string {
  const value = result.rows[row]?.[column];
  if (typeof value !== 'string') {
    throw new Error(`query result missing text column '${column}' at row ${row}`);
  }
  return value;
}

function assertSafeCrashSettings(settings: PostgresSettings): void {
  for (const name of ['fsync', 'full_page_writes', 'synchronous_commit'] as const) {
    if (settings[name] !== 'on') {
      throw new Error(
        `crash recovery evidence requires PostgreSQL ${name}=on; observed ${settings[name] ?? 'missing'}`,
      );
    }
  }
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
    const { storage, storageLabel: _storageLabel, ...tuning } = openTuning;
    const config = {
      storage: storage ?? ({ kind: 'applicationData', name: defaultSmokeStorageName } as const),
      ...tuning,
      extensions,
      username: 'postgres',
      database: 'postgres',
    } satisfies Parameters<typeof Oliphaunt.open>[0];
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
  const rawStartupGUCs = String(
    process.env.EXPO_PUBLIC_OLIPHAUNT_STARTUP_GUCS ??
    extractQueryParam(url, 'liboliphauntStartupGUCs') ??
    '',
  );
  const startupGUCs = parseStartupGUCs(rawStartupGUCs);
  return {
    startupGUCs: Object.keys(startupGUCs).length > 0 ? startupGUCs : undefined,
    ...resolveHarnessStorage(url),
  };
}

function parseStartupGUCs(value: string): Record<string, string> {
  const gucs: Record<string, string> = {};
  for (const entry of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error(`startup GUC must use name=value syntax: ${entry}`);
    }
    gucs[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  return gucs;
}

function resolveHarnessStorage(url: string | null): Pick<OpenTuning, 'storage' | 'storageLabel'> {
  const applicationData = optionalNonBlankString(
    process.env.EXPO_PUBLIC_OLIPHAUNT_APPLICATION_DATA ??
      extractQueryParam(url, 'liboliphauntApplicationData'),
    'liboliphauntApplicationData',
  );
  if (applicationData) {
    return {
      storage: { kind: 'applicationData', name: applicationData },
      storageLabel: `applicationData:${applicationData}`,
    };
  }
  const directory = optionalNonBlankString(
    process.env.EXPO_PUBLIC_OLIPHAUNT_STORAGE_DIRECTORY ??
      extractQueryParam(url, 'liboliphauntStorageDirectory'),
    'liboliphauntStorageDirectory',
  );
  return directory
    ? { storage: { kind: 'directory', path: directory }, storageLabel: directory }
    : {};
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
        typedRttIterations: 750,
        parameterizedRttIterations: 750,
        insertRows: 1_500,
        checkpointIterations: 20,
      };
    case 'quick':
      return {
        warmupIterations: 10,
        typedRttIterations: 75,
        parameterizedRttIterations: 75,
        insertRows: 250,
        checkpointIterations: 3,
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

function formatResult(report: AppReport): string {
  if (report.benchmark) {
    return formatBenchmarkResult(report.benchmark, report.sqliteBenchmark);
  }
  if (report.crashRecovery) {
    return [
      `crash phase = ${report.crashRecovery.phase}`,
      `storage = ${report.crashRecovery.storageLabel}`,
      `value = ${report.crashRecovery.value}`,
      `open = ${report.crashRecovery.openMs.toFixed(2)} ms`,
      `elapsed = ${report.crashRecovery.elapsedMs.toFixed(2)} ms`,
    ].join('\n');
  }
  if (!report.smoke) {
    return 'Waiting for native smoke results.';
  }
  return [
    `SELECT 1 = ${report.smoke.selectOne}`,
    `parameter = ${report.smoke.parameterRoundTrip}`,
    `checks = ${report.checks?.length ?? 0}`,
    `JS timer ticks = ${report.smoke.jsTimerTicks}`,
    `elapsed = ${report.smoke.elapsedMs.toFixed(2)} ms`,
  ].join('\n');
}

function formatBenchmarkResult(
  report: NativeBenchmarkReport,
  sqliteBenchmark?: ExpoSQLiteBenchmarkReport,
): string {
  const lines = [
    `engine = ${report.engine}`,
    `transport = ${report.rawProtocolTransport}`,
    `open = ${report.openMs.toFixed(2)} ms`,
    `typed RTT p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(report, 'typed_select_rtt'))}`,
    `param RTT p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(report, 'parameterized_select_rtt'))}`,
    `checkpoint p50/p90/p99 = ${formatLatencyTriplet(benchmarkWorkload(report, 'background_checkpoint'))}`,
    `insert throughput = ${formatThroughput(benchmarkWorkload(report, 'transaction_insert'))}`,
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
  report: Pick<NativeBenchmarkReport | ExpoSQLiteBenchmarkReport, 'workloads'>,
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
