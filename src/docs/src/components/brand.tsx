import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';

export function OliphauntMark({ className, ...props }: ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      aria-hidden="true"
      className={cn('oliphaunt-mark', className)}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M8.3 13.2c0-5.1 3.1-8.2 7.7-8.2s7.7 3.1 7.7 8.2v3.3c0 6.1-3.4 10.5-7.8 10.5-2.5 0-4.2-1.3-4.2-3.3 0-1.8 1.4-3 3.3-3h1.1v-8"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.1 9C5 9 3 11.1 3 14.1c0 3.1 2.1 5.4 5.3 5.4M23.9 9c3.1 0 5.1 2.1 5.1 5.1 0 3.1-2.1 5.4-5.3 5.4"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M9.4 17.2c-.7 2.3-2.3 3.5-4.5 3.2M22.6 17.2c.7 2.3 2.3 3.5 4.5 3.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="12.1" cy="12.7" r="1" fill="currentColor" />
      <circle cx="19.9" cy="12.7" r="1" fill="currentColor" />
    </svg>
  );
}

export function OliphauntWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('oliphaunt-wordmark', className)}>
      <span className="oliphaunt-wordmark__mark">
        <OliphauntMark />
      </span>
      <span>Oliphaunt</span>
    </span>
  );
}
