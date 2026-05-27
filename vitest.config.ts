import { defineConfig } from 'vitest/config';

/**
 * Test config. Coverage is scoped to `src/` (the published SDK surface);
 * `examples/` and `bin-stubs/` are tooling and excluded from the metric.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Re-export shim — nothing executable to cover.
      exclude: ['src/index.ts'],
      reporter: ['text', 'text-summary', 'json-summary'],
    },
  },
});
