/**
 * What a feature tells staff about itself through the chat agent ("how do warnings work?"):
 * the same for every server. Each feature keeps its guide beside its code (`featureGuide.ts`),
 * so a change to the feature is a change next to its description. How a server has it set up
 * is read live by the chat agent, not written here.
 */
export type FeatureGuide = {
    /** What it is called on the dashboard and in conversation. */
    readonly name: string;
    /** One line, for the list of features the agent can pick from. */
    readonly summary: string;
    /** What it does and how it is set up, in plain sentences for staff. */
    readonly about: string;
    /** Dashboard pages, by route path (`/tickets/config`); empty when it has none yet. */
    readonly dashboardPages: readonly DashboardPage[];
    /** Its slash commands: the builders themselves, so a renamed command or option cannot drift from the guide. */
    readonly commands: readonly SlashCommandLike[];
};

export type DashboardPage = {
    readonly path: string;
    readonly label: string;
};

/** The part of a discord.js slash command builder a guide reads, kept structural so `src/shared` needs no discord.js. */
export type SlashCommandLike = {
    toJSON(): {
        readonly name: string;
        readonly description: string;
        readonly options?: readonly { readonly type: number; readonly name: string; readonly description: string }[];
    };
};
