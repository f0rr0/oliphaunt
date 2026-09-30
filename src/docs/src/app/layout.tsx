import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import type { Metadata } from 'next';
import { DM_Sans, Geist_Mono, Instrument_Serif } from 'next/font/google';

const sans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-oliphaunt-sans',
});

const mono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-oliphaunt-mono',
});

const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-oliphaunt-serif',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_OLIPHAUNT_DOCS_URL ?? 'https://oliphaunt.dev'),
  title: {
    default: 'Oliphaunt Docs',
    template: '%s | Oliphaunt',
  },
  description: 'Embedded PostgreSQL SDKs for native, Rust WASIX, and WASIX TypeScript apps.',
  icons: {
    icon: [{ url: '/img/favicon.svg', type: 'image/svg+xml' }],
    shortcut: '/img/favicon.svg',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${serif.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen antialiased">
        <RootProvider
          theme={{ defaultTheme: 'dark' }}
          search={{
            options: {
              type: 'static',
              api: `${process.env.OLIPHAUNT_DOCS_BASE_PATH || ''}/api/search`,
            },
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
