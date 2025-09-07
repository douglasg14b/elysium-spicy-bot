import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';
import { IntBool } from '../../../shared';

export interface FlashChatConfigTable {
    id: Generated<number>;

    // Index
    guildId: string;
    // Index
    channelId: string;

    timeoutSeconds: number;
    preservePinned: ColumnType<boolean, IntBool, IntBool>;
    preserveHistory: ColumnType<boolean, IntBool, IntBool>;

    enabled: ColumnType<boolean, IntBool, IntBool>;

    /** True when the config is removed from a channel */
    removed: ColumnType<boolean, IntBool, IntBool>;

    createdBy: string;
    createdByName: string;
    updatedBy: string;
    updatedByName: string;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;

    configVersion: number; // For schema migrations
}

export type FlashChatConfig = Selectable<FlashChatConfigTable>;
export type NewFlashChatConfig = Insertable<FlashChatConfigTable>;
export type FlashChatConfigUpdate = Updateable<FlashChatConfigTable>;
