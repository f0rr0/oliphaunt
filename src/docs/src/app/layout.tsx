import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import type { Metadata } from 'next';

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-oliphaunt-sans',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-oliphaunt-mono',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_OLIPHAUNT_DOCS_URL ?? 'https://oliphaunt.dev'),
  title: {
    default: 'Oliphaunt Docs',
    template: '%s | Oliphaunt',
  },
  description:
    'Embedded PostgreSQL SDKs for Rust, Swift, Kotlin, React Native, TypeScript, and WASM apps.',
  icons: {
    icon: [{ url: '/img/favicon.svg', type: 'image/svg+xml' }],
    shortcut: '/img/favicon.svg',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
