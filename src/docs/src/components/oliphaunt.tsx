import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { sdkSurfaces } from '@/lib/docs-data';

export function SdkChooser() {
  return (
    <div className="sdk-grid not-prose my-6 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
      {sdkSurfaces.map((sdk) => (
        <Link
          className="sdk-link group grid grid-cols-[24px_minmax(0,1fr)_16px] items-center gap-4 border-b border-fd-border py-5 text-fd-foreground no-underline"
          href={`/docs/sdk/${sdk.id}`}
          key={sdk.id}
        >
          <span className="text-fd-muted-foreground" aria-hidden="true">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d={sdk.icon} />
            </svg>
          </span>
          <span>
            <span className="block text-base font-medium group-hover:underline underline-offset-4">
              {sdk.title}
            </span>
            <span className="mt-1 block text-sm leading-5 text-fd-muted-foreground">
              {sdk.target}
            </span>
          </span>
          <ArrowRight
            size={16}
            strokeWidth={1.5}
            className="text-fd-muted-foreground"
            aria-hidden="true"
          />
        </Link>
      ))}
    </div>
  );
}
