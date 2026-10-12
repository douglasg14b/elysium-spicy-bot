/**
 * Fake values for every variable `src/environment.ts` requires, so the bot's modules can
 * be imported without real Discord/DB/OpenAI credentials or a `.env.local`.
 *
 * Side effect only. Loaded by `vitest.setup.ts` for the test suite and by
 * `scripts/emitOpenApi.ts`, which imports the route tree to build the OpenAPI spec — one
 * list, so a newly required variable is stubbed for both or neither. `??=` so values set
 * in the shell or by a test win. Import it before anything that reaches `environment.ts`,
 * which reads the variables at import time.
 */
process.env.DISCORD_APP_ID ??= '000000000000000000';
process.env.DISCORD_BOT_TOKEN ??= 'vitest-discord-bot-token';
process.env.DB_TYPE ??= 'sqlite';
process.env.SQLITE_DB_PATH ??= ':memory:';
process.env.OPENAI_API_KEY ??= 'sk-vitest-fake-openai-key';
process.env.OPENROUTER_API_KEY ??= 'sk-vitest-fake-openrouter-key';

export {};
