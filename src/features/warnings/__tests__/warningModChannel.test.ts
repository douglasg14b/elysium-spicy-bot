import { PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { botCanPostWarningNotice } from '../logic/warningModChannel';

describe('botCanPostWarningNotice', () => {
    it('requires view, send, and embed links', () => {
        expect(
            botCanPostWarningNotice(
                new PermissionsBitField([
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.EmbedLinks,
                ])
            )
        ).toBe(true);
        expect(
            botCanPostWarningNotice(
                new PermissionsBitField([
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                ])
            )
        ).toBe(false);
        expect(botCanPostWarningNotice(null)).toBe(false);
    });
});
