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

type BooleanOnlyKeys<TSchema> = {
    [K in keyof TSchema]: TSchema[K] extends ColumnType<boolean, 0 | 1, 0 | 1> | boolean ? K : never;
}[keyof TSchema];

type BoolColumns<DB> = {
    [TTable in keyof DB]?: readonly BooleanOnlyKeys<DB[TTable]>[];
};

export class SqlBooleanPlugin<DB> implements KyselyPlugin {
    private readonly allBoolColumns: Set<string>;

    constructor(private readonly boolCols: BoolColumns<DB>) {
        // Flatten all boolean columns into a single set for efficient lookup
        this.allBoolColumns = new Set<string>(Object.values(this.boolCols ?? {}).flat() as string[]);
    }

    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
        return this.transformNode(args.node) as RootOperationNode;
    }

    private transformNode(node: OperationNode): OperationNode {
        if (node.kind === 'ValueNode') {
            return this.transformValueNode(node as ValueNode);
        }

        // Recursively transform child nodes
        const transformedNode = { ...node } as any;
        for (const [key, value] of Object.entries(node)) {
            if (value && typeof value === 'object') {
                if (Array.isArray(value)) {
                    transformedNode[key] = value.map((item) =>
                        item && typeof item === 'object' ? this.transformNode(item) : item
                    );
                } else if ('kind' in value) {
                    transformedNode[key] = this.transformNode(value as OperationNode);
                }
            }
        }

        return transformedNode;
    }

    private transformValueNode(node: ValueNode): ValueNode {
        const { value } = node;

        // Only transform boolean values to numbers
        if (typeof value === 'boolean') {
            return {
                ...node,
                value: value ? 1 : 0,
            };
        }

        return node;
    }

    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
        const rows = args.result.rows as Record<string, unknown>[];
        if (!rows.length) return args.result;

        const coerced = rows.map((r) => {
            const copy: Record<string, unknown> = { ...r };
            for (const k of this.allBoolColumns) {
                if (k in copy && copy[k] != null) {
                    const v = copy[k] as number | boolean;
                    // SQLite returns 0/1; convert to boolean
                    copy[k] = typeof v === 'number' ? v === 1 : !!v;
                }
            }
            return copy;
        });

        return { ...args.result, rows: coerced };
    }
}
