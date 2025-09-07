import { Kysely } from 'kysely';
import { database, Database } from '../../data-persistence/database';
import { CommandAuditLog, CommandAuditLogTable, NewCommandAuditLog } from './commandAuditLogSchema';

export class CommandAuditRepository {
    constructor(private db: Kysely<Database>) {}

    async insert(entry: NewCommandAuditLog): Promise<void> {
        await this.db.insertInto('command_audit_logs').values(entry).execute();
    }

    async getById(id: number): Promise<CommandAuditLog | undefined> {
        return await this.db.selectFrom('command_audit_logs').selectAll().where('id', '=', id).executeTakeFirst();
    }

    async getByGuild(guildId: string, limit = 100): Promise<CommandAuditLog[]> {
        return await this.db
            .selectFrom('command_audit_logs')
            .selectAll()
            .where('guildId', '=', guildId)
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .execute();
    }

    async getByUser(userId: string, guildId: string, limit = 50): Promise<CommandAuditLog[]> {
        return await this.db
            .selectFrom('command_audit_logs')
            .selectAll()
            .where('userId', '=', userId)
            .where('guildId', '=', guildId)
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .execute();
    }

    async getByCommand(command: string, guildId: string, limit = 50): Promise<CommandAuditLog[]> {
        return await this.db
            .selectFrom('command_audit_logs')
            .selectAll()
            .where('command', '=', command)
            .where('guildId', '=', guildId)
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .execute();
    }

    async getErrorLogs(guildId: string, limit = 50): Promise<CommandAuditLog[]> {
        return await this.db
            .selectFrom('command_audit_logs')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('result', '=', 'error')
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .execute();
    }
}

export const commandAuditLogRepo = new CommandAuditRepository(database);
