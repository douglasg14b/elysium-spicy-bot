import { ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
    WARNINGS_CONFIG_CHANNEL_INPUT_ID,
    WARNINGS_CONFIG_MODAL_ID,
    WarningsConfigModalComponent,
} from '../warningsConfigModal';

describe('WarningsConfigModalComponent', () => {
    it('uses a stable custom id and a guild text channel select', () => {
        const modalJson = WarningsConfigModalComponent().buildComponent().toJSON();
        const serialized = JSON.stringify(modalJson);

        expect(modalJson.custom_id).toBe(WARNINGS_CONFIG_MODAL_ID);
        expect(serialized).toContain(WARNINGS_CONFIG_CHANNEL_INPUT_ID);
        expect(serialized).toContain(String(ChannelType.GuildText));
        expect(serialized).not.toContain('123456789012345678');
    });

    it('prefills the stored mod channel when one is still around', () => {
        const modalJson = WarningsConfigModalComponent().buildComponent('123456789012345678').toJSON();
        const serialized = JSON.stringify(modalJson);

        expect(serialized).toContain('123456789012345678');
    });
});
