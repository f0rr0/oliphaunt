import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { sdkSurfaces } from '@/lib/docs-data';

export function SdkChooser() {
  return (
    <div className="sdk-grid not-prose">
      {sdkSurfaces.map((sdk) => (
        <Link
          className="sdk-link group grid grid-cols-[minmax(0,1fr)_16px] items-center gap-4 border-b border-fd-border text-fd-foreground no-underline"
          href={`/docs/sdk/${sdk.id}`}
          key={sdk.id}
        >
          <span>
            <span className="block text-base leading-6 font-medium group-hover:underline underline-offset-4">
              {sdk.title}
            </span>
            <span className="block text-sm leading-6 text-fd-muted-foreground">{sdk.target}</span>
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
