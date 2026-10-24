import type { GuildUploads } from '../../flows/controls/types';

/**
 * A server with no uploaded pictures, for a control test that never touches one. Uploading
 * through it fails the test: a test that means to upload passes the page's real hook.
 */
export const NO_UPLOADS: GuildUploads = {
    items: [],
    upload: () => Promise.reject(new Error('This test hands its controls no way to upload.')),
    imageUrl: (uploadId) => `/test-uploads/${uploadId}`,
};
