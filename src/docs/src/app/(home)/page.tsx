import {
  ArrowRight,
  Database,
  ListChecks,
  PackageCheck,
  PlayCircle,
  Route,
  SearchCheck,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { runtimeModes, sdkSurfaces } from '@/lib/docs-data';

const maintainerPaths = [
  {
    title: 'Releases',
    description: 'Version matrix, release notes, and artifact compatibility.',
    href: '/docs/reference/releases',
    icon: ListChecks,
  },
  {
    title: 'Extensions',
    description: 'SQL extension names, dependencies, targets, and packaging policy.',
    href: '/docs/reference/extensions',
    icon: SearchCheck,
  },
  {
    title: 'API surfaces',
    description: 'Language API maps plus the C ABI route for SDK bindings.',
    href: '/docs/reference/api-reference',
    icon: Route,
  },
  {
    title: 'Performance',
    description: 'Workload results, footprint notes, and claim evidence.',
    href: '/docs/reference/performance',
    icon: Database,
  },
];

const productSignals = [
  { label: 'SDK surfaces', value: '7' },
  { label: 'Runtime families', value: '4' },
  { label: 'First query', value: '1' },
];

function ArrowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="oliphaunt-arrow-link">
      {children}
      <ArrowRight className="size-4" />
    </Link>
  );
}

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col overflow-x-clip">
      <section className="oliphaunt-home-hero border-b">
        <div className="mx-auto grid w-full max-w-7xl gap-10 px-5 pb-12 pt-10 sm:px-6 md:pt-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:pb-16">
          <div className="min-w-0">
            <div className="oliphaunt-rail-label">
              <span>Oliphaunt</span>
              <span>Docs</span>
              <span>PostgreSQL in app storage</span>
            </div>
            <h1 className="mt-6 max-w-3xl text-6xl font-semibold leading-none text-fd-foreground sm:text-7xl lg:text-8xl">
              Oliphaunt
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-fd-muted-foreground sm:text-xl sm:leading-9">
              Polyglot docs for embedded PostgreSQL SDKs, runtime modes, exact
              extension packaging, and app-owned data movement.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/docs/start" className="oliphaunt-primary-action">
                <PlayCircle className="size-4" />
                Start with the docs
              </Link>
              <Link href="/docs/sdk" className="oliphaunt-secondary-action">
                <PackageCheck className="size-4" />
                Choose an SDK
              </Link>
            </div>
            <div className="mt-8 grid max-w-xl grid-cols-3 border-y border-fd-border/70">
              {productSignals.map((signal) => (
                <div key={signal.label} className="min-w-0 border-e py-4 pe-4 last:border-e-0">
                  <p className="text-2xl font-semibold leading-none text-fd-foreground">
                    {signal.value}
                  </p>
                  <p className="mt-2 text-xs font-medium uppercase text-fd-muted-foreground">
                    {signal.label}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="oliphaunt-product-visual" aria-label="Oliphaunt docs product map">
            <div className="oliphaunt-product-visual__bar oliphaunt-product-visual__bar--desktop">
              <span>Start path</span>
              <span>SDK to runtime to verify</span>
            </div>
            <div className="oliphaunt-product-visual__body">
              <div className="oliphaunt-runtime-stack">
                {runtimeModes.map((mode, index) => {
                  const Icon = mode.icon;

                  return (
                    <Link key={mode.name} href={mode.href} className="oliphaunt-runtime-chip">
                      <span className="oliphaunt-runtime-chip__index">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <Icon className="size-4" />
                      <code className="min-w-0 truncate">{mode.name}</code>
                    </Link>
                  );
                })}
              </div>

              <div className="oliphaunt-visual-footer">
                <div>
                  <p>Choose</p>
                  <span>SDK</span>
                </div>
                <div>
                  <p>Configure</p>
                  <span>Runtime</span>
                </div>
                <div>
                  <p>Verify</p>
                  <span>Query</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-5 py-14 sm:px-6 lg:py-18">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start">
          <div>
            <p className="oliphaunt-section-kicker">SDK surfaces</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight md:text-5xl">
              Choose by package and target.
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-7 text-fd-muted-foreground">
              Every SDK keeps the same database intent while matching its
              platform package manager, lifecycle, concurrency model, and build
              artifacts.
            </p>
          </div>
          <div className="divide-y border-y">
            {sdkSurfaces.map((sdk) => {
              const Icon = sdk.icon;

              return (
                <Link
                  key={sdk.id}
                  href={sdk.href}
                  className="group grid min-w-0 gap-3 py-4 transition-colors hover:bg-fd-muted/35 sm:grid-cols-[auto_minmax(0,150px)_minmax(0,1fr)_minmax(0,160px)_24px] sm:items-start"
                >
                  <span className="oliphaunt-icon-tile">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">{sdk.title}</h3>
                    <div className="mt-1">
                      <code className="oliphaunt-inline-code">
                        {sdk.packageName}
                      </code>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm leading-6 text-fd-muted-foreground">
                      {sdk.target}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    {sdk.modes.map((mode) => (
                      <span key={mode} className="oliphaunt-mode-pill">
                        {mode}
                      </span>
                    ))}
                  </div>
                  <ArrowRight className="hidden size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground sm:mt-1 sm:block" />
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-t bg-fd-card/35">
        <div className="mx-auto w-full max-w-7xl px-5 py-12 sm:px-6">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div>
              <p className="oliphaunt-section-kicker">Reference paths</p>
              <h2 className="mt-3 text-3xl font-semibold leading-tight md:text-5xl">
                Keep release and tooling details close.
              </h2>
              <p className="mt-4 max-w-lg text-sm leading-7 text-fd-muted-foreground">
                Maintainers and SDK authors can jump straight to compatibility,
                extension packaging, API surfaces, and performance evidence.
              </p>
            </div>
            <div className="divide-y border-y">
              {maintainerPaths.map((path) => {
                const Icon = path.icon;

                return (
                  <Link key={path.title} href={path.href} className="oliphaunt-maintainer-row group">
                    <span className="oliphaunt-icon-tile">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{path.title}</p>
                      <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">
                        {path.description}
                      </p>
                    </div>
                    <ArrowRight className="size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-foreground" />
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
