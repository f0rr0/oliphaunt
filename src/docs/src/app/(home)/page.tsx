import {
  ArrowRight,
  CheckCircle2,
  Database,
  GitBranch,
  PackageCheck,
  Route,
  SearchCheck,
  TerminalSquare,
} from 'lucide-react';
import Link from 'next/link';
import { productPillars, runtimeModes, sdkSurfaces } from '@/lib/docs-data';

const readerPaths = [
  {
    label: 'Tutorial',
    title: 'Run the first query',
    href: '/docs/start',
    description: 'Choose a platform SDK, open a root, run `SELECT 1`, and verify the runtime.',
    icon: Route,
  },
  {
    label: 'How-to guides',
    title: 'Build in your ecosystem',
    href: '/docs/sdk',
    description: 'Use Rust, Swift, Kotlin, React Native, TypeScript, WASM, or the C ABI.',
    icon: PackageCheck,
  },
  {
    label: 'Explanation',
    title: 'Understand runtime shape',
    href: '/docs/learn/native-runtime',
    description: 'Compare direct, broker, server, roots, lifecycle, capabilities, and backup behavior.',
    icon: Database,
  },
  {
    label: 'Reference',
    title: 'Look up exact support',
    href: '/docs/reference',
    description: 'Check modes, platform support, exact extensions, releases, and performance results.',
    icon: SearchCheck,
  },
];

const integrationPaths = [
  {
    title: 'Rust / Tauri',
    packageName: 'oliphaunt',
    install: 'cargo add oliphaunt',
    verify: 'Direct, broker, or server mode',
    href: '/docs/sdk/rust',
  },
  {
    title: 'Swift / Apple',
    packageName: 'Oliphaunt',
    install: 'Add package in Xcode',
    verify: 'App storage and lifecycle',
    href: '/docs/sdk/swift',
  },
  {
    title: 'Kotlin / Android',
    packageName: 'dev.oliphaunt:oliphaunt',
    install: 'id("dev.oliphaunt.android") + implementation("dev.oliphaunt:oliphaunt")',
    verify: 'Gradle assets and ABI artifacts',
    href: '/docs/sdk/kotlin',
  },
  {
    title: 'React Native',
    packageName: '@oliphaunt/react-native',
    install: 'npx expo install @oliphaunt/react-native',
    verify: 'Development build and JSI bytes',
    href: '/docs/sdk/react-native',
  },
  {
    title: 'TypeScript / Desktop JS',
    packageName: '@oliphaunt/ts',
    install: 'npm install @oliphaunt/ts',
    verify: 'Helper assets and broker/server modes',
    href: '/docs/sdk/typescript',
  },
  {
    title: 'WASM / WASIX',
    packageName: 'oliphaunt-wasix',
    install: 'cargo add oliphaunt-wasix',
    verify: 'WASIX assets and dump/restore',
    href: '/docs/sdk/wasm',
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="oliphaunt-hero border-b">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-14 lg:grid-cols-[0.92fr_1.08fr] lg:items-center lg:py-20">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-md border bg-fd-card px-3 py-1 text-sm font-medium text-fd-muted-foreground">
              <Database className="size-4 text-fd-primary" />
              Embedded PostgreSQL for app developers
            </p>
            <h1 className="max-w-4xl text-4xl font-semibold leading-tight md:text-6xl">
              Oliphaunt brings PostgreSQL into app-owned storage.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-fd-muted-foreground">
              Build local-first desktop, mobile, React Native, TypeScript, and
              WASM apps with PostgreSQL behavior, explicit runtime modes, exact
              extension packaging, and SDK-owned backup and restore.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/docs/start"
                className="inline-flex items-center gap-2 rounded-md bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
              >
                Start with the docs
                <ArrowRight className="size-4" />
              </Link>
              <Link
                href="/docs/sdk"
                className="inline-flex items-center gap-2 rounded-md border bg-fd-card px-4 py-2 text-sm font-medium text-fd-foreground transition-colors hover:bg-fd-accent"
              >
                Choose an SDK
              </Link>
            </div>
          </div>

          <div className="oliphaunt-panel overflow-hidden rounded-lg border bg-fd-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-fd-muted/40 px-4 py-3">
              <div className="inline-flex items-center gap-2 text-sm font-semibold">
                <TerminalSquare className="size-4 text-fd-primary" />
                First app paths
              </div>
              <span className="text-xs text-fd-muted-foreground">
                same database flow, target-native package
              </span>
            </div>
            <div className="grid gap-px bg-fd-border md:grid-cols-2 xl:grid-cols-3">
              {integrationPaths.map((path) => (
                <Link
                  key={path.title}
                  href={path.href}
                  className="group flex min-w-0 flex-col bg-fd-background p-4 transition-colors hover:bg-fd-accent/70"
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{path.title}</p>
                      <code className="mt-1 inline-block rounded border bg-fd-muted px-1.5 py-0.5 text-[0.72rem] text-fd-muted-foreground">
                        {path.packageName}
                      </code>
                    </div>
                    <ArrowRight className="mt-1 size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground" />
                  </div>
                  <div className="mt-4 flex flex-1 flex-col justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[0.7rem] font-medium uppercase text-fd-muted-foreground">
                        Install
                      </p>
                      <code className="mt-1 block min-w-0 whitespace-normal break-words rounded border bg-fd-card px-2 py-1 text-xs">
                        {path.install}
                      </code>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[0.7rem] font-medium uppercase text-fd-muted-foreground">
                        Verify
                      </p>
                      <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                        {path.verify}
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
            <div className="grid border-t text-sm sm:grid-cols-3">
              {['Read capabilities', 'Use app-owned storage', 'Ship selected extensions'].map(
                (item) => (
                  <div
                    key={item}
                    className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-e sm:last:border-e-0"
                  >
                    <CheckCircle2 className="size-4 shrink-0 text-fd-primary" />
                    <span className="text-sm">{item}</span>
                  </div>
                ),
              )}
            </div>
            <div className="border-t bg-fd-muted/30 px-4 py-3">
              <div className="grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-xs font-medium uppercase text-fd-muted-foreground">Root</p>
                  <code className="mt-1 block text-fd-foreground">main.oliphaunt</code>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-fd-muted-foreground">Runtime</p>
                  <code className="mt-1 block text-fd-foreground">nativeDirect</code>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-fd-muted-foreground">
                    First query
                  </p>
                  <code className="mt-1 block text-fd-foreground">SELECT 1</code>
                </div>
              </div>
              <p className="mt-3 border-t pt-3 text-xs leading-5 text-fd-muted-foreground">
                Building a new language binding? Start with the{' '}
                <Link href="/docs/sdk/c-abi" className="font-medium text-fd-foreground underline">
                  C ABI
                </Link>
                .
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b bg-fd-card/40">
        <div className="mx-auto w-full max-w-6xl px-6 py-12">
          <div className="max-w-2xl">
            <p className="oliphaunt-section-kicker">Docs path</p>
            <h2 className="mt-2 text-2xl font-semibold">Use the docs by the job in front of you</h2>
            <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
              Start with the shortest query path, then move into platform guides,
              runtime model pages, and exact lookup pages as the app integration grows.
            </p>
          </div>
          <div className="mt-6 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {readerPaths.map((path) => {
              const Icon = path.icon;

              return (
                <Link
                  key={path.title}
                  href={path.href}
                  className="group rounded-lg border bg-fd-background p-4 transition-colors hover:border-fd-primary/40 hover:bg-fd-accent/70"
                >
                  <div className="flex items-start justify-between gap-3">
                    <Icon className="size-5 text-fd-primary" />
                    <ArrowRight className="size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground" />
                  </div>
                  <p className="mt-4 text-xs font-medium uppercase text-fd-muted-foreground">
                    {path.label}
                  </p>
                  <h3 className="mt-1 text-base font-semibold">{path.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
                    {path.description}
                  </p>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-14">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <p className="oliphaunt-section-kicker">SDKs</p>
            <h2 className="mt-2 text-2xl font-semibold">Start from the app you ship</h2>
            <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
              Each SDK uses the package manager, concurrency model, lifecycle, and
              packaging rules developers already expect on that platform.
            </p>
          </div>
          <Link
            href="/docs/reference/sdk-products"
            className="inline-flex items-center gap-2 text-sm font-medium text-fd-primary"
          >
            Compare SDKs
            <ArrowRight className="size-4" />
          </Link>
        </div>
        <div className="mt-6 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {sdkSurfaces.map((sdk) => {
            const Icon = sdk.icon;

            return (
              <Link
                key={sdk.title}
                href={sdk.href}
                className="group min-w-0 rounded-lg border bg-fd-card p-4 transition-colors hover:border-fd-primary/40 hover:bg-fd-accent/70"
              >
                <div className="flex items-start justify-between gap-3">
                  <Icon className="size-5 text-fd-muted-foreground group-hover:text-fd-foreground" />
                  <ArrowRight className="size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground" />
                </div>
                <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{sdk.title}</h3>
                  <code className="rounded border bg-fd-background px-1.5 py-0.5 text-[0.72rem] text-fd-muted-foreground">
                    {sdk.packageName}
                  </code>
                </div>
                <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{sdk.target}</p>
                <p className="mt-3 text-sm leading-6">{sdk.startWith}</p>
                <code className="mt-3 block min-w-0 whitespace-normal break-words rounded border bg-fd-background px-2 py-1.5 text-xs text-fd-muted-foreground">
                  {sdk.install}
                </code>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{sdk.owns}</p>
                <div className="mt-3 border-t pt-3">
                  <p className="text-[0.68rem] font-medium uppercase text-fd-muted-foreground">
                    Verify first
                  </p>
                  <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                    {sdk.verifyFirst}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="border-y bg-fd-muted/35">
        <div className="mx-auto grid w-full max-w-6xl gap-4 px-6 py-12 md:grid-cols-2 lg:grid-cols-4">
          {productPillars.map((pillar) => {
            const Icon = pillar.icon;

            return (
              <div key={pillar.title} className="rounded-lg border bg-fd-background p-4">
                <Icon className="mb-3 size-5 text-fd-primary" />
                <h2 className="text-sm font-semibold">{pillar.title}</h2>
                <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
                  {pillar.description}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-14 lg:grid-cols-[0.85fr_1.15fr]">
        <div>
          <p className="oliphaunt-section-kicker">Runtime model</p>
          <h2 className="mt-2 text-2xl font-semibold">Use the right PostgreSQL shape</h2>
          <p className="mt-4 text-sm leading-6 text-fd-muted-foreground">
            Oliphaunt makes runtime boundaries explicit. Pick the mode with the
            concurrency, isolation, and compatibility your application uses.
          </p>
        </div>
        <div className="grid gap-3">
          {runtimeModes.map((mode) => (
            <Link
              key={mode.name}
              href={mode.href}
              className="grid gap-3 rounded-lg border bg-fd-card p-4 hover:bg-fd-accent md:grid-cols-[160px_1fr]"
            >
              <div>
                <code className="text-sm font-semibold">{mode.name}</code>
                <p className="mt-1 text-xs text-fd-muted-foreground">{mode.label}</p>
              </div>
              <p className="text-sm leading-6 text-fd-muted-foreground">{mode.useWhen}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-10 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold">Pick a platform path</p>
            <p className="mt-1 text-sm text-fd-muted-foreground">
              Start with the SDK page for your platform, then verify capabilities on the target.
            </p>
          </div>
          <Link
            href="/docs/start"
            className="inline-flex items-center gap-2 rounded-md border bg-fd-card px-4 py-2 text-sm font-medium hover:bg-fd-accent"
          >
            Open Start
            <GitBranch className="size-4" />
          </Link>
        </div>
      </section>
    </main>
  );
}
