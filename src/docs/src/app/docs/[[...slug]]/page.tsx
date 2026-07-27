import { getPageImage, getPageMarkdownUrl, source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';

function pageSlug(slug?: string[]) {
  return slug && slug.length > 0 ? slug : ['start'];
}

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(pageSlug(params.slug));
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const compactHeader = page.slugs.length > 1;
  const breadcrumbItems = [
    { label: 'Docs', href: '/docs' },
    ...page.slugs.map((slug, index) => ({
      label: slug
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' '),
      href: `/docs/${page.slugs.slice(0, index + 1).join('/')}`,
    })),
  ];

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      breadcrumb={{ enabled: false }}
      className="oliphaunt-doc-page"
    >
      <div
        className={
          compactHeader
            ? 'oliphaunt-doc-header oliphaunt-doc-header--compact not-prose'
            : 'oliphaunt-doc-header not-prose'
        }
      >
        <nav className="oliphaunt-doc-header__path" aria-label="Breadcrumb">
          <ol>
            {breadcrumbItems.map((item, index) => {
              const current = index === breadcrumbItems.length - 1;

              return (
                <li key={item.href}>
                  {current ? (
                    <span aria-current="page">{item.label}</span>
                  ) : (
                    <a href={item.href}>{item.label}</a>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <DocsTitle className="oliphaunt-doc-title">{page.data.title}</DocsTitle>
        <DocsDescription className="oliphaunt-doc-description">
          {page.data.description}
        </DocsDescription>
        <div className="oliphaunt-doc-actions">
          <MarkdownCopyButton markdownUrl={markdownUrl} />
          <ViewOptionsPopover markdownUrl={markdownUrl} />
        </div>
      </div>
      <DocsBody className="oliphaunt-doc-body">
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return [{ slug: [] }, ...source.generateParams()];
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(pageSlug(params.slug));
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page).url,
    },
  };
}
