import {
  Boxes,
  Braces,
  CodeXml,
  Database,
  HardDrive,
  Laptop,
  Layers,
  Network,
  Server,
  ShieldCheck,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';

export type SdkSurface = {
  id: string;
  title: string;
  href: string;
  packageName: string;
  install: string;
  target: string;
  startWith: string;
  owns: string;
  modes: string[];
  verifyFirst: string;
  guideOutcomes: string[];
  icon: LucideIcon;
};

export const sdkSurfaces: SdkSurface[] = [
  {
    id: 'rust',
    title: 'Rust',
    href: '/docs/sdk/rust',
    packageName: 'oliphaunt',
    install: 'cargo add oliphaunt',
    target: 'Tauri and native Rust desktop apps',
    startWith: 'Direct, broker, and server modes',
    owns: 'Rust-native async APIs, helper processes, and desktop runtime selection.',
    modes: ['direct', 'broker', 'server'],
    verifyFirst: 'Run a direct query, then verify broker or server capability before using pools.',
    guideOutcomes: [
      'Open a persistent or temporary root from async Rust code.',
      'Choose direct, broker, or server mode deliberately.',
      'Select exact extensions and keep backup/restore behind SDK APIs.',
    ],
    icon: Laptop,
  },
  {
    id: 'swift',
    title: 'Swift',
    href: '/docs/sdk/swift',
    packageName: 'Oliphaunt',
    install: 'Add package in Xcode or Package.swift',
    target: 'iOS and macOS apps',
    startWith: 'Swift concurrency, app storage, and lifecycle',
    owns: 'Apple app storage, actors, lifecycle hooks, and native runtime resources.',
    modes: ['direct'],
    verifyFirst: 'Open from app storage, run a query off the main actor, and exercise app lifecycle hooks.',
    guideOutcomes: [
      'Add the Swift package to an iOS or macOS app target.',
      'Open from Swift concurrency without blocking the main actor.',
      'Coordinate app lifecycle, exact extensions, and backup/restore.',
    ],
    icon: Smartphone,
  },
  {
    id: 'kotlin',
    title: 'Kotlin',
    href: '/docs/sdk/kotlin',
    packageName: 'dev.oliphaunt:oliphaunt-android',
    install: 'id("dev.oliphaunt.android") + implementation("dev.oliphaunt:oliphaunt-android:0.1.0")',
    target: 'Android apps',
    startWith: 'Coroutines, Android resources, and ABI artifacts',
    owns: 'Android resource hydration, ABI selection, coroutines, and lifecycle.',
    modes: ['direct'],
    verifyFirst: 'Build the Android app, open from app-private storage, and confirm selected ABI assets.',
    guideOutcomes: [
      'Add the Android package through Gradle.',
      'Open from coroutine code using app-private storage.',
      'Package only selected extensions and use Android lifecycle hooks.',
    ],
    icon: Smartphone,
  },
  {
    id: 'react-native',
    title: 'React Native',
    href: '/docs/sdk/react-native',
    packageName: '@oliphaunt/react-native',
    install: 'npx expo install @oliphaunt/react-native',
    target: 'Expo and React Native New Architecture apps',
    startWith: 'Config plugin, TurboModule, and JSI transport',
    owns: 'TypeScript DX, config plugin behavior, JSI bytes, and platform delegation.',
    modes: ['direct'],
    verifyFirst: 'Build a development client, confirm native module loading, and move bytes through JSI.',
    guideOutcomes: [
      'Install the package and build a native app binary or development client.',
      'Use the config plugin for exact extension artifacts.',
      'Move SQL, raw protocol bytes, streaming, and lifecycle through JSI/TurboModule APIs.',
    ],
    icon: Layers,
  },
  {
    id: 'typescript',
    title: 'TypeScript',
    href: '/docs/sdk/typescript',
    packageName: '@oliphaunt/ts',
    install: 'npm install @oliphaunt/ts',
    target: 'Node.js, Bun, and Deno',
    startWith: 'Desktop JavaScript over native helpers',
    owns: 'JavaScript API shape, runtime asset resolution, and helper-backed modes.',
    modes: ['broker', 'server', 'direct adapter'],
    verifyFirst: 'Resolve helper assets, connect to broker or server mode, and run the same query path.',
    guideOutcomes: [
      'Install the desktop JavaScript package from npm.',
      'Resolve helper-backed runtime assets from the package.',
      'Choose broker or server mode for robust desktop JavaScript apps.',
    ],
    icon: Braces,
  },
  {
    id: 'wasm',
    title: 'WASM',
    href: '/docs/sdk/wasm',
    packageName: 'oliphaunt-wasix',
    install: 'cargo add oliphaunt-wasix',
    target: 'WASM/WASIX hosts',
    startWith: 'WASM/WASIX runtime family',
    owns: 'WASM runtime behavior, WASIX assets, dump and restore flows.',
    modes: ['WASIX'],
    verifyFirst: 'Load WASM runtime assets, open a root, and prove dump or restore for data movement.',
    guideOutcomes: [
      'Install the WASM package for WASIX hosts.',
      'Open a WASM runtime root and run SQL through WebAssembly.',
      'Use dump/restore when moving data across runtimes or versions.',
    ],
    icon: Boxes,
  },
  {
    id: 'c-abi',
    title: 'C ABI',
    href: '/docs/sdk/c-abi',
    packageName: 'liboliphaunt',
    install: 'Use released headers, libraries, and runtime assets',
    target: 'New language bindings',
    startWith: 'Native runtime ownership and ABI rules',
    owns: 'Opaque handles, raw protocol bytes, response ownership, and lifecycle.',
    modes: ['direct ABI'],
    verifyFirst: 'Open an opaque handle, send protocol bytes, free responses, and close cleanly.',
    guideOutcomes: [
      'Consume released headers, libraries, and native runtime assets.',
      'Open an opaque handle and manage response ownership explicitly.',
      'Build language bindings that expose capabilities, errors, lifecycle, and backup APIs.',
    ],
    icon: CodeXml,
  },
];

export type RuntimeMode = {
  name: string;
  label: string;
  href: string;
  useWhen: string;
  boundary: string;
  icon: LucideIcon;
};

export const runtimeModes: RuntimeMode[] = [
  {
    name: 'nativeDirect',
    label: 'Embedded latency',
    href: '/docs/learn/native-runtime',
    useWhen: 'One app database needs the lowest overhead path.',
    boundary: 'One physical PostgreSQL session with serialized work.',
    icon: Database,
  },
  {
    name: 'nativeBroker',
    label: 'Desktop isolation',
    href: '/docs/learn/native-runtime',
    useWhen: 'A desktop app needs helper-process ownership, multiple roots, or recovery.',
    boundary: 'Helper process boundary for desktop SDKs.',
    icon: Network,
  },
  {
    name: 'nativeServer',
    label: 'Client compatibility',
    href: '/docs/learn/native-runtime',
    useWhen: 'Existing PostgreSQL clients, ORMs, psql, or pg_dump need real sessions.',
    boundary: 'PostgreSQL-compatible process boundary with independent client sessions.',
    icon: Server,
  },
  {
    name: 'WASM',
    label: 'WASIX runtime',
    href: '/docs/sdk/wasm/runtime',
    useWhen: 'The app targets a WASM/WASIX host.',
    boundary: 'Separate build and packaging rules from native SDKs.',
    icon: Boxes,
  },
];

export const productPillars = [
  {
    title: 'PostgreSQL semantics',
    description: 'Use PostgreSQL storage, WAL, SQL, protocol behavior, and selected extensions inside app-owned storage.',
    icon: Database,
  },
  {
    title: 'Runtime modes with clear boundaries',
    description: 'Direct optimizes embedded latency, broker optimizes desktop isolation, and server optimizes independent client sessions.',
    icon: Server,
  },
  {
    title: 'Exact extension packaging',
    description: 'Apps select SQL extension names explicitly so release artifacts include only what the app uses.',
    icon: ShieldCheck,
  },
  {
    title: 'App-grade data movement',
    description: 'SDK backup and restore APIs keep PostgreSQL directory mechanics out of application code.',
    icon: HardDrive,
  },
];
