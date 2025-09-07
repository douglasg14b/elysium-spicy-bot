import { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import { AdditionalData, Null } from '../../../shared';

export interface CommandAuditLogTable {
    id: Generated<number>;
    command: string;
    subcommand: string | null;

    channelId: string;
    channelName: string;
    guildId: string;
    guildName: string;

    userId: string;
    userName: string;
    userDiscriminator: string | null; // null for new Discord usernames

    parameters: ColumnType<Null<Record<string, any>>, Null<string>, Null<string>>; // Command parameters used
    result: 'success' | 'error' | 'skipped';
    resultMessage: string | null; // Optional message for success or partial
    resultData: ColumnType<Null<AdditionalData>, Null<string>, Null<string>>; // Additional data for success or partial
    executionTimeMs: number;
    timestamp: ColumnType<Date, string, string>;
}

export type CommandAuditLog = Selectable<CommandAuditLogTable>;
export type NewCommandAuditLog = Insertable<CommandAuditLogTable>;
