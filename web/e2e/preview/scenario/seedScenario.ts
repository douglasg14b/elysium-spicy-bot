import type { Guild } from 'discord.js';
import type { TestDiscord } from '../../../../src/shared/__tests__/support/testDiscord';
import type { PreviewPage } from '../previewPages';
import type { SeedApi } from './seedApi';
import { seedDiscord, type ScenarioGuild } from './seedDiscord';
import { seedFlows } from './seedFlows';
import { seedSettings } from './seedSettings';

export type { PreviewPage };

export interface SeedContext {
    readonly discord: TestDiscord;
    readonly guild: ScenarioGuild;
    /** The bot's own copy of the guild, for reading ids the bot created. */
    readonly clientGuild: Guild;
    readonly api: SeedApi;
}

/**
 * The preview's one guild, in two halves because they happen either side of the client
 * connecting: Discord state first, so it arrives in the handshake the way a real guild's
 * does, then the bot's data, written through the API once the bot can answer.
 *
 * Each data step owns one area of the dashboard and returns the pages it made worth
 * looking at. Add a step beside these rather than growing one: a step per area is what
 * lets two people extend the seed without editing the same file.
 */
export const seedScenario = {
    discord: seedDiscord,
    async data(context: SeedContext): Promise<PreviewPage[]> {
        const pages: PreviewPage[] = [];
        pages.push(...(await seedSettings(context)));
        pages.push(...(await seedFlows(context)));
        return pages;
    },
};
