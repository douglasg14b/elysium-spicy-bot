// SimpleJsonPlugin.ts
import type {
    KyselyPlugin,
    PluginTransformQueryArgs,
    PluginTransformResultArgs,
    QueryResult,
    UnknownRow,
    RootOperationNode,
    ColumnType,
    Generated,
} from 'kysely';

type ExcludedObjectTypes = Generated<number> | Date | ColumnType<Date, string, string>;

type ObjectArrayOnlyKeys<TSchema> = {
    [K in keyof TSchema]: TSchema[K] extends ExcludedObjectTypes
        ? never
        : NonNullable<TSchema[K]> extends Record<any, any> | Array<any>
        ? K
        : never;
}[keyof TSchema];

type ObjectArrayColumns<TSchema> = {
    [TTable in keyof TSchema]?: readonly ObjectArrayOnlyKeys<TSchema[TTable]>[];
};

export class SqliteJsonPlugin<TSchema> implements KyselyPlugin {
    constructor(private readonly columns: ObjectArrayColumns<TSchema>) {}

    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
        return args.node;
    }

    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
        const rows = args.result.rows as Record<string, unknown>[];
        if (!rows?.length) return args.result;

        const cols = new Set(this.columns as unknown as string[]);

        const parsed = rows.map((r) => {
            const out: Record<string, unknown> = { ...r };
            for (const c of cols) {
                const v = out[c];
                if (typeof v === 'string') {
                    try {
                        out[c] = JSON.parse(v);
                    } catch {
                        /* leave as string */
                    }
                }
            }
            return out;
        });

        return { ...args.result, rows: parsed };
    }
}
