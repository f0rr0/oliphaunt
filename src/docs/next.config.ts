import { readFileSync } from 'node:fs';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const withMDX = createMDX();
const buildId =
  process.env.OLIPHAUNT_DOCS_BUILD_ID ??
  (process.env.OLIPHAUNT_DOCS_BUILD_ID_FILE
    ? readFileSync(process.env.OLIPHAUNT_DOCS_BUILD_ID_FILE, 'utf8').trim()
    : undefined);

const config: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  experimental: {
    optimizePackageImports: ['lucide-react', 'simple-icons'],
    ...(process.env.OLIPHAUNT_DOCS_BUILD_CPUS
      ? { cpus: Number(process.env.OLIPHAUNT_DOCS_BUILD_CPUS) }
      : {}),
  },
  ...(buildId ? { generateBuildId: async () => buildId } : {}),
  basePath: process.env.OLIPHAUNT_DOCS_BASE_PATH || undefined,
};

export default withMDX(config);
