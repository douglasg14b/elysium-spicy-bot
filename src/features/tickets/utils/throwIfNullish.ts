export function throwIfNullish<T>(input: T, errorMessage: string): asserts input is NonNullable<T> {
    if (input === null || input === undefined) {
        throw new Error(errorMessage);
    }
}
