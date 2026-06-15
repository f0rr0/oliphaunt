import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
      url: '/',
    },
    links: [
      {
        text: 'Start',
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
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
