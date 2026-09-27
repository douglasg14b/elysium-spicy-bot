import { Client, GatewayIntentBits, type RESTOptions } from 'discord.js';

/** Not a real credential. REST refuses to send an authenticated request without some token. */
const FAKE_BOT_TOKEN = 'test-discord-not-a-real-token';

/**
 * A real discord.js `Client` whose only network edge is the harness transport.
 *
 * The intents are the ones whose events the harness dispatches. Nothing enforces them
 * offline, but a client declaring intents it never receives events for would misdescribe
 * what the tests exercise.
 */
export function createTestClient(makeRequest: RESTOptions['makeRequest']): Client {
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    });
    return redirectToTransport(client, makeRequest);
}

/**
 * Point an existing client's REST at the harness transport, so the harness can drive a
 * client product code already holds, such as `DISCORD_CLIENT`.
 *
 * `@discordjs/rest` reads `options.makeRequest` on every request rather than capturing it
 * at construction, so replacing it covers every later call. The client must never be
 * logged in: `login()` is what opens the gateway socket, so skipping it is what keeps the
 * gateway offline. The token is set by hand for the same reason `login()` would have set
 * it: `@discordjs/rest` throws on an authenticated route without one.
 */
export function redirectToTransport(client: Client, makeRequest: RESTOptions['makeRequest']): Client {
    client.rest.options.makeRequest = makeRequest;
    client.token = FAKE_BOT_TOKEN;
    client.rest.setToken(FAKE_BOT_TOKEN);
    return client;
}
