/**
 * Pictures a server keeps for its messages: uploaded through the dashboard, stored in the
 * database with their bytes, and attached to the messages flows post.
 *
 * Under `features-system/`, beside `guild-settings`, for the same reason: it is a table, a
 * repo and the rules for what may be stored, with no commands or listeners of its own, and
 * it imports no feature — so flows and provisioning can both read it without a cycle.
 */
export {
    guildUploadsRepo,
    type GuildUpload,
    type GuildUploadFile,
    type GuildUploadSize,
} from './data/guildUploadsRepo';
export { IMAGE_CONTENT_TYPES, IMAGE_EXTENSIONS } from './logic/detectImageType';
export { storeGuildUpload } from './logic/storeGuildUpload';
export { deleteGuildUpload, type DeleteGuildUploadOutcome } from './logic/deleteGuildUpload';
export {
    clearUploadUsageReadersForTests,
    registerUploadUsageReader,
    uploadUsesForGuild,
    type UploadUsageReader,
    type UploadUse,
} from './logic/uploadUsage';
export {
    GUILD_UPLOAD_TOTAL_LABEL,
    GUILD_UPLOAD_TOTAL_LIMIT_BYTES,
    UPLOAD_BODY_LIMIT_BYTES,
    UPLOAD_SIZE_LABEL,
} from './constants';
