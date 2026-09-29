import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { OliphauntMark } from '@/components/brand';
import { getPageImage, source } from '@/lib/source';

export const revalidate = false;

export async function GET(_req: Request, { params }: RouteContext<'/og/docs/[...slug]'>) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        padding: 64,
        background: '#111111',
        color: '#ededed',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          paddingBottom: 32,
          marginBottom: 48,
          borderBottom: '1px solid #303030',
        }}
      >
        <OliphauntMark width={40} height={40} fill="#ededed" />
        <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.04em' }}>oliphaunt</span>
        <span style={{ marginLeft: 'auto', fontSize: 20, color: '#a3a3a3' }}>Documentation</span>
      </div>
      <div style={{ fontSize: 64, lineHeight: 1.1, letterSpacing: '-0.025em' }}>
        {page.data.title}
      </div>
      <div style={{ marginTop: 24, fontSize: 28, lineHeight: 1.5, color: '#a3a3a3' }}>
        {page.data.description}
      </div>
      <div style={{ marginTop: 'auto', fontSize: 18, color: '#a3a3a3' }}>oliphaunt.dev / docs</div>
    </div>,
    {
      width: 1200,
      height: 630,
    },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImage(page).segments,
  }));
}
