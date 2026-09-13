/**
 * A block whose module throws while loading — a bad constant, a schema built from
 * something undefined. Discovery must say *that*, not "no loadable index.ts":
 * they are different problems with different fixes.
 */
throw new Error('this block exploded on import');
