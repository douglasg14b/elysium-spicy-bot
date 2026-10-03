/**
 * How a run variable's name is spelled, shared by every block that names or reads one.
 *
 * A fragment, not a block: it lives at the blocks root beside `manifest.ts` and exports
 * no `block`, so discovery never sees it. One shape for every place a name is typed or
 * picked, so a name one block accepts is always one another can address.
 */

/**
 * What `{{var.<name>}}` can address.
 *
 * `variableNameOf` in `engine/copyRendering.ts` splits a token on `.` and rejects
 * anything with a second segment, so a name containing a dot would save happily and
 * then be unreadable from copy — the author's token would resolve to nothing and they
 * would have no way to tell why. Whitespace and braces fail the same way. Constrained
 * at the schema instead, so the save is what refuses it.
 */
export const VARIABLE_NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Longest a variable name may be, in characters — one limit for every block that names
 * a variable or reads one by name, so a name one block writes always fits where another
 * picks it.
 */
export const VARIABLE_NAME_MAX_LENGTH = 64;

/** What a save says about a name outside {@link VARIABLE_NAME_SHAPE}. */
export const VARIABLE_NAME_MESSAGE =
    'A name must start with a letter and use only letters, numbers and underscores — ' +
    'that is what {{var.name}} can address.';
