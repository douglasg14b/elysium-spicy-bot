import { createPerGuildQueue } from '../../../shared/perGuildQueue';

/**
 * Each guild's upload writes — stores and deletes — run one at a time, so an upload and a
 * delete of the same picture cannot interleave. Its own queue: nothing else's work in a
 * guild holds an upload up.
 */
export const oneAtATimePerGuild = createPerGuildQueue();
