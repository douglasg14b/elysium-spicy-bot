import type { FeatureGuide } from '../../shared/featureGuide';

export const FLOWS_GUIDE: FeatureGuide = {
    name: 'Flows',
    summary: "The server's automations: a trigger starts a run, conditions branch it, actions do things.",
    about: `Flows are automations built on a canvas on the dashboard. A trigger starts a run (someone joins, sends a message, reacts, presses a button, a schedule comes round, a ticket changes, someone levels up); conditions branch it; actions do things — give or take roles, send messages or DMs, open or close tickets, award XP, ask a question and wait for the answer. A new flow starts switched off and runs only once switched on. Flows that share channels, roles, ticket types or posted messages are grouped in a journey, which installs those resources on the server from the flow builder. Schedules run in the server's time zone (Server Settings). Pictures for messages are uploaded on the Uploads page. Flows have no slash commands.`,
    dashboardPages: [
        { path: '/flows', label: 'Flows' },
        { path: '/uploads', label: 'Uploads' },
    ],
    commands: [],
};
