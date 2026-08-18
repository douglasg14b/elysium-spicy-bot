import { database } from '../../../features-system/data-persistence/database';
import { toTimestampValue } from '../logic/xpGrant';
import type { LevelingVoiceSession } from './levelingVoiceSessionSchema';

export type VoiceSessionRow = {
    guildId: string;
    userId: string;
    channelId: string;
    sessionStartedAt: Date;
    eligibleAccumulatorMs: number;
    eligibleSince: Date | null;
};

export function toVoiceSessionRow(session: LevelingVoiceSession): VoiceSessionRow {
    return {
        guildId: session.guildId,
        userId: session.userId,
        channelId: session.channelId,
        sessionStartedAt: toDate(session.sessionStartedAt),
        eligibleAccumulatorMs: session.eligibleAccumulatorMs,
        eligibleSince: session.eligibleSince ? toDate(session.eligibleSince) : null,
    };
}

export function serializeVoiceSession(
    session: VoiceSessionRow,
    updatedAt: Date
): {
    guildId: string;
    userId: string;
    channelId: string;
    sessionStartedAt: string;
    eligibleAccumulatorMs: number;
    eligibleSince: string | null;
    updatedAt: string;
} {
    return {
        guildId: session.guildId,
        userId: session.userId,
        channelId: session.channelId,
        sessionStartedAt: session.sessionStartedAt.toISOString(),
        eligibleAccumulatorMs: session.eligibleAccumulatorMs,
        eligibleSince: toTimestampValue(session.eligibleSince),
        updatedAt: updatedAt.toISOString(),
    };
}

export class LevelingVoiceSessionRepo {
    async get(guildId: string, userId: string): Promise<VoiceSessionRow | null> {
        const session = await database
            .selectFrom('leveling_voice_sessions')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .executeTakeFirst();

        return session ? toVoiceSessionRow(session) : null;
    }

    async listByGuild(guildId: string): Promise<VoiceSessionRow[]> {
        const sessions = await database
            .selectFrom('leveling_voice_sessions')
            .selectAll()
            .where('guildId', '=', guildId)
            .execute();

        return sessions.map(toVoiceSessionRow);
    }

    async listByChannel(guildId: string, channelId: string): Promise<VoiceSessionRow[]> {
        const sessions = await database
            .selectFrom('leveling_voice_sessions')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('channelId', '=', channelId)
            .execute();

        return sessions.map(toVoiceSessionRow);
    }

    async listGuildIdsWithOpenSessions(): Promise<string[]> {
        const rows = await database
            .selectFrom('leveling_voice_sessions')
            .select('guildId')
            .distinct()
            .execute();

        return rows.map((row) => row.guildId);
    }

    async upsert(session: VoiceSessionRow, now: Date = new Date()): Promise<void> {
        const existing = await this.get(session.guildId, session.userId);
        const values = serializeVoiceSession(session, now);

        if (existing) {
            await database
                .updateTable('leveling_voice_sessions')
                .set({
                    channelId: values.channelId,
                    sessionStartedAt: values.sessionStartedAt,
                    eligibleAccumulatorMs: values.eligibleAccumulatorMs,
                    eligibleSince: values.eligibleSince,
                    updatedAt: values.updatedAt,
                })
                .where('guildId', '=', session.guildId)
                .where('userId', '=', session.userId)
                .execute();
            return;
        }

        await database.insertInto('leveling_voice_sessions').values(values).execute();
    }

    async delete(guildId: string, userId: string): Promise<void> {
        await database
            .deleteFrom('leveling_voice_sessions')
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .execute();
    }
}

export const levelingVoiceSessionRepo = new LevelingVoiceSessionRepo();

function toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}
