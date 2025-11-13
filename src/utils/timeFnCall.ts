export async function timeFnCall<T>(fn: () => Promise<T>, label: string): Promise<T> {
    const start = performance.now();
    const result = await fn();
    const end = performance.now();
    console.debug(`[TIMING] ${label} took ${(end - start).toFixed(2)} ms`);
    return result;
}
