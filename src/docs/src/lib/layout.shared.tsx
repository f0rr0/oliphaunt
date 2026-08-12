import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { OliphauntWordmark } from '@/components/brand';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <OliphauntWordmark />,
      url: '/',
    },
    links: [
      {
        text: 'Get started',
        url: '/docs/start',
      },
      {
        text: 'SDKs',
        url: '/docs/sdk',
      },
      {
        text: 'Learn',
        url: '/docs/learn',
      },
      {
        text: 'Reference',
        url: '/docs/reference',
      },
      {
        text: 'GitHub',
        url: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
        external: true,
      },
    ],
  };
}
