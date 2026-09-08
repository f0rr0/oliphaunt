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
        text: 'GitHub',
        url: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
        external: true,
      },
    ],
  };
}
