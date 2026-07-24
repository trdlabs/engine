import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Determinism: no parallel-order dependence in assertions, but keep the reporter stable.
    reporters: ['default'],
  },
});
