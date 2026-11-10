import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SlashCommandBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { BOT_FEATURES, FEATURE_GUIDES } from '../botFeatures';

/** The dashboard's routes, as `web/src/App.tsx` declares them. */
function dashboardRoutes(): Set<string> {
    const app = readFileSync(fileURLToPath(new URL('../../../../../web/src/App.tsx', import.meta.url)), 'utf8');
    return new Set([...app.matchAll(/path="([^"]+)"/g)].map((match) => match[1]));
}

describe('feature guides', () => {
    it('point only at dashboard pages that exist', () => {
        const routes = dashboardRoutes();
        const pages = BOT_FEATURES.flatMap((feature) => FEATURE_GUIDES[feature].dashboardPages.map((page) => page.path));
        expect(pages.length).toBeGreaterThan(0);
        expect(pages.filter((path) => !routes.has(path))).toEqual([]);
    });

    it('name every slash command the bot defines in some guide', async () => {
        const guided = new Set(
            BOT_FEATURES.flatMap((feature) => FEATURE_GUIDES[feature].commands.map((command) => command.toJSON().name))
        );
        expect([...(await definedSlashCommands())].filter((name) => !guided.has(name))).toEqual([]);
    });
});

/** Built but never registered: `bot.ts` registers `/flash-chat` instead. */
const UNREGISTERED_COMMANDS = new Set(['flash-config']);

/**
 * Every slash command a module under `src/` builds and exports, by name. Imports each such
 * module, so a command module must stay free of import-time side effects (as they are).
 */
async function definedSlashCommands(): Promise<Set<string>> {
    const srcRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' }).filter(
        (file) => file.endsWith('.ts') && !file.includes('__tests__') && readFileSync(join(srcRoot, file), 'utf8').includes('new SlashCommandBuilder()')
    );
    const names = new Set<string>();
    for (const file of files) {
        const exported: Record<string, unknown> = await import(pathToFileURL(join(srcRoot, file)).href);
        for (const value of Object.values(exported)) {
            if (value instanceof SlashCommandBuilder && !UNREGISTERED_COMMANDS.has(value.name)) names.add(value.name);
        }
    }
    return names;
}
