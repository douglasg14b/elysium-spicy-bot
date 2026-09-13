/**
 * The blocks tree's public surface: the contract, and the registry that
 * discovers blocks implementing it.
 *
 * Individual blocks are deliberately **not** re-exported. Each directory's entry
 * module exports `block`, so twelve re-exports would collide on one name — and
 * the collision is telling the truth: nothing outside a block's own directory
 * should reach for it by name. Consumers go through the registry; the handful of
 * modules that genuinely need a single block's constants (the button deployer,
 * the journey template, tests) import that directory directly.
 */
export * from './manifest';
export * from './conformance';
export * from './types';
export * from './registry';
