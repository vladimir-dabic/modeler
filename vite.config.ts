import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
