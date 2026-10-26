/**
 * The rule every resource key follows — a journey's, its resources', a message's buttons' —
 * shared by the journey wire schemas (`src/web/api/journeyBody.ts`) and the Button Click
 * trigger, whose config names a message and one of its buttons by key.
 *
 * Restrictive on purpose: lowercase, digits and single hyphens. A key appears in
 * `resource_bindings`, in node configs and in button custom_ids, which Discord caps at 100
 * characters.
 */

/** The key pattern's body, without anchors, so a caller can embed it in a wider pattern. */
export const RESOURCE_KEY_PATTERN = '[a-z0-9]+(-[a-z0-9]+)*';

/** The longest a resource key may be. */
export const RESOURCE_KEY_MAX_LENGTH = 64;
