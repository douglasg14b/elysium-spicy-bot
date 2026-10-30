/**
 * `contextSnapshot` -> `context_snapshot`, matching Kysely's CamelCasePlugin.
 *
 * The sqlite result plugins run before CamelCasePlugin, so a multi-word column still
 * arrives snake_case in them; each registers both spellings through this.
 */
export function toSnakeCase(value: string): string {
    return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
