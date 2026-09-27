import type {
    ServerChannel,
    ServerGuild,
    ServerMember,
    ServerRole,
    TestDiscord,
} from '../../../../src/shared/__tests__/support/testDiscord';
import type { DashboardOperator } from '../../support/dashboardApp';

/** The guild the preview seeds, with the handles later seeding steps refer to. */
export interface ScenarioGuild {
    readonly guild: ServerGuild;
    readonly operator: DashboardOperator;
    readonly roles: {
        readonly staff: ServerRole;
        readonly moderators: ServerRole;
        readonly verified: ServerRole;
        readonly member: ServerRole;
    };
    readonly channels: {
        readonly rules: ServerChannel;
        readonly introductions: ServerChannel;
        readonly general: ServerChannel;
        readonly modLog: ServerChannel;
        readonly staffCategory: ServerChannel;
    };
    readonly members: readonly ServerMember[];
}

/*
 * Names are chosen to stress layout, not to be realistic on average: a guild name long
 * enough to crowd a header, role and channel names at Discord's limits, and a list long
 * enough to scroll. The shorter ones are there so a page shows both at once.
 */
const GUILD_NAME = 'The Velvet Rope · After Dark Social & Kink Education Collective';
const LONGEST_CHANNEL_NAME = 'a-channel-name-so-long-it-should-never-have-been-allowed-but-discord-lets-you-go-to-one-hundred';
const FLAVOUR_ROLES = [
    'Brat',
    'Switch',
    'Rope Bunny',
    'Dungeon Monitor — Weekend Night Shift (Sat & Sun, 10pm–4am)',
    'Munch Organiser',
    'Newbie (please be gentle, still learning the ropes)',
    'Photographer',
    'DJ',
    'Event Host',
    'Consent Educator',
    'Voice Chat Regular',
    'Night Owl',
    'Aftercare Squad',
    'Partner of a Member',
];

/** Build the Discord side before the client starts, so it arrives in the handshake like a real guild would. */
export function seedDiscord(discord: TestDiscord): ScenarioGuild {
    const guild = discord.createGuild({
        name: GUILD_NAME,
        bot: { permissions: ['ManageChannels', 'ManageRoles', 'SendMessages', 'ViewChannel', 'EmbedLinks'] },
    });

    const staff = guild.createRole({ name: 'Staff' });
    const moderators = guild.createRole({ name: 'Moderators' });
    const verified = guild.createRole({ name: 'Verified Adult (18+, ID checked by staff)' });
    const member = guild.createRole({ name: 'Member' });
    for (const name of FLAVOUR_ROLES) guild.createRole({ name });

    const welcome = guild.createCategory({ name: 'Welcome' });
    const rules = guild.createTextChannel({ name: 'rules', parent: welcome });
    const introductions = guild.createTextChannel({ name: 'introductions', parent: welcome });

    const community = guild.createCategory({ name: 'Community — Chat, Memes, and General Degeneracy' });
    const general = guild.createTextChannel({ name: 'general-chat', parent: community });
    for (const name of ['memes-and-shitposts', 'selfies-sfw', 'selfies-nsfw', 'events-and-munches', LONGEST_CHANNEL_NAME]) {
        guild.createTextChannel({ name, parent: community });
    }

    const staffCategory = guild.createCategory({ name: 'Staff Only' });
    const modLog = guild.createTextChannel({ name: 'mod-log', parent: staffCategory });
    guild.createTextChannel({ name: 'staff-chat', parent: staffCategory });
    guild.createTextChannel({ name: 'uncategorised-channel' });

    const operator = guild.createMember({ username: 'velvet_admin', roles: [staff] });
    const members = [
        guild.createMember({ username: 'brattiest_brat_in_the_whole_server', roles: [member, verified] }),
        guild.createMember({ username: 'rope_bunny', roles: [member] }),
        guild.createMember({ username: 'mx.switch', roles: [member, verified, moderators] }),
    ];

    return {
        guild,
        operator: { id: operator.id, username: 'velvet_admin' },
        roles: { staff, moderators, verified, member },
        channels: { rules, introductions, general, modLog, staffCategory },
        members,
    };
}
