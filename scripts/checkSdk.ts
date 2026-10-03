/**
 * Fails when the committed spec or the generated SDK is not what the routes produce.
 * Run as the second half of `pnpm sdk:check`, after `pnpm sdk:generate` has rewritten both.
 *
 * `git status --porcelain` rather than `git diff --exit-code`, because a diff cannot see
 * an untracked file: a file the generator newly emits — after a hey-api upgrade, say —
 * would otherwise pass unnoticed. A script rather than a shell one-liner because pnpm runs
 * scripts through cmd.exe on Windows.
 *
 * The suite covers most of this now (`openApiSpec.test.ts`, `generatedSdkIsCurrent.test.ts`),
 * but both read the working tree. What only this sees is a generated file that is on disk
 * and was never committed.
 */

import { execFileSync } from 'node:child_process';

const GENERATED_PATHS = ['generated', 'packages/web-sdk/src/gen'];

const changes = execFileSync('git', ['status', '--porcelain', '--', ...GENERATED_PATHS], {
    encoding: 'utf8',
}).trim();

if (changes) {
    console.error(
        'The generated spec or SDK differs from what is committed. Commit the result of ' +
            '`pnpm sdk:generate`:\n' +
            changes
    );
    process.exit(1);
}

console.log('The spec and the SDK are up to date with the routes.');
