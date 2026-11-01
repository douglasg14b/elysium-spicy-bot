import { OperationNodeTransformer } from 'kysely';
import type { OperationNode, PrimitiveValueListNode, ValueNode } from 'kysely';

/** Coerce values SQLite's driver can bind (booleans and Dates are not supported raw). */
export function coerceSqliteBindingValue(value: unknown): unknown {
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    return value;
}

/** Kysely's own walk, so every node kind is visited; only the two that carry parameters change. */
class SqliteBindingTransformer extends OperationNodeTransformer {
    protected override transformValue(node: ValueNode): ValueNode {
        return { ...super.transformValue(node), value: coerceSqliteBindingValue(node.value) };
    }

    protected override transformPrimitiveValueList(node: PrimitiveValueListNode): PrimitiveValueListNode {
        return { ...super.transformPrimitiveValueList(node), values: node.values.map(coerceSqliteBindingValue) };
    }
}

const sqliteBindingTransformer = new SqliteBindingTransformer();

export function transformSqliteQueryBindings<TNode extends OperationNode>(node: TNode): TNode {
    return sqliteBindingTransformer.transformNode(node);
}
