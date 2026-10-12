/**
 * Default env for Vitest so importing app modules (e.g. `database.ts` → `environment.ts`)
 * does not require real Discord/DB/OpenAI credentials in CI or local runs without `.env.local`.
 * The stubs live in `stubRequiredEnv.ts`, shared with the OpenAPI emit script; they use `??=`
 * so explicitly set values in the shell or per-test stubs win.
 */
import './stubRequiredEnv';
