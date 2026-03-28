import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['**/*.test.ts'],
        // Replacing `exclude` drops Vitest defaults — keep `node_modules` / `dist` out or `pnpm test` runs dependency suites.
        exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
        setupFiles: ['./vitest.setup.ts'],
    },
});
