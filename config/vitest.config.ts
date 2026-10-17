import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    env: { NODE_ENV: 'test' },
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 80,
        'src/server/auth.ts': { lines: 100 },
        'src/server/safe-fetch.ts': { lines: 100 },
      },
      include: ['src/domain/**', 'src/storage/**', 'src/server/**', 'src/client/**'],
      exclude: ['src/storage/cli.ts'],
      reporter: ['text', 'json-summary', 'html'],
    },
  },
});
