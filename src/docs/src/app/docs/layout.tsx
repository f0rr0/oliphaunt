import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <>
      <a
        href="#nd-page"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-sm focus:bg-fd-background focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <DocsLayout
        tree={source.getPageTree()}
        {...baseOptions()}
        tabs={false}
        sidebar={{ collapsible: false }}
      >
        {children}
      </DocsLayout>
    </>
  );
}
