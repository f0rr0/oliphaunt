import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@oliphaunt/wasix-ts/internal/tools': fileURLToPath(
        new URL('./src/__tests__/wasix-ts-runtime.ts', import.meta.url),
      ),
    },
  },
});
