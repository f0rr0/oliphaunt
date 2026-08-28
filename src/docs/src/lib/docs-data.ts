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
    owns: 'Rust-native synchronous and explicit async APIs, helper processes, and desktop runtime selection.',
    modes: ['direct', 'broker', 'server'],
    verifyFirst: 'Run a direct query, then use broker or server when the documented target support fits.',
    guideOutcomes: [
      'Open persistent or temporary storage from the synchronous root or explicit async owner handle.',
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
    startWith: 'Swift concurrency and app storage',
    owns: 'Apple app storage, actors, and native runtime resources.',
    modes: ['direct'],
    verifyFirst: 'Open from app storage, run a query off the main actor, and close.',
    guideOutcomes: [
      'Add the Swift package to an iOS or macOS app target.',
      'Open from Swift concurrency without blocking the main actor.',
      'Coordinate exact extensions, cancellation, and backup/restore.',
    ],
    icon: Smartphone,
  },
  {
    id: 'kotlin',
    title: 'Kotlin',
    href: '/docs/sdk/kotlin',
    packageName: 'dev.oliphaunt:oliphaunt-android',
    install: 'id("dev.oliphaunt.android") + implementation("dev.oliphaunt:oliphaunt-android:0.1.1")',
    target: 'Android apps',
    startWith: 'Coroutines, Android resources, and ABI artifacts',
    owns: 'Android resource hydration, ABI selection, coroutines, and native runtime ownership.',
    modes: ['direct'],
    verifyFirst: 'Build the Android app, open from app-private storage, and confirm selected ABI assets.',
    guideOutcomes: [
      'Add the Android package through Gradle.',
      'Open from coroutine code using app-private storage.',
      'Package only selected extensions and use cancellation and close explicitly.',
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
      'Move SQL and buffered raw protocol bytes through JSI/TurboModule APIs.',
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
    startWith: 'Desktop JavaScript over the native runtime family',
    owns: 'JavaScript API shape, native runtime asset resolution, and native engine modes.',
    modes: ['native direct', 'native broker', 'native server'],
    verifyFirst: 'Resolve native runtime assets, open the selected native mode, and run one query.',
    guideOutcomes: [
      'Install the native desktop JavaScript package from npm.',
      'Resolve native runtime and helper assets from the package.',
      'Choose direct, broker, or server behavior without importing a WASIX host.',
    ],
    icon: Braces,
  },
  {
    id: 'wasix-rust',
    title: 'Rust WASIX',
    href: '/docs/sdk/wasix-rust',
    packageName: 'oliphaunt-wasix',
    install: 'cargo add oliphaunt-wasix',
    target: 'Rust applications hosting the portable WASIX runtime',
    startWith: 'Direct Rust calls or a local PostgreSQL-compatible endpoint',
    owns: 'Rust WASIX hosting, storage, server mode, and dump/restore tooling.',
    modes: ['WASIX direct', 'WASIX server'],
    verifyFirst: 'Open memory storage, run one query, and verify the exact WASIX runtime assets.',
    guideOutcomes: [
      'Install the Rust binding and its matching portable runtime carrier.',
      'Open memory by default or choose explicit host persistence.',
      'Use Rust-only server, dump, and restore APIs where the app needs them.',
    ],
    icon: Boxes,
  },
  {
    id: 'wasix-typescript',
    title: 'WASIX TypeScript',
    href: '/docs/sdk/wasix-typescript',
    packageName: '@oliphaunt/wasix-ts',
    install: 'pnpm add @oliphaunt/wasix-ts',
    target: 'Cross-origin-isolated browser, Node.js, Bun, and Deno applications',
    startWith: 'Caller-realm execution with memory storage by default; import /worker for isolation',
    owns: 'Browser, Node, Bun, and Deno caller-realm and Worker hosting, bounded pgwire streaming, optional tools, host-specific local servers, selective extensions, and persistence.',
    modes: ['WASIX browser', 'WASIX Node', 'WASIX Bun', 'WASIX Deno', 'WASIX local server'],
    verifyFirst: 'Open memory storage on the chosen execution surface, recover from a SQL error, and close cleanly.',
    guideOutcomes: [
      'Install the same npm package on every host, including Deno.',
      'Run PostgreSQL in the current realm, or import /worker to isolate it, without importing the native TypeScript SDK.',
      'Import only the WASIX extension descriptors the application uses.',
      'Opt into IndexedDB or Node/Bun/Deno directory storage when operation-boundary and clean-close persistence fits the app.',
      'Add the optional tools package everywhere or a local server subpath on Node, Bun, and Deno only when needed.',
    ],
    icon: Braces,
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
      'Build language bindings that expose errors, lifecycle, and backup APIs.',
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
    name: 'direct',
    label: 'Embedded latency',
    href: '/docs/learn/native-runtime',
    useWhen: 'One app database needs the lowest overhead path.',
    boundary: 'One physical PostgreSQL session with serialized work.',
    icon: Database,
  },
  {
    name: 'broker',
    label: 'Desktop isolation',
    href: '/docs/learn/native-runtime',
    useWhen: 'A desktop app needs helper-process ownership, multiple roots, or recovery.',
    boundary: 'Helper process boundary for desktop SDKs.',
    icon: Network,
  },
  {
    name: 'server',
    label: 'Client compatibility',
    href: '/docs/learn/native-runtime',
    useWhen: 'Existing PostgreSQL clients, ORMs, psql, or pg_dump need real sessions.',
    boundary: 'PostgreSQL-compatible process boundary with independent client sessions.',
    icon: Server,
  },
  {
    name: 'wasix-rust',
    label: 'Portable Rust host',
    href: '/docs/sdk/wasix-rust',
    useWhen: 'Rust owns a portable direct or local server host.',
    boundary: 'Rust-specific storage, extensions, archive, server, and dump APIs.',
    icon: Boxes,
  },
  {
    name: 'wasix-typescript',
    label: 'WASIX TypeScript',
    href: '/docs/sdk/wasix-typescript',
    useWhen: 'A browser, Node, Bun, or Deno Worker owns one portable PostgreSQL instance.',
    boundary: 'Memory by default, optional host persistence and tools, Node/Bun/Deno-only local server subpaths, and no native fallback.',
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
