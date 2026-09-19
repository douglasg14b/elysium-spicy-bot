/**
 * Bot identity endpoint. Public — the login page brands itself from this before
 * there is a session to authenticate with. Pages stay URL-free.
 */

import { api } from './client';
import type { BotIdentity } from './types';

export function getBotIdentity(): Promise<BotIdentity> {
    return api.get<BotIdentity>('/api/bot');
}
