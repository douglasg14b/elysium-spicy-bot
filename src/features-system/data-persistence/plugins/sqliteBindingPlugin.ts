import type {
    KyselyPlugin,
    PluginTransformResultArgs,
    PluginTransformQueryArgs,
    QueryResult,
    RootOperationNode,
    UnknownRow,
    ColumnType,
} from 'kysely';
import { transformSqliteQueryBindings } from './sqlBindingTransform';
import { toSnakeCase } from './snakeCase';

type BooleanOnlyKeys<TSchema> = {
    [K in keyof TSchema]: TSchema[K] extends ColumnType<boolean, 0 | 1, 0 | 1> | boolean ? K : never;
}[keyof TSchema];

type BoolColumns<DB> = {
    [TTable in keyof DB]?: readonly BooleanOnlyKeys<DB[TTable]>[];
};

/**
 * SQLite cannot bind JavaScript booleans or Date objects.
 * Kysely emits both ValueNode and PrimitiveValueListNode parameters — both must be coerced.
 */
export class SqliteBindingPlugin<DB> implements KyselyPlugin {
    private readonly allBoolColumns: Set<string>;

    constructor(private readonly boolCols: BoolColumns<DB>) {
        // Both spellings, as `SqliteJsonPlugin` registers them: this plugin runs before
        // CamelCasePlugin in the result pipeline, so a multi-word column (`in_server`)
        // still arrives snake_case here, and registering only `inServer` left it 0/1.
        this.allBoolColumns = new Set<string>();
        for (const column of Object.values(this.boolCols ?? {}).flat() as string[]) {
            this.allBoolColumns.add(column);
            this.allBoolColumns.add(toSnakeCase(column));
        }
    }

    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
        return transformSqliteQueryBindings(args.node);
    }

    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
        const rows = args.result.rows as Record<string, unknown>[];
        if (!rows.length) {
            return args.result;
        }

        const coerced = rows.map((row) => {
            const copy: Record<string, unknown> = { ...row };
            for (const column of this.allBoolColumns) {
                if (column in copy && copy[column] != null) {
                    const value = copy[column] as number | boolean;
                    copy[column] = typeof value === 'number' ? value === 1 : !!value;
                }
            }
            return copy;
        });

        return { ...args.result, rows: coerced };
    }
}
