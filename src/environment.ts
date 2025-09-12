import env from 'env-var';

export const getStringOptional = (key: string) => env.get(key).asString() || undefined;
export const getString = (key: string) => env.get(key).required().asString();
export const getNumber = (key: string) => env.get(key).required().asIntPositive();
export const getBool = (key: string) => env.get(key).required().asBool();
export const getBoolOptional = (key: string) => env.get(key).asBool() || false;

export const DISCORD_APP_ID = getString('DISCORD_APP_ID');
export const DISCORD_BOT_TOKEN = getString('DISCORD_BOT_TOKEN');

export const DB_TYPE = getString('DB_TYPE') as 'sqlite' | 'postgres';
export const SQLITE_DB_PATH = DB_TYPE === 'sqlite' ? getString('SQLITE_DB_PATH') : undefined;
export const PG_CONNECTION_STRING = DB_TYPE === 'postgres' ? getString('PG_CONNECTION_STRING') : undefined;
