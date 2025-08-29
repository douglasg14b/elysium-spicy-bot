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

    // Absolutely disgusting AST transformations just to satiate the SQLIte gods
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
        return args.node;

        const node: any = args.node;

        // Handle INSERT ... VALUES (...)
        if (node?.kind === 'InsertQueryNode' && node?.columns && node?.values?.values) {
            // map column names to their index
            const colNames: string[] = node.columns.map((c: any) => colNameOf(c));
            const targetIdx = new Set<number>();
            colNames.forEach((n, i) => {
                if (n && this.cols.has(n)) targetIdx.add(i);
            });

            if (targetIdx.size > 0) {
                const newValues = node.values.values.map((valueList: any) => {
                    // ValueListNode.values is an array of ValueNode/Refs aligned to columns
                    const vals: any[] =
                        valueList.values?.map((vn: any, i: number) => {
                            if (targetIdx.has(i) && vn?.kind === 'ValueNode') {
                                return withStringifiedValue(vn);
                            }
                            return vn;
                        }) ?? valueList.values;

                    return vals === valueList.values ? valueList : { ...valueList, values: vals };
                });

                const valuesChanged = newValues.some((v: any, i: number) => v !== node.values.values[i]);
                if (valuesChanged) {
                    return {
                        ...node,
                        values: { ...node.values, values: newValues },
                    };
                }
            }
        }

        // Handle UPDATE ... SET col = ?
        if (node?.kind === 'UpdateQueryNode' && node?.set?.sets) {
            const newSets = node.set.sets.map((setOp: any) => {
                const name = colNameOf(setOp?.column);
                if (!name || !this.cols.has(name)) return setOp;

                const v = setOp?.value;
                if (v?.kind === 'ValueNode') {
                    const nv = withStringifiedValue(v);
                    if (nv !== v) return { ...setOp, value: nv };
                }
                return setOp;
            });

            const changed = newSets.some((s: any, i: number) => s !== node.set.sets[i]);
            if (changed) {
                return {
                    ...node,
                    set: { ...node.set, sets: newSets },
                };
            }
        }

        // otherwise, leave untouched
        return node;
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

/** Tries to read a column node's name regardless of Kysely internal shape */
function colNameOf(colNode: any): string | undefined {
    return colNode?.column ?? colNode?.name ?? colNode?.toString?.();
}

/** Clones a ValueNode with a new JS value */
function withStringifiedValue(valueNode: any): any {
    // Kysely ValueNode shape: { kind: 'ValueNode', value: <any> }
    const v = valueNode?.value;
    if (shouldStringify(v)) {
        return { ...valueNode, value: JSON.stringify(v) };
    }
    return valueNode;
}

/** super small guard: stringify only non-null/undefined non-string objects/arrays */
function shouldStringify(v: unknown): v is object {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return false;
    if (typeof v !== 'object') return false;
    // allow arrays and plain objects; skip Dates/Buffers/etc.
    if (Array.isArray(v)) return true;
    if (
        v instanceof Date ||
        v instanceof Uint8Array ||
        v instanceof ArrayBuffer ||
        v instanceof Map ||
        v instanceof Set
    )
        return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}
