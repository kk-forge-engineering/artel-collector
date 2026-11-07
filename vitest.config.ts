import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.ts'],
    // The tests run in New York time, a zone west of UTC with daylight saving.
    // The tests then catch a local date that differs from the UTC date near
    // midnight, and they cross the March and November clock shifts.
    env: { TZ: 'America/New_York' },
    unstubGlobals: true,
    reporters: ['default', ['vitest-sonar-reporter', { outputFile: 'coverage/test-report.xml' }]],
    // On only under --coverage, which test:ci passes.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary', 'lcovonly'],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
