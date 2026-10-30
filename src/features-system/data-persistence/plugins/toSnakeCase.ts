/**
 * `contextSnapshot` → `context_snapshot`, as Kysely's `CamelCasePlugin` maps it.
 *
 * The sqlite-only plugins are listed before `CamelCasePlugin`, and Kysely hands results to
 * plugins in the order they are listed, so a row reaches them with its database names still
 * on. Each matches both spellings of the columns it is given.
 */
export function toSnakeCase(value: string): string {
    return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
