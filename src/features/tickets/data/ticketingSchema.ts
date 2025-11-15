import type { Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';

export interface TicketingConfigTable {
    id: Generated<number>;

    // Index
    guildId: string;
    config: JSONColumnType<TicketingConfig>;

    /** The current ticket number increment */
    ticketNumberInc: number;

    entityVersion: number; // For schema migrations
}

export type TicketingConfigEntity = Selectable<TicketingConfigTable>;
export type NewTicketingConfigEntity = Insertable<TicketingConfigTable>;
export type TicketingConfigUpdateEntity = Updateable<TicketingConfigTable>;

export interface TicketingConfig {
    modTicketsDeployed: boolean;
    modTicketsDeployedChannelId: string | null;
    modTicketsDeployedMessageId: string | null;

    userTicketsDeployed: boolean;
    userTicketsDeployedChannelId: string | null;
    userTicketsDeployedMessageId: string | null;

    supportTicketCategoryName: string;
    claimedTicketCategoryName: string;
    closedTicketCategoryName: string;
    ticketChannelNameTemplate: string;

    moderationRoles: string[];
}

export interface ConfiguredTicketingConfig extends TicketingConfig {
    modTicketsDeployed: true;
    modTicketsDeployedChannelId: string;
    modTicketsDeployedMessageId: string;
}

export type ConfiguredTicketingConfigEntity = TicketingConfigEntity & {
    config: ConfiguredTicketingConfig;
};

export function isTicketingConfigConfigured(
    entity: TicketingConfigEntity | null | undefined
): entity is NonNullable<ConfiguredTicketingConfigEntity> {
    if (!entity || !entity.config) {
        return false;
    }

    const {
        modTicketsDeployed,
        supportTicketCategoryName,
        closedTicketCategoryName,
        claimedTicketCategoryName,
        moderationRoles,
        modTicketsDeployedChannelId,
        modTicketsDeployedMessageId,
    } = entity.config;

    return (
        modTicketsDeployed &&
        !!claimedTicketCategoryName &&
        !!supportTicketCategoryName &&
        !!closedTicketCategoryName &&
        !!modTicketsDeployedChannelId &&
        !!modTicketsDeployedMessageId &&
        moderationRoles.length > 0
    );
}
