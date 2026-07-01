import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import indexFile from 'fumadocs-mdx/plugins/index-file';

export const docs = defineDocs({
  dir: '../../target/docs/site-docs',
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  plugins: [indexFile()],
  mdxOptions: {
    // Keep MDX options centralized here; generated docs stay in target/.
  },
});
