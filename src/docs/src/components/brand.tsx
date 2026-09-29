import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';

export function OliphauntMark({ className, ...props }: ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      aria-hidden="true"
      className={cn('oliphaunt-mark', className)}
      viewBox="0 0 32 32"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        fillRule="evenodd"
        d="M3 15C3 7.82 8.82 2 16 2s13 5.82 13 13v8a7 7 0 0 1-7 7h-5v-6h5a1 1 0 0 0 1-1v-8a7 7 0 1 0-7 7h1v6h-1C8.82 28 3 22.18 3 15Z"
      />
    </svg>
  );
}

export function OliphauntWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('oliphaunt-wordmark', className)}>
      <OliphauntMark />
      <span>oliphaunt</span>
    </span>
  );
}
