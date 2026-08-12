import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
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
