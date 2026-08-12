import { ArrowRight, ArrowUpRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { OliphauntMark, OliphauntWordmark } from '@/components/brand';
import { HomeHeroFlow } from '@/components/home-hero-flow';
import { BrandIcon, MotionArticle, SdkCodeExplorer } from '@/components/home-interactive';
import {
  ExtensionEcosystemVisual,
  PostgresEngineVisual,
  RuntimeFamilyVisual,
  type UseCaseKind,
  UseCaseVisual,
} from '@/components/home-visuals';
import { gitConfig } from '@/lib/shared';

export const metadata: Metadata = {
  title: {
    absolute: 'Oliphaunt — PostgreSQL 18, built into your app',
  },
  description:
    'Run PostgreSQL 18 inside desktop and mobile apps or WASIX hosts, with app-owned storage, language SDKs, and target-specific extensions.',
};

const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
const githubRoot = `${githubUrl}/tree/${gitConfig.branch}`;
const githubBlob = `${githubUrl}/blob/${gitConfig.branch}`;

const sdkMarks = [
  { id: 'rust', label: 'Rust' },
  { id: 'swift', label: 'Swift' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'react', label: 'React Native' },
  { id: 'typescript', label: 'TypeScript' },
] as const;

const useCases: readonly {
  title: string;
  description: string;
  capability: string;
  kind: UseCaseKind;
}[] = [
  {
    title: 'Knowledge and creative tools',
    description: 'Relate documents, projects, revision history, metadata, and search in one model.',
    capability: 'relations · JSONB · full-text search',
    kind: 'knowledge',
  },
  {
    title: 'Field and mobile software',
    description: 'Keep records with the app and run spatial queries where the target ships PostGIS.',
    capability: 'transactions · geography · recovery',
    kind: 'field',
  },
  {
    title: 'Local retrieval',
    description: 'Store vectors beside source data and combine similarity with relational filters.',
    capability: 'pgvector · indexes · structured filters',
    kind: 'retrieval',
  },
  {
    title: 'Local data workbenches',
    description: 'Import, inspect, transform, and query complex datasets with PostgreSQL behavior.',
    capability: 'SQL · types · extensions',
    kind: 'data',
  },
];

const examples = [
  {
    platform: 'Tauri / Native',
    proof: 'Rust owns the Oliphaunt handle in application state.',
    stack: 'Rust SDK · app-owned root',
    href: `${githubRoot}/examples/tauri`,
  },
  {
    platform: 'Tauri / WASIX',
    proof: 'OliphauntServer exposes a local PostgreSQL URL to SQLx.',
    stack: 'WASIX sidecar · SQLx',
    href: `${githubRoot}/examples/tauri-wasix`,
  },
  {
    platform: 'Electron / Native',
    proof: 'The TypeScript SDK runs native server mode in the main process.',
    stack: 'TypeScript SDK · native server',
    href: `${githubRoot}/examples/electron`,
  },
  {
    platform: 'Electron / WASIX',
    proof: 'A Rust sidecar supplies a local PostgreSQL URL to the main process.',
    stack: 'WASIX sidecar · local endpoint',
    href: `${githubRoot}/examples/electron-wasix`,
  },
] as const;

function SectionHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description?: string;
}) {
  return (
    <header className="home-section-heading">
      <h2 id={id}>{title}</h2>
      {description ? <p>{description}</p> : null}
    </header>
  );
}

export default function HomePage() {
  return (
    <div className="home-page home-page--v2">
      <section className="home-hero" aria-labelledby="home-hero-title">
        <div className="home-shell home-hero__grid">
          <div className="home-hero__copy">
            <h1 id="home-hero-title" aria-label="PostgreSQL 18, built into your app.">
              <span className="home-hero__product" aria-hidden="true">
                PostgreSQL <em>18</em>
              </span>
              <span aria-hidden="true">built into your app.</span>
            </h1>
            <p>
              Ship a complete PostgreSQL database inside desktop and mobile software or a WASIX
              host. Keep data in an app-owned root and use it through a language SDK or, where
              supported, a local PostgreSQL endpoint.
            </p>
            <div className="home-actions">
              <Link href="/docs/start" className="home-button home-button--primary">
                Get started
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link href={githubUrl} className="home-button home-button--secondary">
                View source
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </div>
          </div>
          <HomeHeroFlow />
        </div>
      </section>

      <section className="home-sdk-rail" aria-label="Oliphaunt language SDKs">
        <div className="home-shell">
          <p>Language SDKs</p>
          <ul>
            {sdkMarks.map((sdk) => (
              <li key={sdk.id}>
                <BrandIcon id={sdk.id} />
                <span>{sdk.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="home-section home-use-cases" aria-labelledby="use-cases-title">
        <div className="home-shell">
          <SectionHeading
            id="use-cases-title"
            title="Keep product data in one PostgreSQL model."
            description="Relations, JSONB, geospatial queries, full-text search, and vectors can live in the same app-owned root."
          />
          <div className="home-use-grid">
            {useCases.map((useCase) => (
              <MotionArticle className="home-use-card" key={useCase.kind}>
                <div className="home-use-card__copy">
                  <h3>{useCase.title}</h3>
                  <p>{useCase.description}</p>
                  <code>{useCase.capability}</code>
                </div>
                <UseCaseVisual kind={useCase.kind} />
              </MotionArticle>
            ))}
          </div>
        </div>
      </section>

      <section className="home-section home-foundation" aria-labelledby="foundation-title">
        <div className="home-shell">
          <SectionHeading
            id="foundation-title"
            title="What ships with the app."
            description="Oliphaunt packages PostgreSQL, its runtime, and verified extension builds for the target."
          />

          <div className="home-bento-grid home-bento-grid--v2">
            <MotionArticle className="home-card home-card--engine">
              <div className="home-card__copy">
                <h3>PostgreSQL 18 is the engine.</h3>
                <p>
                  Ship PostgreSQL storage, SQL, types, transactions, indexes, WAL, and recovery
                  inside an application-owned database root.
                </p>
              </div>
              <PostgresEngineVisual />
            </MotionArticle>

            <MotionArticle className="home-card home-card--runtime-family">
              <div className="home-card__copy">
                <h3>Native or WASIX.</h3>
                <p>
                  Use native direct, broker, or server modes on supported platforms. For WASIX
                  hosts, ship portable runtime assets with target-specific carriers.
                </p>
              </div>
              <RuntimeFamilyVisual />
              <Link href="/docs/reference/releases" className="home-card-link">
                Compare target support
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </MotionArticle>

            <MotionArticle className="home-card home-card--extension-ecosystem">
              <div className="home-card__copy">
                <h3>PostGIS and pgvector, in the app.</h3>
                <p>
                  Add spatial data, vector search, full-text search, trigram indexes, crypto,
                  UUIDv7, and more across native and WASIX targets.
                </p>
              </div>
              <ExtensionEcosystemVisual />
              <Link href="/docs/reference/extensions" className="home-card-link">
                Browse verified extensions
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </MotionArticle>
          </div>
        </div>
      </section>

      <section className="home-section home-sdk-section" aria-labelledby="sdk-title">
        <div className="home-shell">
          <SectionHeading
            id="sdk-title"
            title="Use PostgreSQL from your stack."
            description="Open the root, create a schema, bind values, and read typed rows from Rust, Swift, Kotlin, React Native, or TypeScript."
          />
          <SdkCodeExplorer />
        </div>
      </section>

      <section className="home-section home-examples" aria-labelledby="examples-title">
        <div className="home-shell">
          <SectionHeading
            id="examples-title"
            title="See the integration boundaries in code."
            description="Four committed apps exercise native and WASIX paths through Tauri and Electron."
          />
          <div className="home-example-list">
            {examples.map((example, index) => (
              <article className="home-example-row" key={example.platform}>
                <span className="home-example-row__number" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="home-example-row__name">
                  <h3>{example.platform}</h3>
                  <code>{example.stack}</code>
                </div>
                <p>{example.proof}</p>
                <Link href={example.href} aria-label={`Inspect ${example.platform} source`}>
                  Source
                  <ArrowUpRight aria-hidden="true" />
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="home-close">
        <div className="home-shell home-close__inner">
          <div className="home-close__mark" aria-hidden="true">
            <OliphauntMark />
          </div>
          <div>
            <h2>Open an app-owned PostgreSQL root. Run the first product query.</h2>
            <div className="home-actions">
              <Link href="/docs/start" className="home-button home-button--light">
                Get started
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link href="/docs/learn/native-runtime" className="home-button home-button--dark-quiet">
                Read the runtime guide
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="home-footer">
        <div className="home-shell home-footer__inner">
          <OliphauntWordmark />
          <nav aria-label="Oliphaunt footer">
            <Link href="/docs/start">Get started</Link>
            <Link href="/docs/sdk">SDKs</Link>
            <Link href="/docs/reference/extensions">Extensions</Link>
            <Link href="/docs/reference/releases">Target support</Link>
            <Link href={`${githubBlob}/LICENSE`}>MIT license</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
