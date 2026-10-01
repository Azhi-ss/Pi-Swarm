import os from 'node:os';
import { defineConfig } from 'vitest/config';

const cpuCount = os.availableParallelism?.() ?? os.cpus().length;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    // Non-watch runs otherwise take every CPU except one (19 on this 20-core
    // machine). Cap file workers so process-heavy tests stay inside the
    // timeout; smaller machines keep that CPU-minus-one count.
    maxWorkers: Math.min(8, Math.max(cpuCount - 1, 1)),
    // The extension graph transitively loads @earendil-works/pi-coding-agent
    // (~21 MB dist) on the first test of a file; under parallel CI load that
    // first load can exceed vitest's 5s default and cascade into later tests.
    testTimeout: 20_000,
  },
});
