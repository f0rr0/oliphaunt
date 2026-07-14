import type {
  EngineMode,
  OpenConfig,
  PackageSizeReport,
  OliphauntClient,
  OliphauntDatabase,
  RawProtocolTransport,
} from './client';

export type ReactNativeSmokeOptions = {
  readonly open?: OpenConfig;
  readonly expectedTransport?: RawProtocolTransport;
  readonly expectedEngine?: EngineMode;
  readonly requirePackageSizeReport?: boolean;
  readonly afterSmoke?: (database: OliphauntDatabase) => Promise<void> | void;
};

export type ReactNativeSmokeReport = {
  readonly engine: EngineMode;
  readonly rawProtocolTransport: RawProtocolTransport;
  readonly selectOne: string;
  readonly parameterRoundTrip: string;
  readonly jsTimerTicks: number;
  readonly elapsedMs: number;
  readonly packageSizeReport?: PackageSizeReport | null;
};

export async function runOliphauntReactNativeSmoke(
  client: OliphauntClient,
  options: ReactNativeSmokeOptions = {},
): Promise<ReactNativeSmokeReport> {
  const start = monotonicNow();
  const liveness = startTimerLivenessProbe();
  const db = await client.open({
    engine: 'nativeDirect',
    temporary: true,
    username: 'postgres',
    database: 'postgres',
    ...options.open,
  });

  try {
    const capabilities = await db.capabilities();
    const expectedEngine = options.expectedEngine ?? options.open?.engine ?? 'nativeDirect';
    if (capabilities.engine !== expectedEngine) {
      throw new Error(
        `Oliphaunt React Native smoke opened ${capabilities.engine}, expected ${expectedEngine}`,
      );
    }
    const expectedTransport = options.expectedTransport ?? 'jsi-array-buffer';
    if (capabilities.rawProtocolTransport !== expectedTransport) {
      throw new Error(
        `Oliphaunt React Native smoke used ${capabilities.rawProtocolTransport}, expected ${expectedTransport}`,
      );
    }
    if (!capabilities.protocolRaw || !capabilities.simpleQuery) {
      throw new Error(
        'Oliphaunt React Native smoke requires raw protocol and simple-query support',
      );
    }

    const select = await db.query('SELECT 1::text AS value');
    const selectOne = select.getText(0, 'value');
    if (selectOne !== '1') {
      throw new Error(`Oliphaunt React Native smoke SELECT 1 returned ${String(selectOne)}`);
    }

    const parameterized = await db.query('SELECT $1::text AS value', ['hello']);
    const parameterRoundTrip = parameterized.getText(0, 'value');
    if (parameterRoundTrip !== 'hello') {
      throw new Error(
        `Oliphaunt React Native smoke parameter query returned ${String(parameterRoundTrip)}`,
      );
    }

    let packageSizeReport: PackageSizeReport | null | undefined;
    if (options.requirePackageSizeReport === true) {
      packageSizeReport = await client.packageSizeReport({
        resourceRoot: options.open?.resourceRoot,
      });
      if (packageSizeReport == null) {
        throw new Error('Oliphaunt React Native smoke expected packaged resource size evidence');
      }
    }

    const report = {
      engine: capabilities.engine,
      rawProtocolTransport: capabilities.rawProtocolTransport,
      selectOne,
      parameterRoundTrip,
      jsTimerTicks: liveness.ticks(),
      elapsedMs: monotonicNow() - start,
      packageSizeReport,
    };
    liveness.stop();

    await options.afterSmoke?.(db);

    return report;
  } finally {
    liveness.stop();
    await db.close();
  }
}

export async function runInstalledOliphauntReactNativeSmoke(
  options: ReactNativeSmokeOptions = {},
): Promise<ReactNativeSmokeReport> {
  const { Oliphaunt } = await import('./index.js');
  return runOliphauntReactNativeSmoke(Oliphaunt, options);
}

function monotonicNow(): number {
  const performanceNow = globalThis.performance?.now.bind(globalThis.performance);
  return performanceNow ? performanceNow() : Date.now();
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
