/**
 * Load the dashboard afresh at its root: a new page, not a route change, so nothing of
 * this one — its query cache, its unsaved edits, a request still held — carries over.
 *
 * For somebody else having signed in on another tab (see `AuthProvider`). A module of its
 * own so a test can stand in for it: jsdom cannot navigate, and will not let
 * `location.replace` be spied on.
 */
export function startOver(): void {
    window.location.replace('/');
}
