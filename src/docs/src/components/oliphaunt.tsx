import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Database,
  FileSearch,
  Gauge,
  GitBranch,
  HardDriveDownload,
  Layers,
  ListChecks,
  PackageCheck,
  PlayCircle,
  Route,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { runtimeModes, sdkSurfaces } from '@/lib/docs-data';

function SurfaceIcon({ children }: { children: ReactNode }) {
  return (
    <span className="oliphaunt-mdx-icon not-prose inline-flex size-9 items-center justify-center rounded-md border bg-fd-background text-fd-muted-foreground">
      {children}
    </span>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return <code className="oliphaunt-inline-code">{children}</code>;
}

function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <pre className="oliphaunt-code-block">
      <code>{children}</code>
    </pre>
  );
}

function InstallSnippet({ children }: { children: string }) {
  if (/^(add|use)\b/iu.test(children)) {
    return <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{children}</p>;
  }

  return <CodeBlock>{children}</CodeBlock>;
}

export function SdkChooser() {
  return (
    <div className="not-prose my-8 divide-y border-y">
      {sdkSurfaces.map((sdk) => {
        const Icon = sdk.icon;

        return (
          <Link
            key={sdk.title}
            href={sdk.href}
            className="group grid min-w-0 gap-3 py-4 text-fd-card-foreground transition-colors hover:bg-fd-muted/35 sm:grid-cols-[auto_minmax(0,240px)_minmax(0,1fr)_minmax(0,160px)_24px] sm:items-center"
          >
            <SurfaceIcon>
              <Icon className="size-4" />
            </SurfaceIcon>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{sdk.title}</p>
              <div className="mt-1">
                <InlineCode>{sdk.packageName}</InlineCode>
              </div>
            </div>
            <p className="text-sm leading-6 text-fd-muted-foreground">{sdk.target}</p>
            <div className="flex flex-wrap gap-1.5">
              {sdk.modes.map((mode) => (
                <span key={mode} className="oliphaunt-mode-pill">
                  {mode}
                </span>
              ))}
            </div>
            <ArrowRight className="hidden size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground sm:block" />
          </Link>
        );
      })}
    </div>
  );
}

const reactNativeApproaches = [
  {
    approach: 'Expo development build',
    install: 'npx expo install @oliphaunt/react-native',
    nativeBuild: 'Run prebuild, then build iOS or Android.',
    bestFor: 'Expo apps that include native modules, selected extensions, and development tooling.',
    verify: 'Config plugin output, native module loading, JSI ArrayBuffer roundtrip.',
  },
  {
    approach: 'React Native New Architecture app',
    install: 'npm install @oliphaunt/react-native',
    nativeBuild: 'Run CocoaPods and Gradle after package or extension changes.',
    bestFor: 'Existing RN apps that already own native projects and New Architecture builds.',
    verify: 'Autolinking, Codegen, TurboModule availability, platform resource packaging.',
  },
  {
    approach: 'Platform-native app',
    install: 'Use the Swift or Kotlin SDK directly.',
    nativeBuild: 'Build through Xcode or Gradle without the RN package.',
    bestFor: 'iOS, macOS, or Android apps without a React Native JavaScript surface.',
    verify: 'Swift actor or Kotlin coroutine lifecycle, app storage, selected extensions.',
  },
];

export function ReactNativeApproachTable() {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border bg-fd-card">
      <div className="border-b bg-fd-muted/35 p-4">
        <div className="flex items-start gap-3">
          <SurfaceIcon>
            <Layers className="size-4" />
          </SurfaceIcon>
          <div>
            <p className="text-sm font-semibold">Choose the native app path first</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
              Oliphaunt ships native runtime code. The JavaScript bundle can call it only after the
              installed app binary includes the Swift and Kotlin pieces.
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-px bg-fd-border lg:grid-cols-3">
        {reactNativeApproaches.map((row) => (
          <div key={row.approach} className="min-w-0 bg-fd-background p-4">
            <p className="text-sm font-semibold">{row.approach}</p>
            <div className="mt-4">
              <p className="text-[0.68rem] font-medium uppercase text-fd-muted-foreground">
                Install
              </p>
              <InstallSnippet>{row.install}</InstallSnippet>
            </div>
            <div className="mt-4">
              <p className="text-[0.68rem] font-medium uppercase text-fd-muted-foreground">
                Native build
              </p>
              <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{row.nativeBuild}</p>
            </div>
            <div className="mt-4">
              <p className="text-[0.68rem] font-medium uppercase text-fd-muted-foreground">
                Best for
              </p>
              <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{row.bestFor}</p>
            </div>
            <div className="mt-4 border-t pt-4">
              <p className="text-[0.68rem] font-medium uppercase text-fd-muted-foreground">
                Verify first
              </p>
              <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{row.verify}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const learnRoutes = [
  {
    title: 'Embedded PostgreSQL',
    href: '/docs/learn/embedded-postgres',
    question: 'What does my app own on disk?',
    answer: 'Roots, WAL, extensions, lifecycle, backup, and restore live behind SDK APIs.',
    icon: HardDriveDownload,
  },
  {
    title: 'Native Runtime',
    href: '/docs/learn/native-runtime',
    question: 'Which runtime boundary fits my app?',
    answer: 'Direct gives one embedded session, broker adds a helper process, and server gives PostgreSQL client sessions.',
    icon: GitBranch,
  },
  {
    title: 'Mobile Stability',
    href: '/docs/learn/mobile-stability',
    question: 'How does this behave on iOS and Android?',
    answer: 'Mobile direct mode covers app storage, foreground/background transitions, relaunch, and WAL recovery.',
    icon: ShieldCheck,
  },
  {
    title: 'Moving From SQLite',
    href: '/docs/learn/sqlite-upgrade',
    question: 'What changes when I move from one file to PostgreSQL?',
    answer: 'Storage, schema features, extension selection, export/import, and app artifact size change first.',
    icon: Route,
  },
  {
    title: 'Tauri Usage',
    href: '/docs/learn/tauri',
    question: 'Where does the database handle live in a Tauri app?',
    answer: 'Rust state owns Oliphaunt. The webview calls narrow app commands instead of raw runtime handles.',
    icon: BookOpen,
  },
];

export function LearnRouteMap() {
  return (
    <div className="not-prose my-8">
      <div className="grid gap-4 border-y py-4 md:grid-cols-[220px_1fr] md:gap-6">
        <div>
          <p className="text-sm font-semibold">Read by decision</p>
          <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
            Each page answers one production question after the first query works.
          </p>
        </div>
        <div className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <p className="font-medium">Storage</p>
            <p className="mt-1 text-fd-muted-foreground">Root directory, WAL, backup.</p>
          </div>
          <div>
            <p className="font-medium">Runtime</p>
            <p className="mt-1 text-fd-muted-foreground">
              Native modes, Rust WASIX, WASIX TypeScript.
            </p>
          </div>
          <div>
            <p className="font-medium">App fit</p>
            <p className="mt-1 text-fd-muted-foreground">Mobile, Tauri, SQLite migration.</p>
          </div>
        </div>
      </div>
      <div className="mt-4 divide-y border-y">
        {learnRoutes.map((route) => {
          const Icon = route.icon;

          return (
            <Link
              key={route.href}
              href={route.href}
              className="group grid gap-3 py-4 transition-colors hover:bg-fd-muted/35 md:grid-cols-[210px_1fr_1.2fr_24px] md:items-start"
            >
              <div className="flex items-center gap-3">
                <SurfaceIcon>
                  <Icon className="size-4" />
                </SurfaceIcon>
                <p className="text-sm font-semibold">{route.title}</p>
              </div>
              <p className="text-sm leading-6 text-fd-foreground">{route.question}</p>
              <p className="text-sm leading-6 text-fd-muted-foreground">{route.answer}</p>
              <ArrowRight className="hidden size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground md:mt-1 md:block" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

const embeddedModelRows = [
  {
    title: 'Database storage',
    description: 'Temporary storage is the default; applications opt into persistent storage.',
    icon: HardDriveDownload,
  },
  {
    title: 'App-owned lifecycle',
    description:
      'Apps decide when to close and use cancellation or data movement where exposed.',
    icon: Route,
  },
  {
    title: 'Exact extensions',
    description: 'Apps select SQL extension names before packaging or opening the database.',
    icon: ShieldCheck,
  },
  {
    title: 'Runtime family',
    description:
      'Native, Rust WASIX, and WASIX TypeScript products share concepts without claiming API parity.',
    icon: Database,
  },
];

export function EmbeddedPostgresModel() {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border bg-fd-card">
      <div className="grid border-b bg-fd-muted/35 p-4 md:grid-cols-[220px_1fr] md:gap-6">
        <div>
          <p className="text-sm font-semibold">Embedded PostgreSQL model</p>
          <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
            Oliphaunt keeps PostgreSQL behavior and puts app-facing ownership in SDKs.
          </p>
        </div>
        <div className="mt-4 grid gap-2 text-sm md:mt-0 md:grid-cols-2">
          <div className="rounded-md border bg-fd-background p-3">
            <p className="font-medium">Native family</p>
            <p className="mt-1 text-fd-muted-foreground">
              Rust, Swift, Kotlin, React Native, TypeScript, and C ABI over native runtime assets.
            </p>
          </div>
          <div className="rounded-md border bg-fd-background p-3">
            <p className="font-medium">WASIX family</p>
            <p className="mt-1 text-fd-muted-foreground">
              First-class WASIX runtime family with separate assets and documented support.
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-px bg-fd-border md:grid-cols-2 xl:grid-cols-4">
        {embeddedModelRows.map((row) => {
          const Icon = row.icon;

          return (
            <div key={row.title} className="bg-fd-background p-4">
              <SurfaceIcon>
                <Icon className="size-4" />
              </SurfaceIcon>
              <p className="mt-4 text-sm font-semibold">{row.title}</p>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{row.description}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const mobileContractRows = [
  {
    title: 'One resident backend',
    description: 'Mobile direct mode owns one embedded PostgreSQL backend in the app process.',
  },
  {
    title: 'Serialized work',
    description:
      'Concurrent app tasks share one physical session on a native owner, away from UI and JavaScript threads.',
  },
  {
    title: 'WAL recovery',
    description: 'After process exit, the next launch reopens persistent storage and PostgreSQL recovers it.',
  },
  {
    title: 'Platform lifecycle',
    description:
      'Apps use explicit cancellation and async close where their platform lifecycle requires them.',
  },
];

export function MobileStabilityContract() {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border bg-fd-card">
      <div className="border-b bg-fd-muted/35 p-4">
        <p className="text-sm font-semibold">Mobile direct-mode contract</p>
        <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
          Use this model for the iOS, Android, and React Native product boundaries.
        </p>
      </div>
      <div className="grid gap-px bg-fd-border md:grid-cols-2 xl:grid-cols-4">
        {mobileContractRows.map((row) => (
          <div key={row.title} className="bg-fd-background p-4">
            <CheckCircle2 className="mb-3 size-4 text-fd-primary" />
            <p className="text-sm font-semibold">{row.title}</p>
            <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{row.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const sqliteMigrationRows = [
  {
    sqlite: 'One database file',
    oliphaunt: 'SDK-managed PostgreSQL storage',
    action: 'Move data movement to SDK backup and restore APIs.',
  },
  {
    sqlite: 'Pragmas',
    oliphaunt: 'PostgreSQL startup settings',
    action: 'Pass the PostgreSQL startup GUCs required by the application.',
  },
  {
    sqlite: 'SQLite extensions',
    oliphaunt: 'Exact PostgreSQL extension names',
    action: 'Select extensions before opening and verify package contents.',
  },
  {
    sqlite: 'Multiple library handles',
    oliphaunt: 'Database sessions or the native server product',
    action: 'Use the native server when independent PostgreSQL clients are required.',
  },
];

export function SqliteMigrationMap() {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border bg-fd-card">
      <div className="border-b bg-fd-muted/35 p-4">
        <p className="text-sm font-semibold">Migration map</p>
        <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
          Start by replacing SQLite assumptions with PostgreSQL and SDK-owned app boundaries.
        </p>
      </div>
      <div className="divide-y md:hidden">
        {sqliteMigrationRows.map((row) => (
          <div key={row.sqlite} className="bg-fd-background p-4">
            <p className="text-xs font-medium uppercase text-fd-muted-foreground">
              SQLite assumption
            </p>
            <p className="mt-1 text-sm font-semibold">{row.sqlite}</p>
            <p className="mt-4 text-xs font-medium uppercase text-fd-muted-foreground">
              Oliphaunt model
            </p>
            <p className="mt-1 text-sm">{row.oliphaunt}</p>
            <p className="mt-4 text-xs font-medium uppercase text-fd-muted-foreground">
              Migration action
            </p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{row.action}</p>
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b bg-fd-muted/45">
              <th className="px-4 py-3 font-semibold">SQLite assumption</th>
              <th className="px-4 py-3 font-semibold">Oliphaunt model</th>
              <th className="px-4 py-3 font-semibold">Migration action</th>
            </tr>
          </thead>
          <tbody>
            {sqliteMigrationRows.map((row) => (
              <tr key={row.sqlite} className="border-b last:border-b-0">
                <td className="px-4 py-3 font-medium">{row.sqlite}</td>
                <td className="px-4 py-3">{row.oliphaunt}</td>
                <td className="px-4 py-3 text-fd-muted-foreground">{row.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const referenceRows = [
  {
    need: 'Choose an SDK package',
    answer: 'Compare package names, app targets, runtime owners, and first verification steps.',
    href: '/docs/reference/sdk-products',
    label: 'SDKs And Platforms',
    icon: ListChecks,
  },
  {
    need: 'Choose runtime support',
    answer: 'Compare direct, broker, server, backup, restore, tools, and client-session support.',
    href: '/docs/reference/capabilities',
    label: 'Runtime Support',
    icon: FileSearch,
  },
  {
    need: 'Ship one extension',
    answer: 'Select exact SQL extension names and verify the app artifact contains only selected files.',
    href: '/docs/reference/extensions',
    label: 'Extensions',
    icon: ShieldCheck,
  },
  {
    need: 'Look up exact extension support',
    answer: 'Use the generated catalog for extension status, dependencies, and runtime availability.',
    href: '/docs/reference/extension-catalog',
    label: 'Extension Catalog',
    icon: FileSearch,
  },
  {
    need: 'Read performance claims',
    answer: 'Use the measurement guide for latency, throughput, package size, memory, and comparison scope.',
    href: '/docs/reference/performance',
    label: 'Performance',
    icon: Gauge,
  },
  {
    need: 'Update an installed app',
    answer: 'Match SDK versions, runtime artifacts, selected extensions, docs versions, and release notes.',
    href: '/docs/reference/releases',
    label: 'Releases',
    icon: PackageCheck,
  },
  {
    need: 'Match versions',
    answer: 'Use the generated version matrix for product compatibility and release contents.',
    href: '/docs/reference/version-matrix',
    label: 'Version Matrix',
    icon: GitBranch,
  },
  {
    need: 'Find language API details',
    answer: 'Use each SDK API map for open, query, lifecycle, extensions, and backup calls.',
    href: '/docs/reference/api-reference',
    label: 'API Reference',
    icon: BookOpen,
  },
];

export function ReferenceLookup() {
  return (
    <div className="not-prose my-8">
      <div className="border-y py-4">
        <div className="flex items-start gap-3">
          <SurfaceIcon>
            <FileSearch className="size-4" />
          </SurfaceIcon>
          <div>
            <p className="text-sm font-semibold">Use Reference as a lookup surface</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
              These pages answer specific product questions. Start with the question, then open the
              smallest page that gives the exact answer.
            </p>
          </div>
        </div>
      </div>
      <div className="divide-y border-b">
        {referenceRows.map((row) => {
          const Icon = row.icon;

          return (
            <Link
              key={row.href}
              href={row.href}
              className="group grid gap-4 py-4 transition-colors hover:bg-fd-muted/35 md:grid-cols-[210px_1fr_180px_24px] md:items-start"
            >
              <div className="flex items-center gap-3">
                <SurfaceIcon>
                  <Icon className="size-4" />
                </SurfaceIcon>
                <p className="text-sm font-semibold">{row.need}</p>
              </div>
              <p className="text-sm leading-6 text-fd-muted-foreground">{row.answer}</p>
              <p className="text-sm font-medium text-fd-foreground">{row.label}</p>
              <ArrowRight className="hidden size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground md:mt-1 md:block" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

const releaseLookupRows = [
  {
    question: 'Which package version fits my app?',
    answer: 'Start with the SDK package, then check the runtime dependency it carries.',
    href: '/docs/reference/version-matrix',
    label: 'Version Matrix',
    icon: PackageCheck,
  },
  {
    question: 'Which compatibility updates move together?',
    answer:
      'Runtime changes can select dependent SDK releases, but every SDK keeps its own SemVer.',
    href: '/docs/reference/sdk-products',
    label: 'SDKs And Platforms',
    icon: GitBranch,
  },
  {
    question: 'Which extensions can this release ship?',
    answer: 'Check extension availability by SQL extension name and target runtime.',
    href: '/docs/reference/extension-catalog',
    label: 'Extension Catalog',
    icon: FileSearch,
  },
  {
    question: 'Did performance or package size change?',
    answer: 'Read release measurements by workload, target hardware, and selected extensions.',
    href: '/docs/reference/performance',
    label: 'Performance',
    icon: Gauge,
  },
];

export function ReleaseLookup() {
  return (
    <div className="not-prose my-8">
      <div className="border-y py-4">
        <div className="flex items-start gap-3">
          <SurfaceIcon>
            <PackageCheck className="size-4" />
          </SurfaceIcon>
          <div>
            <p className="text-sm font-semibold">Read releases by the app artifact you ship</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
              Match the SDK package, runtime artifacts, selected extensions, and performance notes
              before updating an installed app.
            </p>
          </div>
        </div>
      </div>
      <div className="divide-y border-b">
        {releaseLookupRows.map((row) => {
          const Icon = row.icon;

          return (
            <Link
              key={row.href}
              href={row.href}
              className="group grid gap-4 py-4 transition-colors hover:bg-fd-muted/35 md:grid-cols-[250px_1fr_170px_24px] md:items-start"
            >
              <div className="flex items-center gap-3">
                <SurfaceIcon>
                  <Icon className="size-4" />
                </SurfaceIcon>
                <p className="text-sm font-semibold">{row.question}</p>
              </div>
              <p className="text-sm leading-6 text-fd-muted-foreground">{row.answer}</p>
              <p className="text-sm font-medium text-fd-foreground">{row.label}</p>
              <ArrowRight className="hidden size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground md:mt-1 md:block" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

const capabilityCards = [
  {
    title: 'Native runtime modes',
    value: 'direct / broker / server',
    description: 'The support matrix documents which native engines and workflows each SDK ships.',
    icon: Database,
  },
  {
    title: 'Rust WASIX',
    value: 'Rust host API',
    description: 'The Rust binding owns WASIX direct/server hosting, archives, and optional tools.',
    icon: GitBranch,
  },
  {
    title: 'WASIX TypeScript',
    value: 'portable host API',
    description:
      'The browser and Node/Bun/Deno/Electron binding has actor, direct, and Worker placements, bounded protocol streaming, optional tools, and a host-only local server subpath.',
    icon: ListChecks,
  },
  {
    title: 'Extension artifacts',
    value: 'exact selection',
    description: 'Each SDK uses its native selector shape while packaging only requested payloads.',
    icon: ShieldCheck,
  },
];

export function CapabilitySnapshot() {
  return (
    <div className="not-prose my-8">
      <div className="border-y py-4">
        <div className="flex items-start gap-3">
          <SurfaceIcon>
            <FileSearch className="size-4" />
          </SurfaceIcon>
          <div>
            <p className="text-sm font-semibold">Match features to the selected product</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
              The static matrix records deliberate runtime differences. Public SDKs expose operations
              directly instead of mirroring documentation as capability objects.
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-5 border-b py-4 md:grid-cols-2 xl:grid-cols-4">
        {capabilityCards.map((card) => {
          const Icon = card.icon;

          return (
            <div key={card.title} className="flex gap-3">
              <SurfaceIcon>
                <Icon className="size-4" />
              </SurfaceIcon>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{card.title}</p>
                <div className="mt-2">
                  <InlineCode>{card.value}</InlineCode>
                </div>
                <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
                  {card.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const extensionFlow = [
  {
    title: 'Select exact extensions',
    description: (
      <>
        Use the native SDK's SQL-name form, Rust WASIX typed values, or imported WASIX TypeScript
        descriptors.
      </>
    ),
  },
  {
    title: 'Resolve dependencies',
    description: 'Include only dependencies declared by the selected extension metadata.',
  },
  {
    title: 'Package artifacts',
    description:
      'Swift, Kotlin, React Native, desktop, and WASIX tooling package target artifacts.',
  },
  {
    title: 'Verify the app',
    description: 'Inspect selected names, included files, dependency files, target, and built artifact cost.',
  },
];

export function ExtensionArtifactFlow() {
  return (
    <div className="not-prose my-8">
      <div className="border-y py-4">
        <p className="text-sm font-semibold">Extension packaging flow</p>
        <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
          Each product uses an ecosystem-native selector. Build tooling handles exact target
          carriers and dependency metadata.
        </p>
      </div>
      <ol className="grid gap-5 border-b py-4 md:grid-cols-4">
        {extensionFlow.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span className="inline-flex size-7 items-center justify-center rounded-full border bg-fd-muted text-xs font-semibold text-fd-muted-foreground">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{step.title}</p>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
                {step.description}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const performanceResults = [
  {
    title: 'Open path',
    metrics: 'cold open, warm open, first query',
    description: 'Use these numbers for startup and resume behavior.',
  },
  {
    title: 'Interactive work',
    metrics: 'simple query p50, p90, p99',
    description: 'Use these numbers for UI reads, writes, and short transactions.',
  },
  {
    title: 'Bulk work',
    metrics: 'batched insert, update, import',
    description: 'Use these numbers for sync, preload, and local cache hydration.',
  },
  {
    title: 'Large reads',
    metrics: 'first bytes, total bytes, total time',
    description: 'Use these numbers for reports, exports, and sync scans.',
  },
  {
    title: 'Footprint',
    metrics: 'RSS, CPU, artifact size',
    description: 'Use these numbers when mobile package size or desktop memory matters.',
  },
  {
    title: 'Data movement',
    metrics: 'backup, restore, dump',
    description: 'Use these numbers for user-visible export, import, and support flows.',
  },
];

export function PerformanceResultsGrid() {
  return (
    <div className="not-prose my-8">
      <div className="border-y py-4">
        <div className="flex items-start gap-3">
          <SurfaceIcon>
            <Gauge className="size-4" />
          </SurfaceIcon>
          <div>
            <p className="text-sm font-semibold">Use performance results by workload</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
              A useful report names the app workload, runtime mode, selected extensions, target
              hardware, and collection method.
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-5 border-b py-4 md:grid-cols-2 xl:grid-cols-3">
        {performanceResults.map((item) => (
          <div key={item.title}>
            <p className="text-sm font-semibold">{item.title}</p>
            <div className="mt-2">
              <InlineCode>{item.metrics}</InlineCode>
            </div>
            <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">{item.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const tauriModeCards = [
  {
    title: 'App commands own calls',
    value: '.direct()',
    description: 'Use Rust state when Tauri commands own one app database and latency matters.',
    icon: Database,
  },
  {
    title: 'Helper owns instances',
    value: '.broker()',
    description: 'Use a broker when a desktop app wants process ownership or multiple instances.',
    icon: GitBranch,
  },
  {
    title: 'Clients need a URL',
    value: 'OliphauntServer::builder().start()',
    description: (
      <>
        Use server mode for pools, ORMs, <code>psql</code>, <code>pg_dump</code>, and
        independent sessions.
      </>
    ),
    icon: Route,
  },
];

export function TauriAppPattern() {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border bg-fd-card">
      <div className="border-b bg-fd-muted/35 p-4">
        <div className="flex items-start gap-3">
          <SurfaceIcon>
            <BookOpen className="size-4" />
          </SurfaceIcon>
          <div>
            <p className="text-sm font-semibold">Keep PostgreSQL ownership in Rust state</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
              The webview calls app commands. Rust owns the database handle, storage,
              lifecycle, extension selection, and backup APIs.
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-px bg-fd-border md:grid-cols-3">
        {tauriModeCards.map((card) => {
          const Icon = card.icon;

          return (
            <div key={card.title} className="bg-fd-background p-4">
              <SurfaceIcon>
                <Icon className="size-4" />
              </SurfaceIcon>
              <p className="mt-4 text-sm font-semibold">{card.title}</p>
              <div className="mt-2">
                <InlineCode>{card.value}</InlineCode>
              </div>
              <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
                {card.description}
              </p>
            </div>
          );
        })}
      </div>
      <div className="grid gap-3 border-t p-4 md:grid-cols-3">
        {[
          {
            key: 'commands',
            label: (
              <>
              Expose narrow commands such as <code>add_item</code> or <code>search_items</code>.
              </>
            ),
          },
          { key: 'roots', label: 'Keep roots, locks, and handles out of the webview.' },
          { key: 'backup', label: 'Use SDK backup and restore APIs for app import/export.' },
        ].map((item) => (
          <div key={item.key} className="flex gap-2 text-sm leading-6">
            <CheckCircle2 className="mt-1 size-4 shrink-0 text-fd-primary" />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const reactNativeBoundaryRows = [
  {
    layer: 'TypeScript',
    owns: 'API shape, handles, typed results, config plugin options, and lifecycle calls.',
    transport: 'TurboModule for small calls; JSI ArrayBuffer for protocol bytes and chunks.',
  },
  {
    layer: 'Swift',
    owns: 'Apple runtime resources, app storage, lifecycle, backup, and restore.',
    transport: 'Actor-owned native direct database handle on iOS and macOS targets.',
  },
  {
    layer: 'Kotlin',
    owns: 'Android resources, ABI artifact selection, coroutine lifecycle, backup, and restore.',
    transport: 'Android facade over the Kotlin SDK database handle.',
  },
];

export function ReactNativeBoundaryMap() {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border bg-fd-card">
      <div className="border-b bg-fd-muted/35 p-4">
        <div className="flex items-start gap-3">
          <SurfaceIcon>
            <Route className="size-4" />
          </SurfaceIcon>
          <div>
            <p className="text-sm font-semibold">React Native owns the JS boundary</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
              Platform runtime behavior flows through Swift on Apple targets and Kotlin on
              Android. JavaScript gets one consistent SDK surface over those native handles.
            </p>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b bg-fd-muted/45">
              <th className="px-4 py-3 font-semibold">Layer</th>
              <th className="px-4 py-3 font-semibold">Owns</th>
              <th className="px-4 py-3 font-semibold">Boundary</th>
            </tr>
          </thead>
          <tbody>
            {reactNativeBoundaryRows.map((row) => (
              <tr key={row.layer} className="border-b last:border-b-0">
                <td className="px-4 py-3 font-medium">{row.layer}</td>
                <td className="px-4 py-3 text-fd-muted-foreground">{row.owns}</td>
                <td className="px-4 py-3 text-fd-muted-foreground">{row.transport}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 border-t p-4 md:grid-cols-3">
        {[
          'Use high-level query helpers for app code.',
          'Use buffered raw protocol bytes for adapters that need PostgreSQL wire messages.',
          'Use the static support matrix before enabling platform-specific UI.',
        ].map((item) => (
          <div key={item} className="flex gap-2 text-sm leading-6">
            <CheckCircle2 className="mt-1 size-4 shrink-0 text-fd-primary" />
            <span>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const wasmRuntimeCards = [
  {
    title: 'Direct Rust API',
    value: 'Oliphaunt',
    description: 'Use direct calls when Rust code owns SQL work inside the WASIX host.',
    icon: Database,
  },
  {
    title: 'PostgreSQL URL',
    value: 'OliphauntServer',
    description: 'Use server-compatible mode when a library expects a local PostgreSQL endpoint.',
    icon: Route,
  },
  {
    title: 'Runtime assets',
    value: 'WASIX',
    description: 'Package the WASIX runtime assets and exact extension files selected by the app.',
    icon: PackageCheck,
  },
  {
    title: 'Data movement',
    value: 'dump / restore',
    description: 'Use logical dumps for portable exports and upgrades between runtime versions.',
    icon: HardDriveDownload,
  },
];

export function WasmRuntimeMap() {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border bg-fd-card">
      <div className="border-b bg-fd-muted/35 p-4">
        <div className="flex items-start gap-3">
          <SurfaceIcon>
            <PackageCheck className="size-4" />
          </SurfaceIcon>
          <div>
            <p className="text-sm font-semibold">Use WASIX as its own runtime family</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
              The Rust WASIX binding packages its own runtime assets, host targets, storage
              behavior, and extension artifacts. These are not native SDK modes.
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-px bg-fd-border md:grid-cols-2 xl:grid-cols-4">
        {wasmRuntimeCards.map((card) => {
          const Icon = card.icon;

          return (
            <div key={card.title} className="bg-fd-background p-4">
              <SurfaceIcon>
                <Icon className="size-4" />
              </SurfaceIcon>
              <p className="mt-4 text-sm font-semibold">{card.title}</p>
              <div className="mt-2">
                <InlineCode>{card.value}</InlineCode>
              </div>
              <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
                {card.description}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const wasmDataMovementRows = [
  {
    format: 'Logical dump',
    use: 'Portable SQL export, version upgrade, runtime-to-runtime movement.',
    api: 'database.pg_dump(options), database.psql(options), CLI',
  },
  {
    format: 'Physical archive',
    use: 'Same-version backup or restore for a Rust WASIX store.',
    api: 'backup, Oliphaunt::restore',
  },
];

export function WasmDataMovement() {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border bg-fd-card">
      <div className="border-b bg-fd-muted/35 p-4">
        <div className="flex items-start gap-3">
          <SurfaceIcon>
            <HardDriveDownload className="size-4" />
          </SurfaceIcon>
          <div>
            <p className="text-sm font-semibold">Choose the export format by destination</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
              Logical dumps move across runtime versions. Physical backup archives are fast for the
              same runtime family and database format.
            </p>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b bg-fd-muted/45">
              <th className="px-4 py-3 font-semibold">Format</th>
              <th className="px-4 py-3 font-semibold">Use it for</th>
              <th className="px-4 py-3 font-semibold">API</th>
            </tr>
          </thead>
          <tbody>
            {wasmDataMovementRows.map((row) => (
              <tr key={row.format} className="border-b last:border-b-0">
                <td className="px-4 py-3 font-medium">{row.format}</td>
                <td className="px-4 py-3 text-fd-muted-foreground">{row.use}</td>
                <td className="px-4 py-3">
                  <InlineCode>{row.api}</InlineCode>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SdkGuideSummary({ id }: { id: string }) {
  const sdk = sdkSurfaces.find((surface) => surface.id === id);

  if (!sdk) {
    return null;
  }

  const Icon = sdk.icon;

  return (
    <div className="not-prose my-8">
      <div className="flex flex-col gap-4 border-y py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <SurfaceIcon>
            <Icon className="size-4" />
          </SurfaceIcon>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{sdk.title} setup path</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{sdk.startWith}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <InlineCode>{sdk.packageName}</InlineCode>
          <div className="flex flex-wrap gap-1.5 sm:justify-end">
            {sdk.modes.map((mode) => (
              <span key={mode} className="oliphaunt-mode-pill">
                {mode}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="grid gap-5 border-b py-4 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <p className="text-xs font-medium uppercase text-fd-muted-foreground">Install</p>
          <InstallSnippet>{sdk.install}</InstallSnippet>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-fd-muted-foreground">Target</p>
          <p className="mt-2 text-sm leading-6">{sdk.target}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-fd-muted-foreground">SDK owns</p>
          <p className="mt-2 text-sm leading-6">{sdk.owns}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-fd-muted-foreground">Verify first</p>
          <p className="mt-2 text-sm leading-6">{sdk.verifyFirst}</p>
        </div>
      </div>
      <div className="grid gap-3 py-4 md:grid-cols-3">
        {sdk.guideOutcomes.map((outcome) => (
          <div key={outcome} className="flex gap-2 text-sm leading-6">
            <CheckCircle2 className="mt-1 size-4 shrink-0 text-fd-primary" />
            <span>{outcome}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const guideProofs: Record<string, Array<{ title: string; description: string }>> = {
  'c-abi': [
    {
      title: 'Handle lifecycle',
      description: 'A binding can open an opaque handle, send protocol bytes, free responses, and close cleanly.',
    },
    {
      title: 'Ownership',
      description: 'The binding exposes response ownership, last-error reads, and close state directly.',
    },
    {
      title: 'Runtime assets',
      description: 'The app carries only the native runtime and exact extension artifacts selected by the binding.',
    },
    {
      title: 'Language surface',
      description: 'The public wrapper uses platform-native async, errors, and buffers over the C ABI.',
    },
  ],
  rust: [
    {
      title: 'First query',
      description: 'A Rust or Tauri app opens app-owned storage and runs a query through the chosen mode.',
    },
    {
      title: 'Mode choice',
      description: 'Direct, broker, and server paths are chosen through builder configuration.',
    },
    {
      title: 'Data movement',
      description: 'Use SDK backup/restore where available and packaged PostgreSQL tools for server data movement.',
    },
    {
      title: 'App boundary',
      description: 'Tauri webviews call narrow Rust commands instead of owning database storage or raw handles.',
    },
  ],
  swift: [
    {
      title: 'First query',
      description: 'An iOS or macOS target opens from app storage and runs a query off the main actor.',
    },
    {
      title: 'Lifecycle',
      description: 'The app decides when platform state requires cancellation or close.',
    },
    {
      title: 'Resources',
      description: 'The Apple package carries the native runtime and only selected extension artifacts.',
    },
    {
      title: 'Concurrency',
      description: 'Swift tasks share the actor-owned database handle and preserve transaction ordering.',
    },
  ],
  kotlin: [
    {
      title: 'First query',
      description: 'An Android app opens from app-private storage and runs a query from coroutine code.',
    },
    {
      title: 'Packaging',
      description: 'The Gradle plugin resolves ABI assets, native libraries, and selected extension resources.',
    },
    {
      title: 'Lifecycle',
      description: 'The app calls cancellation and close when Android lifecycle state requires them.',
    },
    {
      title: 'App artifact',
      description: 'The APK or AAB contains selected extension files and their declared dependencies only.',
    },
  ],
  'react-native': [
    {
      title: 'Native app binary',
      description: 'The app runs in an Expo development build or React Native New Architecture binary.',
    },
    {
      title: 'Binary transport',
      description: 'Buffered raw protocol bytes move through JSI ArrayBuffer paths.',
    },
    {
      title: 'Platform delegation',
      description: 'Apple behavior flows through Swift, Android behavior flows through Kotlin, and JS owns DX.',
    },
    {
      title: 'Config output',
      description: 'The config plugin selects exact extensions and native runtime assets for the app artifact.',
    },
  ],
  typescript: [
    {
      title: 'Runtime resolver',
      description: 'Node, Bun, or Deno resolves helper assets from the installed package.',
    },
    {
      title: 'Mode connection',
      description: 'The app connects to broker or server mode where the selected runtime advertises it.',
    },
    {
      title: 'Query shape',
      description: 'High-level query helpers and buffered raw protocol APIs share one error model.',
    },
    {
      title: 'Desktop packaging',
      description: 'The app packages helper executables, selected extensions, and backup/restore flows together.',
    },
  ],
  'wasix-rust': [
    {
      title: 'Runtime assets',
      description: 'A WASIX host loads runtime assets before opening database storage.',
    },
    {
      title: 'First query',
      description: 'The app opens WASIX storage and runs SQL through the portable runtime.',
    },
    {
      title: 'Data movement',
      description: 'Dump, restore, and upgrade flows use the WASIX tooling documented for that runtime.',
    },
    {
      title: 'Runtime family',
      description: 'The app treats WASIX as its own runtime family with separate assets and build rules.',
    },
  ],
  'wasix-typescript': [
    {
      title: 'First query',
      description: 'The selected entrypoint opens memory by default and runs SQL through the portable runtime.',
    },
    {
      title: 'Execution placement',
      description: 'Browser root runs in the importing realm; the native-host root uses a Rust actor, /direct selects the importing thread, and /worker selects a package-owned Worker.',
    },
    {
      title: 'Persistence',
      description: 'A selectively imported provider publishes changes at PostgreSQL-safe boundaries.',
    },
    {
      title: 'Data movement',
      description: 'Physical archives restore same-format storage; optional pg_dump and psql provide portable logical SQL.',
    },
  ],
};

export function SdkGuideProof({ id }: { id: string }) {
  const sdk = sdkSurfaces.find((surface) => surface.id === id);
  const checks = guideProofs[id];

  if (!sdk || !checks) {
    return null;
  }

  return (
    <div className="not-prose my-8">
      <div className="border-y py-4">
        <p className="text-sm font-semibold">This guide is complete when</p>
        <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
          Use these checks before moving from a first query to application code.
        </p>
      </div>
      <div className="grid gap-4 border-b py-4 md:grid-cols-2 xl:grid-cols-4">
        {checks.map((check) => (
          <div key={check.title} className="flex gap-3">
            <CheckCircle2 className="mt-1 size-4 shrink-0 text-fd-primary" />
            <div>
              <p className="text-sm font-semibold">{check.title}</p>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
                {check.description}
              </p>
            </div>
          </div>
        ))}
      </div>
      <Link
        href={`${sdk.href}/api-reference`}
        className="group inline-flex items-center gap-2 py-4 text-sm font-medium text-fd-foreground"
      >
        Open the {sdk.title} API map
        <ArrowRight className="size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground" />
      </Link>
    </div>
  );
}

export function SdkLanding({ id }: { id: string }) {
  const sdk = sdkSurfaces.find((surface) => surface.id === id);

  if (!sdk) {
    return null;
  }

  const Icon = sdk.icon;
  const guideHref = `${sdk.href}/guide`;
  const apiHref = `${sdk.href}/api-reference`;
  const extraHref = id === 'react-native' ? `${sdk.href}/architecture` : undefined;

  return (
    <div className="not-prose my-8">
      <div className="grid gap-6 border-y py-4 md:grid-cols-[1.25fr_0.75fr]">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <SurfaceIcon>
              <Icon className="size-4" />
            </SurfaceIcon>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{sdk.title} at a glance</p>
              <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{sdk.target}</p>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6">{sdk.startWith}</p>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-fd-muted-foreground">Install</p>
          <InstallSnippet>{sdk.install}</InstallSnippet>
          <div className="mt-2">
            <InlineCode>{sdk.packageName}</InlineCode>
          </div>
        </div>
      </div>
      <div className="grid gap-5 border-b py-4 md:grid-cols-3">
        <div>
          <p className="text-xs font-medium uppercase text-fd-muted-foreground">SDK owns</p>
          <p className="mt-2 text-sm leading-6">{sdk.owns}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-fd-muted-foreground">Modes</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {sdk.modes.map((mode) => (
              <span key={mode} className="oliphaunt-mode-pill">
                {mode}
              </span>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-fd-muted-foreground">Verify first</p>
          <p className="mt-2 text-sm leading-6">{sdk.verifyFirst}</p>
        </div>
      </div>
      <div className="divide-y border-b">
        {[
          {
            href: guideHref,
            title: 'Build guide',
            description: 'Install, open, configure, select extensions, and verify lifecycle.',
          },
          {
            href: apiHref,
            title: 'API map',
            description: 'Find the public surface for open, query, lifecycle, and backup.',
          },
          {
            href: extraHref ?? '/docs/reference/capabilities',
            title: extraHref ? 'Architecture' : 'Runtime support',
            description: extraHref
              ? 'Understand the React Native, Swift, Kotlin, TurboModule, and JSI boundary.'
              : 'Compare mode, extension, backup, restore, tools, and client-session support.',
          },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="group grid gap-2 py-4 transition-colors hover:bg-fd-muted/35 sm:grid-cols-[180px_1fr_24px]"
          >
            <p className="text-sm font-semibold">{item.title}</p>
            <p className="text-sm leading-6 text-fd-muted-foreground">{item.description}</p>
            <ArrowRight className="hidden size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground sm:mt-1 sm:block" />
          </Link>
        ))}
      </div>
    </div>
  );
}

export function QuickstartPath() {
  const steps = [
    {
      title: 'Pick the SDK',
      description:
        'Choose a native SDK, Rust WASIX, WASIX TypeScript, or the C ABI.',
    },
    {
      title: 'Install through the platform tool',
      description: 'Use Cargo, SwiftPM/Xcode, Gradle, npm, Expo, or the released C artifacts. Native apps rebuild when runtime assets or selected extensions change.',
    },
    {
      title: 'Choose database storage',
      description: 'Use the zero-configuration temporary default or select persistent app storage for user data.',
    },
    {
      title: 'Run SQL and verify the runtime',
      description: (
        <>
          Run <code>SELECT 1</code> and create only the extensions selected for the app
          artifact.
        </>
      ),
    },
  ];

  return (
    <div className="not-prose my-8">
      <div className="border-y py-4">
        <div className="flex items-start gap-3">
          <PlayCircle className="size-5 text-fd-primary" />
          <div>
            <p className="text-sm font-semibold">Start in one app target</p>
            <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
              The first path is short: install, open, query, verify, then use the platform page for
              lifecycle, packaging, and data movement.
            </p>
          </div>
        </div>
      </div>
      <ol className="divide-y border-b">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className="grid gap-3 py-4 sm:grid-cols-[3rem_minmax(0,190px)_minmax(0,1fr)]"
          >
            <span className="text-xs font-medium text-fd-muted-foreground">
              {String(index + 1).padStart(2, '0')}
            </span>
            <p className="text-sm font-semibold">{step.title}</p>
            <p className="text-sm leading-6 text-fd-muted-foreground">{step.description}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function StartOutcome() {
  const outcomes = [
    {
      title: 'One SDK selected',
      description: 'You have the package, runtime artifacts, and build path for the app users install.',
      icon: PackageCheck,
    },
    {
      title: 'One database opened',
      description: 'The database uses the selected storage and SDK lifecycle APIs.',
      icon: HardDriveDownload,
    },
    {
      title: 'One query verified',
      description: (
        <>
          <code>SELECT 1</code> and selected extensions prove the runtime path.
        </>
      ),
      icon: ClipboardCheck,
    },
    {
      title: 'One next page',
      description: 'You move to the platform guide, runtime model, extensions, or performance lookup.',
      icon: Route,
    },
  ];

  return (
    <div className="oliphaunt-mdx-panel not-prose my-6 rounded-lg border bg-fd-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Finish this page with a working app path</p>
          <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
            Start proves one target. Platform guides handle deeper app wiring after that.
          </p>
        </div>
        <span className="inline-flex w-fit rounded border bg-fd-muted px-2 py-1 text-xs font-medium text-fd-muted-foreground">
          Tutorial
        </span>
      </div>
      <ul className="mt-4 grid gap-px overflow-hidden rounded-md border bg-fd-border md:grid-cols-2 xl:grid-cols-4">
        {outcomes.map((outcome) => {
          const Icon = outcome.icon;

          return (
            <li key={outcome.title} className="flex min-w-0 gap-3 bg-fd-background p-3">
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border bg-fd-card text-fd-muted-foreground">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{outcome.title}</p>
                <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
                  {outcome.description}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const firstQueryExamples = [
  {
    language: 'TypeScript',
    packageName: '@oliphaunt/ts',
    code: `const db = await Oliphaunt.open({
  storage: { kind: 'directory', path: 'main.oliphaunt' },
  extensions: ['vector'],
});

const rows = await db.query('select 1 as ready');
await db.close();`,
  },
  {
    language: 'Rust',
    packageName: 'oliphaunt',
    code: `let mut db = Oliphaunt::builder()
    .storage(DatabaseStorage::Directory("main.oliphaunt".into()))
    .direct()
    .extension(Extension::VECTOR)
    .open()?;

db.query("select 1 as ready")?;
db.close()?;`,
  },
  {
    language: 'Swift',
    packageName: 'Oliphaunt',
    code: `let db = try await OliphauntDatabase.open(
  configuration: OliphauntConfiguration(
    storage: .directory(appStorage.appending(path: "main.oliphaunt")),
    extensions: ["vector"]
  )
)

try await db.query("select 1 as ready")
try await db.close()`,
  },
];

export function FirstQueryFlow() {
  return (
    <div className="oliphaunt-first-query not-prose my-8">
      <div className="grid gap-4 border-y py-4 md:grid-cols-[210px_1fr]">
        <div>
          <p className="text-sm font-semibold">First query shape</p>
          <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
            The same storage, extension, query, and lifecycle concepts in ecosystem-native syntax.
          </p>
        </div>
        <ol className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
          {['Product', 'Storage', 'Extensions', 'Query', 'Close'].map((item, index) => (
            <li key={item}>
              <span className="text-xs font-medium text-fd-muted-foreground">
                {String(index + 1).padStart(2, '0')}
              </span>
              <p className="mt-1 font-medium">{item}</p>
            </li>
          ))}
        </ol>
      </div>
      <div className="divide-y border-b">
        {firstQueryExamples.map((example) => (
          <div
            key={example.language}
            className="oliphaunt-query-example grid gap-3 py-5 md:grid-cols-[170px_minmax(0,1fr)]"
          >
            <div className="min-w-0">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{example.language}</p>
                <div className="mt-1">
                  <InlineCode>{example.packageName}</InlineCode>
                </div>
              </div>
            </div>
            <pre className="oliphaunt-code-block mt-0">
              <code>{example.code}</code>
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

const startNextSteps = [
  {
    title: 'Choose the platform guide',
    description: 'Install, build, query, lifecycle, extensions, backup, and troubleshooting for one SDK.',
    href: '/docs/sdk',
    label: 'SDKs',
    icon: PackageCheck,
  },
  {
    title: 'Understand runtime modes',
    description:
      'Compare native direct/broker/server with the separate Rust and WASIX TypeScript hosts.',
    href: '/docs/reference/capabilities',
    label: 'Runtime support',
    icon: GitBranch,
  },
  {
    title: 'Select extensions exactly',
    description: 'Choose SQL extension names and verify only selected files enter the app artifact.',
    href: '/docs/reference/extensions',
    label: 'Extensions',
    icon: ShieldCheck,
  },
  {
    title: 'Plan storage and backup',
    description: 'Use explicit persistent storage, lifecycle APIs, backup, restore, and recovery behavior.',
    href: '/docs/learn/embedded-postgres',
    label: 'Embedded PostgreSQL',
    icon: HardDriveDownload,
  },
];

export function StartNextSteps() {
  return (
    <div className="not-prose my-8 divide-y border-y">
      {startNextSteps.map((step) => {
        const Icon = step.icon;

        return (
          <Link
            key={step.href}
            href={step.href}
            className="group grid min-w-0 gap-3 py-4 transition-colors hover:bg-fd-muted/35 sm:grid-cols-[auto_150px_minmax(0,1fr)_24px] sm:items-start"
          >
            <SurfaceIcon>
              <Icon className="size-4" />
            </SurfaceIcon>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase text-fd-muted-foreground">
                {step.label}
              </p>
              <p className="mt-1 text-sm font-semibold">{step.title}</p>
            </div>
            <p className="text-sm leading-6 text-fd-muted-foreground">{step.description}</p>
            <ArrowRight className="hidden size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground sm:mt-1 sm:block" />
          </Link>
        );
      })}
    </div>
  );
}

export function VerifyChecklist() {
  const checks = [
    {
      title: 'Install',
      description: 'The package resolves through the normal package manager and platform build tool.',
      icon: PackageCheck,
    },
    {
      title: 'Configure',
      description: 'Storage, runtime mode, selected extensions, and platform assets are explicit.',
      icon: Settings2,
    },
    {
      title: 'Verify',
      description: (
        <>
          <code>SELECT 1</code> and selected extensions behave on the target.
        </>
      ),
      icon: ClipboardCheck,
    },
  ];

  return (
    <div className="not-prose my-6 grid gap-3 md:grid-cols-3">
      {checks.map((check) => {
        const Icon = check.icon;

        return (
          <div key={check.title} className="rounded-lg border bg-fd-card p-4">
            <SurfaceIcon>
              <Icon className="size-4" />
            </SurfaceIcon>
            <p className="mt-4 text-sm font-semibold">{check.title}</p>
            <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{check.description}</p>
          </div>
        );
      })}
    </div>
  );
}

export function ShipChecklist() {
  const items = [
    {
      title: 'Package',
      description: 'Build the app binary or helper package that carries the selected runtime artifacts.',
    },
    {
      title: 'Lifecycle',
      description:
        'Close according to the app lifecycle, with cancellation where exposed. Issue PostgreSQL maintenance statements through execute only when required.',
    },
    {
      title: 'Extensions',
      description: 'Select SQL extension names explicitly and verify selected files in the app artifact.',
    },
    {
      title: 'Data movement',
      description:
        'Use the available SDK data-movement APIs for user-visible export and import.',
    },
    {
      title: 'Runtime support',
      description: 'Choose broker, server, and platform-specific behavior from the documented static SDK support.',
    },
  ];

  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border bg-fd-card">
      <div className="border-b bg-fd-muted/35 p-4">
        <p className="text-sm font-semibold">Before shipping</p>
        <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
          The first query proves the runtime is present. These checks prove the app integration is
          ready for users.
        </p>
      </div>
      <div className="grid gap-px bg-fd-border md:grid-cols-5">
        {items.map((item) => (
          <div key={item.title} className="bg-fd-background p-4">
            <CheckCircle2 className="mb-3 size-4 text-fd-primary" />
            <p className="text-sm font-semibold">{item.title}</p>
            <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{item.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ModeMatrix() {
  return (
    <div className="not-prose my-8 divide-y border-y">
      {runtimeModes.map((mode) => {
        const Icon = mode.icon;

        return (
          <div
            key={mode.name}
            className="grid gap-4 py-4 md:grid-cols-[190px_1fr_1fr] md:items-start"
          >
            <div className="flex items-center gap-3">
              <SurfaceIcon>
                <Icon className="size-4" />
              </SurfaceIcon>
              <div>
                <InlineCode>{mode.name}</InlineCode>
                <p className="mt-1 text-xs text-fd-muted-foreground">{mode.label}</p>
              </div>
            </div>
            <div>
              <p className="text-xs font-medium uppercase text-fd-muted-foreground">Use it when</p>
              <p className="mt-1 text-sm leading-6">{mode.useWhen}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase text-fd-muted-foreground">Boundary</p>
              <p className="mt-1 text-sm leading-6">{mode.boundary}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ExactExtensionRule() {
  return (
    <div className="not-prose my-6 rounded-lg border bg-fd-card p-4">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-1 size-5 text-fd-primary" />
        <div>
          <p className="text-sm font-semibold">Extension selection is exact and product-native.</p>
          <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
            Native SDKs select exact SQL names, Rust WASIX uses exact Cargo features and typed
            values, and WASIX TypeScript imports exact <code>-wasix</code> descriptors. Every form
            includes only the selected carrier closure.
          </p>
        </div>
      </div>
    </div>
  );
}
