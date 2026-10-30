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
        // Not privileged. Keeps `guild.emojis` current, so an emoji added after startup is in
        // the dashboard's button emoji picker without a restart, and one deleted is dropped
        // from a post rather than refused by Discord.
        GatewayIntentBits.GuildExpressions,
    ],
    /*
     * `GuildMember` so GuildMemberRemove fires for a member who was not cached, which on
     * a large server is most of them; the flow engine's Member Leaves trigger needs it.
     * Its only other effects: GuildMemberUpdate for an uncached member emits with a
     * partial old member, and `guild.members.me` returns — and caches — a stub partial
     * with only `@everyone`'s permissions rather than null if the bot's own member ever
     * left the cache. Member names listens for the first and reads only the new member,
     * so the partial old one is never read. The second is safe only
     * because the bot's member arrives with every GUILD_CREATE and no member sweeper is
     * configured; adding one would need revisiting this.
     */
    partials: [Partials.Message, Partials.Reaction, Partials.GuildMember],
    /*
     * Nothing pings a role, @everyone or @here unless its own send says so. A send passing
     * `allowedMentions` replaces this whole object, so every send that sets its own is
     * unaffected. No send in the bot deliberately pings a role or everyone; the ones this
     * covers are text somebody else wrote reaching `content` — an AI reply echoing a
     * `<@&id>`, a flow's name on its button post. `repliedUser` stays on because Discord
     * defaults it to *off* whenever `allowed_mentions` is present, which would silently
     * stop every `message.reply` pinging the person replied to.
     */
    allowedMentions: { parse: ['users'], repliedUser: true },
});

DISCORD_CLIENT.token = DISCORD_BOT_TOKEN;

export { DISCORD_CLIENT };
