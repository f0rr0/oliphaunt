'use client';

import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { type KeyboardEvent, useRef, useState } from 'react';

type StackOption = {
  id: string;
  label: string;
  file: string;
  code: string;
  href: string;
};

const stacks: StackOption[] = [
  {
    id: 'rust',
    label: 'Rust',
    file: 'database.rs',
    code: `let notes = db.query(
    r#"SELECT id, title, metadata
       FROM notes
       WHERE tags @> ARRAY['offline']
       ORDER BY updated_at DESC"#,
).await?;`,
    href: '/docs/sdk/rust',
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    file: 'database.ts',
    code: `const notes = await db.query(\`
  SELECT id, title, metadata
  FROM notes
  WHERE tags @> ARRAY['offline']
  ORDER BY updated_at DESC
\`);`,
    href: '/docs/sdk/typescript',
  },
  {
    id: 'swift',
    label: 'Swift',
    file: 'DatabaseService.swift',
    code: `let notes = try await database.query("""
    SELECT id, title, metadata
    FROM notes
    WHERE tags @> ARRAY['offline']
    ORDER BY updated_at DESC
    """)`,
    href: '/docs/sdk/swift',
  },
  {
    id: 'kotlin',
    label: 'Kotlin',
    file: 'DatabaseRepository.kt',
    code: `val notes = database.query(
    """
    SELECT id, title, metadata
    FROM notes
    WHERE tags @> ARRAY['offline']
    ORDER BY updated_at DESC
    """.trimIndent(),
)`,
    href: '/docs/sdk/kotlin',
  },
  {
    id: 'react-native',
    label: 'React Native',
    file: 'database.ts',
    code: `const notes = await db.query(\`
  SELECT id, title, metadata
  FROM notes
  WHERE tags @> ARRAY['offline']
  ORDER BY updated_at DESC
\`);`,
    href: '/docs/sdk/react-native',
  },
];

export function HomeStackExplorer() {
  const [activeId, setActiveId] = useState(stacks[0].id);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = stacks.find((stack) => stack.id === activeId) ?? stacks[0];

  function selectStack(nextIndex: number) {
    const normalizedIndex = (nextIndex + stacks.length) % stacks.length;
    setActiveId(stacks[normalizedIndex].id);
    tabRefs.current[normalizedIndex]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      selectStack(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      selectStack(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectStack(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectStack(stacks.length - 1);
    }
  }

  return (
    <div className="oliphaunt-stack-explorer">
      <div className="oliphaunt-stack-tabs" role="tablist" aria-label="Choose an app stack">
        {stacks.map((stack, index) => {
          const isActive = stack.id === active.id;

          return (
            <button
              key={stack.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              id={`stack-tab-${stack.id}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`stack-panel-${stack.id}`}
              tabIndex={isActive ? 0 : -1}
              className="oliphaunt-stack-tab"
              onClick={() => setActiveId(stack.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {stack.label}
            </button>
          );
        })}
      </div>

      <div
        id={`stack-panel-${active.id}`}
        role="tabpanel"
        aria-labelledby={`stack-tab-${active.id}`}
        className="oliphaunt-stack-panel"
      >
        <div className="oliphaunt-stack-code">
          <div className="oliphaunt-stack-code__bar">
            <span>{active.file}</span>
          </div>
          <pre aria-label={`${active.label} Oliphaunt query example`}>
            <code>{active.code}</code>
          </pre>
        </div>

        <Link href={active.href} className="oliphaunt-stack-guide-link">
          Open the {active.label} guide
          <ArrowUpRight aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
