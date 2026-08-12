import type { ComponentPropsWithoutRef, ReactNode } from 'react';

type BentoTone = 'paper' | 'warm' | 'mint' | 'blue' | 'ink' | 'soft-ink';

type BentoCardProps = ComponentPropsWithoutRef<'article'> & {
  children: ReactNode;
  tone?: BentoTone;
};

type BentoCardCopyProps = {
  label?: string;
  title: string;
  description: string;
  headingLevel?: 'h2' | 'h3';
};

const surfaces = ['Tauri', 'Electron', 'iOS + macOS', 'Android', 'React Native', 'WebAssembly'];

const modelFeatures = [
  ['jsonb', 'metadata'],
  ['text[]', 'tags'],
  ['timestamptz', 'history'],
  ['GIN', 'retrieval'],
  ['generated', 'derived data'],
];

export function BentoCard({ children, className = '', tone = 'paper', ...props }: BentoCardProps) {
  return (
    <article
      className={`oliphaunt-wow-card oliphaunt-wow-card--${tone} ${className}`.trim()}
      {...props}
    >
      {children}
    </article>
  );
}

export function BentoCardCopy({
  label,
  title,
  description,
  headingLevel = 'h3',
}: BentoCardCopyProps) {
  const Heading = headingLevel;

  return (
    <header className="oliphaunt-wow-card-copy">
      {label ? <p>{label}</p> : null}
      <Heading>{title}</Heading>
      <p>{description}</p>
    </header>
  );
}

export function HeroQueryArtifact() {
  return (
    <figure className="oliphaunt-wow-query">
      <figcaption className="sr-only">
        A local PostgreSQL query combining vector similarity with a relational project filter.
      </figcaption>
      <pre>
        <code>
          <span>
            <strong>SELECT</strong> title, 1 - (embedding &lt;=&gt; $query) <em>AS</em> relevance
          </span>
          <span>
            <strong>FROM</strong> documents
          </span>
          <span>
            <strong>WHERE</strong> project_id = $current
          </span>
          <span>
            <strong>ORDER BY</strong> relevance DESC <strong>LIMIT</strong> 3;
          </span>
        </code>
      </pre>
      <div className="oliphaunt-wow-query__results" aria-label="Query results">
        <div>
          <span>Design brief</span>
          <strong>0.94</strong>
        </div>
        <div>
          <span>Research notes</span>
          <strong>0.88</strong>
        </div>
        <div>
          <span>Project decisions</span>
          <strong>0.82</strong>
        </div>
      </div>
    </figure>
  );
}

export function AppSurfaceRail() {
  return (
    <ul className="oliphaunt-wow-surface-rail" aria-label="Supported application surfaces">
      {surfaces.map((surface) => (
        <li key={surface}>{surface}</li>
      ))}
    </ul>
  );
}

export function RelationshipArtifact() {
  return (
    <figure className="oliphaunt-wow-relations">
      <figcaption className="sr-only">
        A relational product model connecting projects, documents, revisions, and tags.
      </figcaption>
      <div className="oliphaunt-wow-relations__node oliphaunt-wow-relations__node--project">
        <span>projects</span>
        <code>id · owner · state</code>
      </div>
      <div className="oliphaunt-wow-relations__node oliphaunt-wow-relations__node--document">
        <span>documents</span>
        <code>project_id · body · metadata</code>
      </div>
      <div className="oliphaunt-wow-relations__node oliphaunt-wow-relations__node--revision">
        <span>revisions</span>
        <code>document_id · author · created_at</code>
      </div>
      <div className="oliphaunt-wow-relations__node oliphaunt-wow-relations__node--tag">
        <span>tags</span>
        <code>document_id · value</code>
      </div>
      <svg aria-hidden="true" viewBox="0 0 640 300" preserveAspectRatio="none">
        <path d="M176 64 C260 64 240 132 322 132" />
        <path d="M392 160 C392 206 285 202 285 248" />
        <path d="M440 160 C455 206 530 204 530 246" />
        <circle cx="176" cy="64" r="4" />
        <circle cx="322" cy="132" r="4" />
        <circle cx="285" cy="248" r="4" />
        <circle cx="530" cy="246" r="4" />
      </svg>
    </figure>
  );
}

export function LocalDataArtifact() {
  return (
    <figure className="oliphaunt-wow-local-data">
      <figcaption className="sr-only">
        Local reads and writes flowing between a product and its PostgreSQL data.
      </figcaption>
      <div className="oliphaunt-wow-local-data__pulse" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="oliphaunt-wow-local-data__statement">
        <code>INSERT</code>
        <span>saved locally</span>
      </div>
      <div className="oliphaunt-wow-local-data__statement">
        <code>SELECT</code>
        <span>available locally</span>
      </div>
    </figure>
  );
}

export function ModelInventory() {
  return (
    <dl className="oliphaunt-wow-model-inventory">
      {modelFeatures.map(([type, purpose]) => (
        <div key={type}>
          <dt>{type}</dt>
          <dd>{purpose}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SearchArtifact() {
  return (
    <figure className="oliphaunt-wow-search-artifact">
      <figcaption className="sr-only">A search result ranked with several signals.</figcaption>
      <div className="oliphaunt-wow-search-artifact__query">
        <span aria-hidden="true" />
        <code>offline research</code>
      </div>
      <div className="oliphaunt-wow-search-artifact__result">
        <div>
          <strong>Field study: North coast</strong>
          <span>Project Atlas · updated today</span>
        </div>
        <dl>
          <div>
            <dt>text</dt>
            <dd>0.91</dd>
          </div>
          <div>
            <dt>vector</dt>
            <dd>0.87</dd>
          </div>
          <div>
            <dt>project</dt>
            <dd>match</dd>
          </div>
        </dl>
      </div>
    </figure>
  );
}

export function LifecycleArtifact() {
  const states = [
    ['Open', 'database ready'],
    ['Work', 'transactions commit'],
    ['Pause', 'lifecycle coordinated'],
    ['Return', 'WAL recovery'],
  ];

  return (
    <ol className="oliphaunt-wow-lifecycle-artifact">
      {states.map(([title, detail]) => (
        <li key={title}>
          <span aria-hidden="true" />
          <div>
            <strong>{title}</strong>
            <small>{detail}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}
