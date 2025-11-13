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
    private readonly allJsonColumns: Set<string>;

    constructor(private readonly columns: ObjectArrayColumns<TSchema>) {
        // Flatten all JSON columns into a single set for efficient lookup
        this.allJsonColumns = new Set<string>(Object.values(this.columns ?? {}).flat() as string[]);
    }

    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
        return args.node;
    }

    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
        const rows = args.result.rows as Record<string, unknown>[];
        if (!rows?.length) return args.result;

        const parsed = rows.map((r) => {
            const out: Record<string, unknown> = { ...r };
            for (const c of this.allJsonColumns) {
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
