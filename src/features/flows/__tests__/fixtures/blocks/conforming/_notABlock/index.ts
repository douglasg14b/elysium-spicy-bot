/**
 * An underscore-prefixed directory. Discovery must skip it entirely — if it did
 * not, the scan would fail here for exporting no `block`, which is exactly what
 * makes this a useful fixture.
 */
export const NOT_A_BLOCK = 'scratch space, not a block';
