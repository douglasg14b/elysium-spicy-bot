import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['**/*.test.ts'],
        // Replacing `exclude` drops Vitest defaults — keep `node_modules` / `dist` out or `pnpm test` runs dependency suites.
        exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
        setupFiles: ['./vitest.setup.ts'],
        /**
         * Ten test files each call `ensureBlocksDiscovered`, and discovery is a
         * real filesystem scan plus a dynamic import per block directory —
         * ~2-3.5s on Windows, against Vitest's 5s default. Under parallel load
         * that margin closes and a *different* untouched file times out on
         * roughly half of runs, which reads as flake and gets re-run away.
         *
         * Raised rather than fixed at the source because the scan is genuinely
         * slow, not hung: the budget was wrong, not the work. The real fix is
         * for discovery to be cached once per process instead of per test file
         * — worth doing when something else touches the registry, and tracked
         * in the build-order doc's carried-forward list.
         */
        testTimeout: 20_000,
    },
});
