import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="oliphaunt-wordmark">
          <span className="oliphaunt-wordmark__mark" aria-hidden="true" />
          <span>{appName}</span>
        </span>
      ),
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
