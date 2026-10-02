import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { DISCORD_BOT_TOKEN } from './environment';

const DISCORD_CLIENT = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
    ],
    /*
     * `GuildMember` so GuildMemberRemove fires for a member who was not cached, which on
     * a large server is most of them; the flow engine's Member Leaves trigger needs it.
     * Its only other effects: GuildMemberUpdate for an uncached member emits with a
     * partial old member, and `guild.members.me` returns — and caches — a stub partial
     * with only `@everyone`'s permissions rather than null if the bot's own member ever
     * left the cache. Nothing here listens for the first. The second is safe only
     * because the bot's member arrives with every GUILD_CREATE and no member sweeper is
     * configured; adding one would need revisiting this.
     */
    partials: [Partials.Message, Partials.Reaction, Partials.GuildMember],
});

DISCORD_CLIENT.token = DISCORD_BOT_TOKEN;

export { DISCORD_CLIENT };
