import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { sdkSurfaces } from '@/lib/docs-data';

export function SdkChooser() {
  return (
    <div className="sdk-grid not-prose">
      {sdkSurfaces.map((sdk) => (
        <Link className="sdk-link" href={`/docs/sdk/${sdk.id}`} key={sdk.id}>
          <span className="sdk-mark" aria-hidden="true">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d={sdk.icon} />
            </svg>
          </span>
          <span>
            <span className="sdk-title">{sdk.title}</span>
            <span className="sdk-description">{sdk.target}</span>
          </span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      ))}
    </div>
  );
}
