import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['**/*.test.ts'],
        // Replacing `exclude` drops Vitest defaults — keep `node_modules` / `dist` out or `pnpm test` runs dependency suites.
        exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
        setupFiles: ['./vitest.setup.ts'],
        /**
         * Eighteen test files call `ensureBlocksDiscovered`, and discovery is a
         * real filesystem scan plus a dynamic import per block directory —
         * ~1.5s warm and alone, against Vitest's 5s default. Under parallel load
         * and a cold filesystem cache that margin closes and a *different*
         * untouched file times out, which reads as flake and gets re-run away.
         *
         * Raised rather than fixed at the source because the scan is genuinely
         * slow, not hung: the budget was wrong, not the work.
         *
         * **The fix this comment used to name is already done and does not
         * help.** `registry.ts` memoizes discovery in a module-level promise, so
         * it genuinely does run once per *process* — but Vitest gives each test
         * file its own module registry, so every file re-imports all 15 blocks
         * anyway. A full run reports ~114s of `collect` against ~60s of tests.
         * Anyone reading "cache it once per process" as the outstanding work
         * will find it already written and conclude the diagnosis is wrong.
         *
         * What would actually work, unchosen because neither is free:
         *   - `poolOptions.threads.singleThread` or a shared setup file, so one
         *     import graph serves every file. Trades isolation for speed, and
         *     the isolation is what keeps `blockRegistryReadBeforeDiscovery`
         *     honest — it asserts on the *unpopulated* registry.
         *   - Discovery reading a generated manifest instead of importing every
         *     directory. Fast, but reintroduces a build step between writing a
         *     block and it existing, which is the thing step 1 removed.
         *
         * Tracked in the build-order doc's carried-forward list. The symptom is
         * worst on a cold cache, so it reproduces on a fresh clone and after a
         * reboot — the moments a red suite is least expected and most confusing.
         */
        testTimeout: 20_000,
    },
});
