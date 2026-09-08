import DocumentationPage from '../docs/[[...slug]]/page';

export default function HomePage() {
  return (
    <DocumentationPage
      params={Promise.resolve({ slug: ['start'] })}
      searchParams={Promise.resolve({})}
    />
  );
}
