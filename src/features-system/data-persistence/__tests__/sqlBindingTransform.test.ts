import { describe, expect, it } from 'vitest';
import { Kysely, SqliteDialect } from 'kysely';
import { SqliteBindingPlugin } from '../plugins/sqliteBindingPlugin';

describe('sqlite binding transform', () => {
    const db = new Kysely<{ t: { enabled: boolean; occurredAt: Date } }>({
        dialect: new SqliteDialect({
            database: async () => {
                throw new Error('not used');
            },
        }),
        plugins: [new SqliteBindingPlugin({ t: ['enabled'] })],
    });

    it('coerces booleans in insert PrimitiveValueListNode parameters', () => {
        const compiled = db
            .insertInto('t')
            .values({
                enabled: true,
                occurredAt: new Date('2026-05-26T12:00:00.000Z'),
            })
            .compile();

        expect(compiled.parameters).toEqual([1, '2026-05-26T12:00:00.000Z']);
    });

    it('coerces booleans in update ValueNode parameters', () => {
        const compiled = db.updateTable('t').set({ enabled: false }).compile();

        expect(compiled.parameters).toEqual([0]);
    });

    it('coerces booleans in where ValueNode parameters', () => {
        const compiled = db
            .selectFrom('t')
            .selectAll()
            .where('enabled', '=', true)
            .compile();

        expect(compiled.parameters).toEqual([1]);
    });

    it('coerces booleans in case/when ValueNode parameters', () => {
        const compiled = db
            .selectFrom('t')
            .select((eb) =>
                eb.fn
                    .sum(eb.case().when('enabled', '=', true).then(1).else(0).end())
                    .as('enabledCount')
            )
            .compile();

        expect(compiled.parameters).toEqual([1]);
    });
});
