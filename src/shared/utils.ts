import { IntBool } from './types';

export function jsonIfy<T>(data: T | null | undefined): string | null | undefined {
    if (data == null) return null;
    if (data == undefined) return undefined;

    return JSON.stringify(data);
}

export function boolToInt(value: boolean): IntBool {
    return value ? 1 : 0;
}
