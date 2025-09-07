import type {
    Kysely,
    KyselyPlugin,
    PluginTransformResultArgs,
    PluginTransformQueryArgs,
    RootOperationNode,
    QueryResult,
    UnknownRow,
    ColumnType,
    OperationNode,
    ValueNode,
} from 'kysely';

type DateOnlyKeys<TSchema> = {
    [K in keyof TSchema]: TSchema[K] extends ColumnType<Date, any, any> | Date ? K : never;
}[keyof TSchema];

type DateColumns<DB> = {
    [TTable in keyof DB]?: readonly DateOnlyKeys<DB[TTable]>[];
};

export class SqliteDatePlugin<DB> implements KyselyPlugin {
    private readonly allDateColumns: Set<string>;

    constructor(private readonly dateCols: DateColumns<DB>) {
        // Flatten all date columns into a single set for efficient lookup
        this.allDateColumns = new Set<string>(Object.values(this.dateCols ?? {}).flat() as string[]);
    }

    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
        return args.node;
    }

    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
        const rows = args.result.rows as Record<string, unknown>[];
        if (!rows.length) return args.result;

        const coerced = rows.map((r) => {
            const copy: Record<string, unknown> = { ...r };
            for (const k of this.allDateColumns) {
                if (k in copy && copy[k]) {
                    const v = copy[k] as string;
                    copy[k] = new Date(v);
                }
            }
            return copy;
        });

        return { ...args.result, rows: coerced };
    }
}
