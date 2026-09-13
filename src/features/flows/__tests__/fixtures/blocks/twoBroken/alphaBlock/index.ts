/**
 * A broken block that is slow to fail, and sorts first.
 *
 * Paired with `zuluBlock`, which fails immediately and sorts last. Together they
 * pin the reported failure to directory order rather than to whichever import
 * lost the race: discovery imports concurrently, so without an ordered fold the
 * faster failure would be the one an author sees.
 */
export {};

await new Promise((resolve) => setTimeout(resolve, 50));

throw new Error('alphaBlock failed slowly');
