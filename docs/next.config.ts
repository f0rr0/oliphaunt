import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const withMDX = createMDX();

const config: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  experimental: {
    optimizePackageImports: ['lucide-react', 'simple-icons'],
  },
  basePath: process.env.OLIPHAUNT_DOCS_BASE_PATH || undefined,
};

export default withMDX(config);
