import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
} from 'fumadocs-ui/layouts/docs/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import { getPageImage, getPageMarkdownUrl, source } from '@/lib/source';

function pageSlug(slug?: string[]) {
  return slug && slug.length > 0 ? slug : ['start'];
}

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(pageSlug(params.slug));
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const breadcrumbItems = [
    { label: 'Docs', href: '/docs' },
    ...page.slugs.map((slug, index) => ({
      label: source.getPage(page.slugs.slice(0, index + 1))?.data.title ?? slug,
      href: `/docs/${page.slugs.slice(0, index + 1).join('/')}`,
    })),
  ];

  return (
    <DocsPage
      role="main"
      tabIndex={-1}
      toc={page.data.toc}
      full={page.data.full}
      breadcrumb={{ enabled: false }}
      footer={{ enabled: false }}
      tableOfContent={{ container: { className: 'pt-14 pe-8' } }}
      className="max-w-3xl gap-0 py-8 md:px-8 xl:pt-12 xl:pb-16"
    >
      <div className="oliphaunt-doc-header not-prose">
        <div className="mb-8 flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <nav className="oliphaunt-doc-header__path" aria-label="Breadcrumb">
            <ol>
              {breadcrumbItems.map((item, index) => {
                const current = index === breadcrumbItems.length - 1;

                return (
                  <li key={item.href}>
                    {current ? (
                      <span aria-current="page">{item.label}</span>
                    ) : (
                      <Link href={item.href}>{item.label}</Link>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <MarkdownCopyButton
            markdownUrl={markdownUrl}
            className="min-h-8 bg-transparent font-mono text-xs font-normal shadow-none"
          />
        </div>
        <div className="oliphaunt-title-row">
          <div className="min-w-0">
            <DocsTitle className="oliphaunt-doc-title">{page.data.title}</DocsTitle>
            <DocsDescription className="oliphaunt-doc-description">
              {page.data.description}
            </DocsDescription>
          </div>
          {page.slugs.join('/') === 'start' ? (
            <Image
              src={`${process.env.OLIPHAUNT_DOCS_BASE_PATH || ''}/img/elephant-engraving.webp`}
              width={1402}
              height={1122}
              alt=""
              className="oliphaunt-engraving"
              preload
            />
          ) : null}
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
