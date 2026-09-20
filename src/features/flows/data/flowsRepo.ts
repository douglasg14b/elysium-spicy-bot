import { randomUUID } from 'crypto';
import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import { FLOW_ENTITY_VERSION } from '../constants';
import { validateFlowGraph, validateGraphForWrite } from '../engine/graphValidation';
import type { FlowGraph } from './flowGraph';
import type { FlowEntity } from './flowsSchema';

export interface CreateFlowInput {
    guildId: string;
    name: string;
    graph: FlowGraph;
    enabled?: boolean;
    /** Optional explicit flowId; a UUID is generated when omitted. */
    flowId?: string;
}

export interface UpdateFlowInput {
    name?: string;
    enabled?: boolean;
    graph?: FlowGraph;
}

/**
 * Persistence for flows. The graph is validated (shape + structure) on every write
 * and read so a malformed graph never reaches the executor.
 */
export class FlowsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    async getByGuildId(guildId: string): Promise<FlowEntity[]> {
        const rows = await this.db
            .selectFrom('flows')
            .selectAll()
            .where('guildId', '=', guildId)
            .orderBy('createdAt', 'asc')
            .execute();

        return rows.map((row) => this.assertValidGraph(row));
    }

    async getByFlowId(flowId: string): Promise<FlowEntity | null> {
        const row = await this.db
            .selectFrom('flows')
            .selectAll()
            .where('flowId', '=', flowId)
            .executeTakeFirst();

        return row ? this.assertValidGraph(row) : null;
    }

    async create(input: CreateFlowInput): Promise<FlowEntity> {
        const result = validateGraphForWrite(input.graph);
        if (!result.valid) {
            throw new Error(`Cannot create flow with invalid graph: ${result.errors.join('; ')}`);
        }

        const flowId = input.flowId ?? randomUUID();
        const now = new Date().toISOString();

        await this.db
            .insertInto('flows')
            .values({
                flowId,
                guildId: input.guildId,
                name: input.name,
                enabled: input.enabled ?? false,
                graph: JSON.stringify(result.graph),
                entityVersion: FLOW_ENTITY_VERSION,
                createdAt: now,
                updatedAt: now,
            })
            .execute();

        const saved = await this.getByFlowId(flowId);
        if (!saved) {
            throw new Error(`Flow create succeeded but row was not found for flowId ${flowId}`);
        }

        return saved;
    }

    async update(flowId: string, input: UpdateFlowInput): Promise<FlowEntity> {
        const updateData: Record<string, unknown> = { updatedAt: new Date().toISOString() };

        if (input.name !== undefined) {
            updateData.name = input.name;
        }
        if (input.enabled !== undefined) {
            updateData.enabled = input.enabled;
        }
        if (input.graph !== undefined) {
            const result = validateGraphForWrite(input.graph);
            if (!result.valid) {
                throw new Error(`Cannot update flow with invalid graph: ${result.errors.join('; ')}`);
            }
            updateData.graph = JSON.stringify(result.graph);
        }

        await this.db.updateTable('flows').set(updateData).where('flowId', '=', flowId).execute();

        const saved = await this.getByFlowId(flowId);
        if (!saved) {
            throw new Error(`Flow update succeeded but row was not found for flowId ${flowId}`);
        }

        return saved;
    }

    async setEnabled(flowId: string, enabled: boolean): Promise<FlowEntity> {
        return this.update(flowId, { enabled });
    }

    /**
     * Hard-delete a flow, and nothing else.
     *
     * Deployed buttons **do** outlive their flow — the message stays in the channel —
     * and the dispatcher answers a click on one with "This flow no longer exists."
     * rather than no-opping. That is a decent dead end but it is not cleanup, so
     * `flow_button_messages` rows are deliberately left behind: they are the only
     * record of where those live buttons are, and dropping them here would make the
     * buttons unretirable forever.
     *
     * Retiring them is `undeployFlowButtons`, offered beside this rather than folded
     * into it — deleting a record must not silently destroy part of a live server.
     */
    async deleteByFlowId(flowId: string): Promise<void> {
        await this.db.deleteFrom('flows').where('flowId', '=', flowId).execute();
    }

    /**
     * The SqliteJsonPlugin parses the `graph` column back into an object, but a
     * corrupt row could still slip through. Re-validate defensively.
     */
    private assertValidGraph(row: FlowEntity): FlowEntity {
        const result = validateFlowGraph(row.graph);
        if (!result.valid) {
            throw new Error(
                `Flow ${row.flowId} has an invalid stored graph: ${result.errors.join('; ')}`
            );
        }
        return { ...row, graph: result.graph };
    }
}

export const flowsRepo = new FlowsRepo();
