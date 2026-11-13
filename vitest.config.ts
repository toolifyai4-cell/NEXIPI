import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    setupFiles: [resolve(__dirname, 'apps/vscode-extension/src/test-setup.ts'), resolve(__dirname, 'packages/ui/src/test-setup.ts')],
  },
});
