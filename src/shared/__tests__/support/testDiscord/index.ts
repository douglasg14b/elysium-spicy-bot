export { TestDiscord, type CreateGuildOptions } from './testDiscord';
// Types only: handles are made by `TestDiscord` and `ServerGuild`, never constructed by a test.
export type {
    IncomingMessageOptions,
    OverwriteGrant,
    OverwriteTarget,
    OverwriteView,
    ServerChannel,
    ServerEmoji,
    ServerGuild,
    ServerInteraction,
    ServerMember,
    ServerRole,
    ServerThread,
} from './handles';
export type { InteractionResponseView } from './interactionState';
export type { MessageFile, ServerAttachmentView, ServerMessageView } from './messageState';
export type {
    ChannelReadRoute,
    ChannelWriteRoute,
    GuildCreateRoute,
    InjectedRateLimit,
    InjectedRejection,
    RecordedRequest,
} from './restRouter';
export { TestDiscordError } from './testDiscordError';
