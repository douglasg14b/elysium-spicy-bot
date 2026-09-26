import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        /*
         * Two projects, split by file extension, because they need different globals.
         *
         * `node` is every suite this repo had before component tests: the bot, the API,
         * and the dashboard's extracted `.ts` logic. `dom` is `web/**\/*.test.tsx` only —
         * components rendered into jsdom through Testing Library.
         *
         * By extension rather than by folder so a component test can sit in the same
         * `__tests__` directory as the logic test for the module it renders, and so the
         * 500-odd plain dashboard tests keep running without a DOM they never needed.
         * jsdom is not free: it is a second of environment setup per file.
         *
         * `include` lives on each project rather than up here. `extends: true` merges
         * the root into each project with array concatenation, so a root `include` would
         * be *added* to the dom project's and hand it every `.ts` suite as well.
         */
        projects: [
            {
                extends: true,
                test: { name: 'node', include: ['**/*.test.ts'] },
            },
            {
                extends: true,
                test: {
                    name: 'dom',
                    include: ['web/src/**/*.test.tsx'],
                    environment: 'jsdom',
                    setupFiles: ['./web/src/__tests__/support/setupDom.ts'],
                },
            },
        ],
        /*
         * Replacing `exclude` drops Vitest defaults — keep `node_modules` / `dist` out or
         * `pnpm test` runs dependency suites.
         *
         * `.claude/worktrees/**` is the same hazard one step out. A git worktree created
         * *inside* the repo is a second checkout this glob walks into, and it has no
         * `node_modules` of its own, so its copies of our own files fail to resolve their
         * imports — one worktree turned `pnpm test` red with `Failed to load url
         * @tabler/icons-react`, pointing at a path nobody had edited. The failure names
         * a dependency rather than a worktree, so it reads as a broken install and sends
         * you to reinstall packages that are fine.
         *
         * Excluded rather than removing the worktree, because whether a worktree should
         * exist is its owner's call and this file's job is to not run other checkouts'
         * tests either way.
         */
        exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.claude/worktrees/**',
            '**/*.live.test.ts',
        ],
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
