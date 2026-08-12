import type { CSSProperties } from 'react';
import { WasixMark } from '@/components/brand';

export type UseCaseKind = 'knowledge' | 'field' | 'retrieval' | 'data';

const useCaseCaptions: Record<UseCaseKind, string> = {
  knowledge: 'Documents branch into revision history while staying connected to project metadata.',
  field: 'A field location intersects nearby assets inside a PostGIS search radius.',
  retrieval: 'A query vector converges on the nearest documents after relational filtering.',
  data: 'Imported data moves through PostgreSQL tables into an inspected result set.',
};

export function UseCaseVisual({ kind }: { kind: UseCaseKind }) {
  return (
    <figure className="home-use-signal" data-use-signal={kind}>
      <figcaption className="sr-only">{useCaseCaptions[kind]}</figcaption>

      {kind === 'knowledge' ? (
        <svg aria-hidden="true" viewBox="0 0 420 210">
          <path className="home-use-signal__guide" d="M70 101H171C206 101 205 52 240 52H349" />
          <path className="home-use-signal__guide" d="M171 101C206 101 205 157 240 157H349" />
          <path className="home-use-signal__trace" d="M70 101H171C206 101 205 52 240 52H349" />
          <g className="home-use-signal__node home-use-signal__node--source">
            <rect height="76" rx="18" width="92" x="28" y="63" />
            <path d="M48 85h38M48 101h52M48 117h30" />
          </g>
          <g className="home-use-signal__node home-use-signal__node--leaf">
            <rect height="54" rx="15" width="106" x="284" y="25" />
            <path d="M305 47h48M305 61h28" />
          </g>
          <g className="home-use-signal__node home-use-signal__node--leaf">
            <rect height="54" rx="15" width="106" x="284" y="130" />
            <path d="M305 152h52M305 166h34" />
          </g>
          <circle className="home-use-signal__pulse" cx="171" cy="101" r="8" />
        </svg>
      ) : null}

      {kind === 'field' ? (
        <svg aria-hidden="true" viewBox="0 0 420 210">
          <path className="home-use-signal__contour" d="M-8 180C48 110 119 130 145 75S260 18 300 72s81 66 132 15" />
          <path className="home-use-signal__contour" d="M-10 207C57 139 132 161 173 98S270 45 311 94s78 55 118 30" />
          <path className="home-use-signal__contour" d="M54 217c22-55 92-43 126-90s77-44 111-9 79 31 131-10" />
          <circle className="home-use-signal__radius" cx="228" cy="103" r="72" />
          <circle className="home-use-signal__radius home-use-signal__radius--inner" cx="228" cy="103" r="38" />
          <path className="home-use-signal__crosshair" d="M228 16v174M141 103h174" />
          <circle className="home-use-signal__target" cx="228" cy="103" r="9" />
          <circle className="home-use-signal__asset" cx="177" cy="74" r="5" />
          <circle className="home-use-signal__asset" cx="268" cy="126" r="5" />
          <circle className="home-use-signal__asset home-use-signal__asset--outside" cx="337" cy="55" r="5" />
        </svg>
      ) : null}

      {kind === 'retrieval' ? (
        <svg aria-hidden="true" viewBox="0 0 420 210">
          <path className="home-use-signal__vector-line" d="M55 164 156 114 224 97 310 49" />
          <path className="home-use-signal__vector-line" d="m55 164 151 2 59-38 101 9" />
          <path className="home-use-signal__vector-line home-use-signal__vector-line--active" d="M55 164 224 97" />
          <circle className="home-use-signal__query" cx="55" cy="164" r="13" />
          <circle className="home-use-signal__vector" cx="156" cy="114" r="7" />
          <circle className="home-use-signal__vector home-use-signal__vector--match" cx="224" cy="97" r="11" />
          <circle className="home-use-signal__vector" cx="310" cy="49" r="7" />
          <circle className="home-use-signal__vector" cx="206" cy="166" r="7" />
          <circle className="home-use-signal__vector" cx="265" cy="128" r="7" />
          <circle className="home-use-signal__vector" cx="366" cy="137" r="7" />
          <circle className="home-use-signal__vector" cx="124" cy="53" r="7" />
          <circle className="home-use-signal__match-ring" cx="224" cy="97" r="25" />
        </svg>
      ) : null}

      {kind === 'data' ? (
        <svg aria-hidden="true" viewBox="0 0 420 210">
          <g className="home-use-signal__table home-use-signal__table--back">
            <rect height="126" rx="17" width="188" x="66" y="29" />
            <path d="M66 66h188M119 66v89M186 66v89M82 87h20M136 87h31M203 87h30M82 110h20M136 110h31M203 110h30M82 133h20M136 133h31M203 133h30" />
          </g>
          <g className="home-use-signal__table home-use-signal__table--front">
            <rect height="114" rx="17" width="176" x="175" y="66" />
            <path d="M175 103h176M228 103v77M295 103v77M191 125h20M245 125h31M312 125h22M191 148h20M245 148h31M312 148h22" />
          </g>
          <path className="home-use-signal__cursor" d="m329 34 19 49 9-17 18-8-46-24Z" />
          <rect className="home-use-signal__selection" height="23" rx="6" width="67" x="228" y="103" />
        </svg>
      ) : null}
    </figure>
  );
}

export function PostgresEngineVisual() {
  return (
    <figure className="home-engine-visual">
      <figcaption className="sr-only">
        PostgreSQL SQL, relational storage, indexes, and write-ahead logging operate as one engine
        inside an application-owned boundary.
      </figcaption>
      <svg aria-hidden="true" className="home-engine-visual__field" viewBox="0 0 760 410">
        <path d="M-30 364C95 205 252 53 477 31c126-12 237 28 327 105" />
        <path d="M-7 402C126 243 271 105 484 83c116-12 217 23 300 90" />
        <path d="M60 430C176 288 306 166 492 144c95-11 184 14 259 63" />
        <circle cx="385" cy="228" r="154" />
        <circle cx="385" cy="228" r="112" />
      </svg>

      <div className="home-engine-visual__boundary" aria-hidden="true">
        <span>APP ROOT</span>
        <code>PGDATA + WAL</code>
      </div>

      <div className="home-engine-visual__core" aria-hidden="true">
        <div className="home-engine-visual__cap">
          <small>POSTGRESQL</small>
          <strong>18</strong>
        </div>
        <div className="home-engine-visual__layer home-engine-visual__layer--sql">
          <span>SQL</span><span>types</span><span>transactions</span>
        </div>
        <div className="home-engine-visual__layer home-engine-visual__layer--data">
          <span>relations</span><span>indexes</span><span>JSONB</span>
        </div>
        <div className="home-engine-visual__layer home-engine-visual__layer--wal">
          <span>WAL</span><span>recovery</span>
        </div>
      </div>

      <div className="home-engine-visual__commit" aria-hidden="true">
        <span />
        <code>COMMIT</code>
      </div>
      <div className="home-engine-visual__reopen" aria-hidden="true">
        <span />
        <code>REOPEN</code>
      </div>
    </figure>
  );
}

export function ExtensionEcosystemVisual() {
  const extensions = [
    ['PostGIS', 'spatial'],
    ['pgvector', 'vectors'],
    ['FTS', 'search'],
    ['pg_trgm', 'matching'],
    ['pgcrypto', 'crypto'],
    ['UUIDv7', 'identity'],
  ] as const;

  return (
    <figure className="home-extension-orbit">
      <figcaption className="sr-only">
        Verified PostgreSQL extensions dock into the same embedded engine across supported target
        profiles.
      </figcaption>
      <svg aria-hidden="true" viewBox="0 0 540 330">
        <ellipse cx="270" cy="165" rx="202" ry="118" />
        <ellipse cx="270" cy="165" rx="139" ry="78" />
        <path d="M73 118C128 34 245 23 347 49" />
        <path d="M462 220c-55 79-165 101-266 67" />
      </svg>
      <div className="home-extension-orbit__core" aria-hidden="true">
        <small>POSTGRESQL</small>
        <strong>18</strong>
      </div>
      <ul>
        {extensions.map(([name, capability], index) => (
          <li key={name} style={{ '--extension-index': index } as CSSProperties}>
            <i aria-hidden="true" />
            <code>{name}</code>
            <small>{capability}</small>
          </li>
        ))}
      </ul>
      <p>Target-verified extension builds</p>
    </figure>
  );
}

export function RuntimeFamilyVisual() {
  return (
    <figure className="home-runtime-family">
      <figcaption className="sr-only">
        Native and WASIX runtime families both carry a PostgreSQL 18 engine, with capabilities
        bounded by the selected target.
      </figcaption>
      <svg aria-hidden="true" className="home-runtime-family__routes" viewBox="0 0 520 330">
        <path d="M260 166C205 166 192 96 130 96H52" />
        <path d="M260 166C315 166 328 234 390 234H468" />
      </svg>
      <div className="home-runtime-family__postgres" aria-hidden="true">
        <small>ONE MODEL</small>
        <strong>PG</strong>
        <span>18</span>
      </div>
      <div className="home-runtime-family__native">
        <span className="home-runtime-family__native-mark" aria-hidden="true">
          <i /><i /><i />
        </span>
        <div><strong>Native</strong><small>direct · broker · server</small></div>
      </div>
      <div className="home-runtime-family__wasix">
        <WasixMark />
        <div><strong>WASIX</strong><small>portable runtime assets</small></div>
      </div>
      <div className="home-runtime-family__surface" aria-hidden="true">
        <span>direct SDK calls</span>
        <span>local PostgreSQL URL *</span>
      </div>
    </figure>
  );
}
