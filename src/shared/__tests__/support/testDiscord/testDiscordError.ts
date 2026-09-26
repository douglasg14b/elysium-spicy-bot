/**
 * Raised when the harness is asked for something it does not model, or catches itself
 * disagreeing with the client it is driving.
 *
 * A distinct class so a test that sees one knows the *harness* has a gap, not the product.
 * The two must never be confused: a harness that answers an unmodelled request with a
 * plausible default turns a new API call in product code into a silent pass.
 */
export class TestDiscordError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TestDiscordError';
    }
}
