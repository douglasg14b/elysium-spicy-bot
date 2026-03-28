/**
 * Default env for Vitest so importing app modules (e.g. `database.ts` → `environment.ts`)
 * does not require real Discord/DB/OpenAI credentials in CI or local runs without `.env.local`.
 * Use `??=` so explicitly set values in the shell or per-test stubs win.
 */
process.env.DISCORD_APP_ID ??= "000000000000000000";
process.env.DISCORD_BOT_TOKEN ??= "vitest-discord-bot-token";
process.env.DB_TYPE ??= "sqlite";
process.env.SQLITE_DB_PATH ??= ":memory:";
process.env.OPENAI_API_KEY ??= "sk-vitest-fake-openai-key";
