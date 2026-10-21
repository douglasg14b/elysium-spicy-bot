import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { block as assignRole } from '../../blocks/actionAssignRole';
import { block as removeRole } from '../../blocks/actionRemoveRole';
import type { FlowRunContext } from '../../blocks/types';
import { fakeGuild } from '../../__tests__/support/fakeGuild';
import { changeableRole, PRIVILEGED_ROLE_PERMISSIONS } from '../roleSafety';

/**
 * Which roles a flow may give or take, asked again on every run.
 *
 * A button anyone can press runs Assign Role with the bot's permissions, so without this a
 * flow could hand out Administrator to the whole server. Save time refuses such a role too
 * (`guildReferences.test.ts`); this is the half that holds when a role gains the power
 * after the flow went live.
 */

const GUILD_ID = 'guild-1';

describe('changeableRole', () => {
    it.each(PRIVILEGED_ROLE_PERMISSIONS.map((permission) => [permission.label, permission.flag] as const))(
        'refuses a role carrying %s',
        (label, flag) => {
            const guild = fakeGuild({ id: GUILD_ID, roles: [{ id: 'role-x', name: 'Powerful', permissions: flag }] });

            const result = changeableRole(guild, 'role-x');

            expect(result).toEqual({ ok: false, error: expect.stringContaining(label) });
        }
    );

    it('refuses @everyone, a managed role, and a role not in this server', () => {
        const guild = fakeGuild({ id: GUILD_ID, roles: [{ id: GUILD_ID }, { id: 'role-bot', managed: true }] });

        expect(changeableRole(guild, GUILD_ID).ok).toBe(false);
        expect(changeableRole(guild, 'role-bot').ok).toBe(false);
        expect(changeableRole(guild, 'another-servers-role').ok).toBe(false);
    });

    it('allows an ordinary role, powers and all that are not on the list', () => {
        const guild = fakeGuild({
            id: GUILD_ID,
            roles: [{ id: 'role-chatty', permissions: PermissionFlagsBits.SendMessages | PermissionFlagsBits.ManageMessages }],
        });

        expect(changeableRole(guild, 'role-chatty').ok).toBe(true);
    });
});

describe.each([
    ['Assign Role', assignRole, 'add'],
    ['Remove Role', removeRole, 'remove'],
] as const)('%s at run time', (_label, block, method) => {
    function contextIn(guild: FlowRunContext['guild']): { context: FlowRunContext; change: ReturnType<typeof vi.fn> } {
        const change = vi.fn().mockResolvedValue(undefined);
        return {
            change,
            context: {
                client: {} as FlowRunContext['client'],
                guild,
                subject: { roles: { [method]: change } } as unknown as FlowRunContext['subject'],
                runId: 'run-1',
                nodeId: 'node-1',
                chainDepth: 1,
                variables: {},
                setOutput: () => {},
            },
        };
    }

    it('fails the run without asking Discord when the role carries Administrator', async () => {
        const { context, change } = contextIn(
            fakeGuild({ id: GUILD_ID, roles: [{ id: 'role-admin', name: 'Admin', permissions: PermissionFlagsBits.Administrator }] })
        );

        const outcome = await block.run({ roleId: 'role-admin' }, context);

        expect(outcome).toEqual({ kind: 'fail', error: expect.stringContaining('Administrator') });
        expect(change).not.toHaveBeenCalled();
    });

    it('changes an ordinary role', async () => {
        const { context, change } = contextIn(fakeGuild({ id: GUILD_ID, roles: [{ id: 'role-member' }] }));

        const outcome = await block.run({ roleId: 'role-member' }, context);

        expect(outcome).toEqual({ kind: 'continue' });
        expect(change).toHaveBeenCalledWith('role-member');
    });
});
