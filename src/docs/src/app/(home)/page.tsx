import { ArrowRight, ArrowUpRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AppSurfaceRail,
  BentoCard,
  BentoCardCopy,
  HeroQueryArtifact,
  LifecycleArtifact,
  LocalDataArtifact,
  ModelInventory,
  RelationshipArtifact,
  SearchArtifact,
} from '@/components/home-product-bento';
import { HomeStackExplorer } from '@/components/home-stack-explorer';
import { gitConfig } from '@/lib/shared';

export const metadata: Metadata = {
  title: {
    absolute: 'Oliphaunt — PostgreSQL inside your app',
  },
  description:
    'Build desktop and mobile products on a powerful local PostgreSQL data core, with rich relational models, sophisticated queries, and app-owned storage.',
};

const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
const githubRoot = `${githubUrl}/tree/${gitConfig.branch}`;
const githubBlob = `${githubUrl}/blob/${gitConfig.branch}`;

const useCases = [
  {
    number: '01',
    title: 'Knowledge and creative workspaces',
    description:
      'Documents, projects, revision history, metadata, and retrieval live together in one local model.',
    detail: 'Projects · content · history · search',
  },
  {
    number: '02',
    title: 'Field and mobile products',
    description:
      'Structured records and essential workflows remain available away from a database connection.',
    detail: 'Forms · reference data · relational history',
  },
  {
    number: '03',
    title: 'Local retrieval',
    description:
      'Store embeddings beside source data, then combine semantic search with metadata and relational filters in SQL.',
    detail: 'Vector · full-text · structured filters',
  },
  {
    number: '04',
    title: 'Data and developer tools',
    description:
      'Import, inspect, transform, and query complex local datasets with familiar PostgreSQL behavior.',
    detail: 'Import · inspect · transform · query',
  },
];

const productCapabilities = [
  {
    label: 'Search in context',
    title: 'One query can understand the whole record.',
    description:
      'Full-text, fuzzy, and vector retrieval meet structured filters in the same PostgreSQL query.',
    className: 'oliphaunt-wow-ecosystem__search',
  },
  {
    label: 'Understand place',
    title: 'Make location part of the model.',
    description:
      'Run distance and geometry queries beside the people, assets, and events they describe.',
    className: 'oliphaunt-wow-ecosystem__place',
  },
  {
    label: 'Model naturally',
    title: 'Give product data room to be itself.',
    description:
      'Use JSONB, arrays, enums, trees, generated columns, and advanced indexes in one coherent model.',
    className: 'oliphaunt-wow-ecosystem__model',
  },
];

const examples = [
  {
    label: 'Tauri / Rust',
    title: 'PostgreSQL in the Rust backend.',
    description:
      'The native runtime owns database state behind focused application commands, with a working UI path you can run and inspect.',
    href: `${githubRoot}/examples/tauri`,
  },
  {
    label: 'Electron / TypeScript',
    title: 'PostgreSQL in the main process.',
    description:
      'A narrow preload API gives the renderer exactly the database capabilities the product needs.',
    href: `${githubRoot}/examples/electron`,
  },
  {
    label: 'Native + WebAssembly',
    title: 'Four apps share one schema.',
    description:
      'Native and WebAssembly variants make each runtime path concrete while preserving the same product behavior.',
    href: `${githubBlob}/examples/README.md`,
  },
];

const footerGroups = [
  {
    title: 'Build',
    links: [
      { label: 'Get started', href: '/docs/start' },
      { label: 'SDKs', href: '/docs/sdk' },
      { label: 'Extensions', href: '/docs/reference/extensions' },
    ],
  },
  {
    title: 'Learn',
    links: [
      { label: 'How it works', href: '/docs/learn/embedded-postgres' },
      { label: 'Compare SQLite', href: '/docs/learn/sqlite-upgrade' },
      { label: 'Target support', href: '/docs/reference/releases' },
    ],
  },
  {
    title: 'Project',
    links: [
      { label: 'GitHub', href: githubUrl },
      { label: 'Contributing', href: `${githubBlob}/CONTRIBUTING.md` },
      { label: 'MIT license', href: `${githubBlob}/LICENSE` },
    ],
  },
];

export default function HomePage() {
  return (
    <div className="oliphaunt-home oliphaunt-wow">
      <main>
        <section className="oliphaunt-wow-hero" aria-labelledby="hero-heading">
          <div className="oliphaunt-wow-shell">
            <div className="oliphaunt-wow-grid oliphaunt-wow-hero__grid">
              <BentoCard className="oliphaunt-wow-hero__intro" tone="blue">
                <div className="oliphaunt-wow-hero__copy">
                  <h1 id="hero-heading">
                    PostgreSQL,
                    <span>built into your product.</span>
                  </h1>
                  <p>
                    Give desktop and mobile apps a powerful local data core. Model rich
                    relationships, run sophisticated queries, and keep essential workflows available
                    wherever the user is.
                  </p>
                  <div className="oliphaunt-wow-actions">
                    <Link
                      href="/docs/start"
                      className="oliphaunt-wow-button oliphaunt-wow-button--light"
                    >
                      Start building
                      <ArrowRight aria-hidden="true" />
                    </Link>
                    <Link
                      href={githubUrl}
                      className="oliphaunt-wow-button oliphaunt-wow-button--blue-quiet"
                    >
                      View on GitHub
                    </Link>
                  </div>
                </div>
                <p className="oliphaunt-wow-hero__promise">
                  Relations <span /> search <span /> transactions <span /> local data
                </p>
              </BentoCard>

              <BentoCard className="oliphaunt-wow-hero__query" tone="ink">
                <BentoCardCopy
                  label="One query. Whole context."
                  title="Find the right thing."
                  description="Blend relational filters with fuzzy, full-text, and vector retrieval."
                  headingLevel="h2"
                />
                <HeroQueryArtifact />
              </BentoCard>

              <BentoCard className="oliphaunt-wow-hero__surfaces" tone="mint">
                <BentoCardCopy
                  label="One local data core"
                  title="Every app surface."
                  description="Meet users in the product they already want to use."
                  headingLevel="h2"
                />
                <AppSurfaceRail />
              </BentoCard>
            </div>
          </div>
        </section>

        <section className="oliphaunt-wow-section" aria-labelledby="possibility-heading">
          <div className="oliphaunt-wow-shell">
            <header className="oliphaunt-wow-heading">
              <p>More product. One database.</p>
              <div>
                <h2 id="possibility-heading">Build the product PostgreSQL makes possible.</h2>
                <p>
                  One local system for the data, search, and workflows at the heart of your app.
                </p>
              </div>
            </header>

            <div className="oliphaunt-wow-grid oliphaunt-wow-capability-grid">
              <BentoCard className="oliphaunt-wow-capability__relations" tone="paper">
                <BentoCardCopy
                  label="Relational core"
                  title="Everything connects."
                  description="Projects, content, tags, history, and metadata live in one model—ready for joins, constraints, and transactions."
                />
                <RelationshipArtifact />
              </BentoCard>

              <BentoCard className="oliphaunt-wow-capability__local" tone="blue">
                <BentoCardCopy
                  label="Local by design"
                  title="No round trip."
                  description="Core reads and writes happen where the product runs, even when the network does not."
                />
                <LocalDataArtifact />
              </BentoCard>

              <BentoCard className="oliphaunt-wow-capability__model" tone="warm">
                <BentoCardCopy
                  label="PostgreSQL modeling"
                  title="Go beyond rows and blobs."
                  description="Shape the data around the product instead of flattening the product around the database."
                />
                <ModelInventory />
              </BentoCard>

              <BentoCard className="oliphaunt-wow-capability__search" tone="mint">
                <BentoCardCopy
                  label="Local retrieval"
                  title="Search in context."
                  description="Keep source records, embeddings, metadata, and search behavior together."
                />
                <SearchArtifact />
              </BentoCard>

              <BentoCard className="oliphaunt-wow-capability__lifecycle" tone="ink">
                <BentoCardCopy
                  label="App lifecycle"
                  title="Data that comes back."
                  description="WAL recovery, lifecycle hooks, backup, and restore carry the database through backgrounding and relaunch."
                />
                <LifecycleArtifact />
              </BentoCard>
            </div>
          </div>
        </section>

        <section
          className="oliphaunt-wow-section oliphaunt-wow-use-cases"
          aria-labelledby="use-cases-heading"
        >
          <div className="oliphaunt-wow-shell">
            <header className="oliphaunt-wow-heading">
              <p>Made for life away from the server</p>
              <div>
                <h2 id="use-cases-heading">Software that carries its world with it.</h2>
                <p>For products where local data is the experience, not a temporary copy.</p>
              </div>
            </header>
            <div className="oliphaunt-wow-use-cases__grid">
              {useCases.map((useCase) => (
                <article key={useCase.number}>
                  <p className="oliphaunt-wow-use-cases__number">{useCase.number}</p>
                  <div>
                    <h3>{useCase.title}</h3>
                    <p>{useCase.description}</p>
                  </div>
                  <p className="oliphaunt-wow-use-cases__detail">{useCase.detail}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="oliphaunt-wow-section" id="stacks" aria-labelledby="stacks-heading">
          <div className="oliphaunt-wow-shell">
            <div className="oliphaunt-wow-grid oliphaunt-wow-stack-grid">
              <BentoCard className="oliphaunt-wow-stack__intro" tone="warm">
                <BentoCardCopy
                  label="A native fit"
                  title="One schema. Every app surface."
                  description="Query the same PostgreSQL model from Rust, TypeScript, Swift, Kotlin, and React Native."
                />
                <p className="oliphaunt-wow-stack__languages">
                  Rust <span>TypeScript</span> Swift <span>Kotlin</span> React Native
                </p>
              </BentoCard>
              <BentoCard className="oliphaunt-wow-stack__code" tone="ink">
                <HomeStackExplorer />
              </BentoCard>
            </div>
          </div>
        </section>

        <section
          className="oliphaunt-wow-section oliphaunt-wow-ecosystem"
          aria-labelledby="ecosystem-heading"
        >
          <div className="oliphaunt-wow-shell">
            <header className="oliphaunt-wow-heading">
              <p>PostgreSQL as a product palette</p>
              <div>
                <h2 id="ecosystem-heading">Bring more of the product into one database.</h2>
                <p>
                  Build capabilities around the data they belong to, with the language and tools
                  PostgreSQL gives you.
                </p>
              </div>
            </header>
            <div className="oliphaunt-wow-grid oliphaunt-wow-ecosystem__grid">
              {productCapabilities.map((capability) => (
                <BentoCard key={capability.label} className={capability.className} tone="paper">
                  <BentoCardCopy
                    label={capability.label}
                    title={capability.title}
                    description={capability.description}
                  />
                </BentoCard>
              ))}
            </div>
            <Link href="/docs/reference/extensions" className="oliphaunt-wow-text-link">
              Explore the capability catalog
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </div>
        </section>

        <section
          className="oliphaunt-wow-section oliphaunt-wow-proof"
          aria-labelledby="proof-heading"
        >
          <div className="oliphaunt-wow-shell">
            <header className="oliphaunt-wow-heading">
              <p>Inspect the work</p>
              <div>
                <h2 id="proof-heading">Real apps. Real runtimes. Real source.</h2>
                <p>
                  Explore working Tauri and Electron apps that create, search, complete, persist,
                  and back up data through Oliphaunt.
                </p>
              </div>
            </header>

            <div className="oliphaunt-wow-grid oliphaunt-wow-proof__grid">
              {examples.map((example) => (
                <BentoCard
                  key={example.label}
                  className="oliphaunt-wow-proof__example"
                  tone="soft-ink"
                >
                  <BentoCardCopy
                    label={example.label}
                    title={example.title}
                    description={example.description}
                  />
                  <Link href={example.href}>
                    Inspect the source
                    <ArrowUpRight aria-hidden="true" />
                  </Link>
                </BentoCard>
              ))}

              <BentoCard className="oliphaunt-wow-proof__cta" tone="blue">
                <div>
                  <p>Ready when you are.</p>
                  <h2>Put PostgreSQL at the heart of the product.</h2>
                  <p>Open a local database. Run the first query. Build outward from there.</p>
                </div>
                <div className="oliphaunt-wow-actions">
                  <Link
                    href="/docs/start"
                    className="oliphaunt-wow-button oliphaunt-wow-button--light"
                  >
                    Start building
                    <ArrowRight aria-hidden="true" />
                  </Link>
                  <Link
                    href="/docs/learn/embedded-postgres"
                    className="oliphaunt-wow-button oliphaunt-wow-button--blue-quiet"
                  >
                    See how it works
                  </Link>
                </div>
              </BentoCard>
            </div>
          </div>
        </section>
      </main>

      <footer className="oliphaunt-wow-footer">
        <div className="oliphaunt-wow-shell oliphaunt-wow-footer__grid">
          <Link href="/" className="oliphaunt-wow-footer__brand">
            <span aria-hidden="true" />
            Oliphaunt
          </Link>
          {footerGroups.map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <p>{group.title}</p>
              {group.links.map((link) => (
                <Link href={link.href} key={link.label}>
                  {link.label}
                </Link>
              ))}
            </nav>
          ))}
        </div>
      </footer>
    </div>
  );
}
