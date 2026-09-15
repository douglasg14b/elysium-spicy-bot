import SqliteDatabase from 'better-sqlite3';
import pg from 'pg';
import fs from 'fs';
const { Pool } = pg;

import { Kysely, SqliteDialect, CamelCasePlugin, PostgresDialect } from 'kysely';
import { CommandAuditLogTable } from '../commands';
import { SqliteBindingPlugin } from './plugins/sqliteBindingPlugin';
import { SqliteJsonPlugin } from './plugins/sqliteJsonPlugin';
import { SqlDatePlugin } from './plugins/sqlDatePlugin';
import { DB_TYPE, PG_CONNECTION_STRING, SQLITE_DB_PATH } from '../../environment';
import { FlashChatConfigTable } from '../../features/flash-chat/data/flashChatSchema';
import { TicketingConfigTable } from '../../features/tickets/data/ticketingSchema';
import { TicketTable } from '../../features/tickets/data/ticketsSchema';
import { BirthdayTable } from '../../features/birthday-tracker/data/birthdaySchema';
import { BirthdayConfigTable } from '../../features/birthday-tracker/data/birthdayConfigSchema';
import { LevelingConfigTable } from '../../features/leveling/data/levelingConfigSchema';
import { LevelingProgressTable } from '../../features/leveling/data/levelingProgressSchema';
import { LevelingActivityEventTable } from '../../features/leveling/data/levelingActivityEventSchema';
import { LevelingVoiceSessionTable } from '../../features/leveling/data/levelingVoiceSessionSchema';
import { WarningTable } from '../../features/warnings/data/warningsSchema';
import { WarningsConfigTable } from '../../features/warnings/data/warningsConfigSchema';
import { FlowTable } from '../../features/flows/data/flowsSchema';
import { FlowRunTable } from '../../features/flows/data/flowRunsSchema';

export interface Database {
    flash_chat_config: FlashChatConfigTable;
    command_audit_logs: CommandAuditLogTable;
    ticketing_config: TicketingConfigTable;
    tickets: TicketTable;
    birthdays: BirthdayTable;
    birthday_config: BirthdayConfigTable;
    leveling_config: LevelingConfigTable;
    leveling_progress: LevelingProgressTable;
    leveling_activity_events: LevelingActivityEventTable;
    leveling_voice_sessions: LevelingVoiceSessionTable;
    warnings: WarningTable;
    warnings_config: WarningsConfigTable;
    flows: FlowTable;
    flow_runs: FlowRunTable;
}

function getDbDialect() {
    if (DB_TYPE === 'sqlite') {
        return new SqliteDialect({
            database: async () =>
                new SqliteDatabase(SQLITE_DB_PATH, {
                    fileMustExist: false,
                }),
        });
    } else if (DB_TYPE === 'postgres') {
        return new PostgresDialect({
            pool: new Pool({
                connectionString: PG_CONNECTION_STRING,
                max: 10,
            }),
        });
    }

    throw new Error(`Unsupported DB_TYPE: ${DB_TYPE}`);
}

function getDatabaseClient() {
    const dbDialect = getDbDialect();

    const plugins = [
        new CamelCasePlugin(),
        new SqlDatePlugin<Database>({
            flash_chat_config: ['createdAt', 'updatedAt'],
            command_audit_logs: ['timestamp'],
                tickets: ['openedAt', 'claimedAt', 'closedAt', 'deletedAt', 'updatedAt'],
                birthdays: ['createdAt', 'updatedAt', 'lastAnnouncedAt'],
                birthday_config: ['createdAt', 'updatedAt'],
                leveling_config: ['createdAt', 'updatedAt'],
                leveling_progress: [
                    'createdAt',
                    'updatedAt',
                    'lastMessageXpAt',
                    'lastReactionXpAt',
                    'lastVoiceXpAt',
                ],
                leveling_activity_events: ['occurredAt', 'voiceSessionStartedAt', 'voiceSessionEndedAt'],
                leveling_voice_sessions: ['sessionStartedAt', 'eligibleSince', 'updatedAt'],
                warnings: ['issuedAt', 'expiresAt', 'clearedAt', 'createdAt'],
                warnings_config: ['createdAt', 'updatedAt'],
                flows: ['createdAt', 'updatedAt'],
                flow_runs: ['wakeAt', 'claimedAt', 'createdAt', 'updatedAt'],
        }),
    ];

    if (DB_TYPE === 'sqlite') {
        return new Kysely<Database>({
            dialect: dbDialect,
            plugins: [
                new SqliteBindingPlugin<Database>({
                    flash_chat_config: ['enabled', 'removed', 'preserveHistory', 'preservePinned'],
                    leveling_config: ['enabled', 'reactionXpEnabled', 'photoBonusEnabled'],
                    leveling_activity_events: ['photoBonus'],
                    flows: ['enabled'],
                }),
                new SqliteJsonPlugin<Database>({
                    ticketing_config: ['config'],
                    flows: ['graph'],
                    // `flow_runs` has no boolean columns, so it is absent from
                    // SqliteBindingPlugin above — only its JSON blobs need parsing.
                    flow_runs: ['waitConfig', 'contextSnapshot', 'log', 'variables'],
                }),
                ...plugins,
            ],
        });
    } else if (DB_TYPE === 'postgres') {
        return new Kysely<Database>({
            dialect: dbDialect,
            plugins,
        });
    }

    throw new Error(`Unsupported DB_TYPE: ${DB_TYPE}`);
}

export type DatabaseClient = Kysely<Database>;
export const database = getDatabaseClient();
