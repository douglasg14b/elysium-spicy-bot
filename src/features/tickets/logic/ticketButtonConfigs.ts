import { ButtonStyle } from 'discord.js';

export interface TicketButtonConfig {
    customId: string;
    label: string;
    style: ButtonStyle;
    emoji: string;
}

export const TICKET_BUTTON_CONFIGS = {
    CLAIM: {
        customId: 'ticket_claim_button',
        label: 'Claim',
        style: ButtonStyle.Success,
        emoji: '✋',
    },
    UNCLAIM: {
        customId: 'ticket_unclaim_button',
        label: 'Unclaim',
        style: ButtonStyle.Secondary,
        emoji: '↩️',
    },
    CLOSE: {
        customId: 'ticket_close_button',
        label: 'Close',
        style: ButtonStyle.Secondary,
        emoji: '🔒',
    },
    REOPEN: {
        customId: 'ticket_reopen_button',
        label: 'Reopen',
        style: ButtonStyle.Success,
        emoji: '🔓',
    },
    DELETE: {
        customId: 'ticket_delete_button',
        label: 'Delete',
        style: ButtonStyle.Danger,
        emoji: '🗑️',
    },
    CONFIRM_DELETE: {
        customId: 'ticket_confirm_delete_button',
        label: 'Confirm Delete',
        style: ButtonStyle.Danger,
        emoji: '⚠️',
    },
} as const;

// Export the individual IDs for backward compatibility
export const TICKET_CLAIM_BUTTON_ID = TICKET_BUTTON_CONFIGS.CLAIM.customId;
export const TICKET_UNCLAIM_BUTTON_ID = TICKET_BUTTON_CONFIGS.UNCLAIM.customId;
export const TICKET_CLOSE_BUTTON_ID = TICKET_BUTTON_CONFIGS.CLOSE.customId;
export const TICKET_REOPEN_BUTTON_ID = TICKET_BUTTON_CONFIGS.REOPEN.customId;
export const TICKET_DELETE_BUTTON_ID = TICKET_BUTTON_CONFIGS.DELETE.customId;
export const TICKET_CONFIRM_DELETE_BUTTON_ID = TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.customId;
