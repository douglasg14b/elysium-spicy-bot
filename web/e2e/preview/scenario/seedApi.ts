import type { Hono } from 'hono';
import type { TestDiscord } from '../../../../src/shared/__tests__/support/testDiscord';
import type { AppEnv } from '../../../../src/web/types';

/** The dashboard API, called the way the dashboard calls it. */
export interface SeedApi {
    /** Send one request and return the parsed body. Anything but a 2xx throws, with the route's own words. */
    send<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T>;
}

/**
 * Seed through the routes rather than the repos where a route exists, so the preview holds
 * what an operator could have made: every write passes the validation, normalisation and
 * side effects a real save does. A seed written straight to tables can hold a state the
 * product never produces, and a page that looks wrong on one says nothing.
 */
export function createSeedApi(app: Hono<AppEnv>, discord: TestDiscord): SeedApi {
    return {
        async send<T>(method: string, path: string, body?: unknown): Promise<T> {
            const response = await app.request(path, {
                method,
                headers: body === undefined ? undefined : { 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            discord.flushGateway();
            const text = await response.text();
            if (!response.ok) {
                throw new Error(`Seeding failed: ${method} ${path} answered ${response.status}: ${text}`);
            }
            return (text ? JSON.parse(text) : undefined) as T;
        },
    };
}
