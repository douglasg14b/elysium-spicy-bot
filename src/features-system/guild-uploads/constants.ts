import { MIB } from '../../shared/byteSizes';

/**
 * The largest picture one upload may be: 8 MiB. Also the upload route's whole body cap
 * (`apiBodyLimit` in `src/web/api/index.ts`), since the body *is* the picture.
 *
 * People are told "8 MB" ({@link UPLOAD_SIZE_LABEL}), as Discord itself words its own
 * limits, so the drop zone and the 413 say the same thing.
 */
export const UPLOAD_BODY_LIMIT_BYTES = 8 * MIB;

/**
 * How much every upload in one server may add up to: 200 MiB.
 *
 * The upload route sits in the Discord-free rate budget, so without a ceiling one person
 * could fill the database 8 MiB a request. A server at the cap makes room by deleting
 * pictures nothing uses, on the dashboard's Uploads page.
 */
export const GUILD_UPLOAD_TOTAL_LIMIT_BYTES = 200 * MIB;

/** {@link UPLOAD_BODY_LIMIT_BYTES} as people read it: "8 MB". */
export const UPLOAD_SIZE_LABEL = `${UPLOAD_BODY_LIMIT_BYTES / MIB} MB`;

/** {@link GUILD_UPLOAD_TOTAL_LIMIT_BYTES} as people read it: "200 MB". */
export const GUILD_UPLOAD_TOTAL_LABEL = `${GUILD_UPLOAD_TOTAL_LIMIT_BYTES / MIB} MB`;

/** The longest display name an upload keeps, in characters. */
export const UPLOAD_FILE_NAME_MAX_LENGTH = 100;
