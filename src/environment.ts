import env from 'env-var';

export const getStringOptional = (key: string) => env.get(key).asString() || undefined;
export const getString = (key: string) => env.get(key).required().asString();
export const getNumber = (key: string) => env.get(key).required().asIntPositive();
export const getBool = (key: string) => env.get(key).required().asBool();
export const getBoolOptional = (key: string) => env.get(key).asBool() || false;

export const ENV = getStringOptional('ENV') as 'development' | 'production' | undefined;

export const DISCORD_APP_ID = getString('DISCORD_APP_ID');
export const DISCORD_BOT_TOKEN = getString('DISCORD_BOT_TOKEN');

export const DB_TYPE = getString('DB_TYPE') as 'sqlite' | 'postgres';
export const SQLITE_DB_PATH = DB_TYPE === 'sqlite' ? getString('SQLITE_DB_PATH') : undefined;
export const PG_CONNECTION_STRING = DB_TYPE === 'postgres' ? getString('PG_CONNECTION_STRING') : undefined;

// AI Configuration
// OpenRouter is used for all reply generation (chat completions + the @openai/agents graph).
export const OPENROUTER_API_KEY = getString('OPENROUTER_API_KEY');
export const OPENROUTER_BASE_URL = getStringOptional('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1';
// OpenAI is still used directly for @openai/guardrails, which relies on the OpenAI
// Moderation API and is not proxied by OpenRouter.
export const OPENAI_API_KEY = getString('OPENAI_API_KEY');
// Model slug as understood by OpenRouter (provider-prefixed, e.g. "openai/gpt-5.1-chat-latest").
export const AI_MODEL = getStringOptional('AI_MODEL') || 'openai/gpt-5.1-chat-latest';
export const AI_MAX_CONTEXT_MESSAGES = env.get('AI_MAX_CONTEXT_MESSAGES').asIntPositive() || 50;
// ---------------------------------------------------------------------------
// Web dashboard (optional). See docs/adr/0001-web-server-in-bot-process.md.
// The web server runs in-process with the bot. Every var here is OPTIONAL: if the
// required set is incomplete, the bot skips starting the HTTP listener entirely,
// so bot-only deployments keep working with no new config. Never throw at load.
// ---------------------------------------------------------------------------
export const WEB_PORT = env.get('WEB_PORT').asIntPositive() || 8080;

/**
 * Port Vite serves the dashboard on in development.
 *
 * Read by `web/vite.config.ts`, which is the only thing that binds it — this
 * declaration exists so the API server can *name* it when an author arrives on
 * {@link WEB_PORT} expecting the dashboard, which is the mistake the two-port
 * split invites. Not a second source of truth: change it here and Vite follows.
 */
export const WEB_DEV_CLIENT_PORT = env.get('WEB_DEV_CLIENT_PORT').asIntPositive() || 5173;

const IS_DEVELOPMENT = ENV === 'development';

/**
 * Public origin the dashboard is served from, e.g. https://bot.example.com. Used
 * to build the OAuth redirect URI, so it must match a redirect registered on the
 * Discord application exactly.
 *
 * In development it defaults to localhost on {@link WEB_PORT} — there is nothing
 * to guess there. It is never defaulted in production: an origin that does not
 * match the deployment would break the OAuth round-trip in a confusing way, so
 * we would rather refuse to start the web server.
 */
export const WEB_PUBLIC_URL = getStringOptional('WEB_PUBLIC_URL') ?? (IS_DEVELOPMENT ? `http://localhost:${WEB_PORT}` : undefined);
/** Discord OAuth2 client secret (the app's secret, distinct from the bot token). */
export const DISCORD_OAUTH_CLIENT_SECRET = getStringOptional('DISCORD_OAUTH_CLIENT_SECRET');
/**
 * Secret used to sign the stateless session JWT cookie.
 *
 * Development falls back to a fixed throwaway value so the dashboard just runs.
 * Production must set a real one: sessions are stateless, so the secret IS the
 * security boundary, and a per-process random default would sign people out on
 * every restart.
 */
export const SESSION_SECRET =
    getStringOptional('SESSION_SECRET') ?? (IS_DEVELOPMENT ? 'dev-only-insecure-session-secret' : undefined);
/**
 * Optional comma-separated Discord user IDs that bypass per-guild permission checks.
 *
 * This is NOT a login gate. Who may sign in is decided by Discord: you get access to
 * the servers where you own, administer, or hold Manage Guild (see
 * `src/web/api/guildAccess.ts`). This list only exists so an operator can reach a
 * server they hold no role in. Empty is the normal case.
 */
export const ADMIN_DISCORD_IDS = (getStringOptional('ADMIN_DISCORD_IDS') || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

/**
 * The web server only starts when the full required web config is present.
 * DISCORD_APP_ID doubles as the OAuth client id (already required for the bot).
 */
export const WEB_ENABLED = Boolean(WEB_PUBLIC_URL && DISCORD_OAUTH_CLIENT_SECRET && SESSION_SECRET);

/**
 * Which required web env vars are missing, each with a note on where its value comes
 * from. The one that cannot be defaulted is a secret, so the startup log says where to
 * get it.
 */
export function getMissingWebEnv(): string[] {
    const missing: string[] = [];
    if (!WEB_PUBLIC_URL) missing.push('WEB_PUBLIC_URL (origin the dashboard is served from)');
    if (!DISCORD_OAUTH_CLIENT_SECRET) {
        missing.push(
            'DISCORD_OAUTH_CLIENT_SECRET (Discord Developer Portal → your app → OAuth2 → Client Secret)'
        );
    }
    if (!SESSION_SECRET) missing.push('SESSION_SECRET (any long random string)');
    return missing;
}

// Birthday scheduling always runs on Pacific Time by default.
// This can be overridden via env for ops emergencies, but there is no in-product setting for it.
export const BIRTHDAY_TIMEZONE = getStringOptional('BIRTHDAY_TIMEZONE') || 'America/Los_Angeles';
export const LEVELING_TIMEZONE = getStringOptional('LEVELING_TIMEZONE') || BIRTHDAY_TIMEZONE;
