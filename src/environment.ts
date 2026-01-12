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
export const OPENAI_API_KEY = getString('OPENAI_API_KEY');
export const AI_MODEL = getStringOptional('AI_MODEL') || 'gpt-5.1-chat-latest';
export const AI_MAX_CONTEXT_MESSAGES = env.get('AI_MAX_CONTEXT_MESSAGES').asIntPositive() || 10;
