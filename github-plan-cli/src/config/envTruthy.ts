/** Trims and lowercases an env value for token comparison. */
export function normalizeEnvTrimLower(value: string | undefined): string {
    if (!value) {
        return "";
    }
    return value.trim().toLowerCase();
}

/** True for `1`, `true`, `yes` (case-insensitive). */
export function envValueIsTruthy(value: string | undefined): boolean {
    const normalized = normalizeEnvTrimLower(value);
    return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** True for `0`, `false`, `no`, `off` (case-insensitive). */
export function envValueIsExplicitlyOff(value: string | undefined): boolean {
    const normalized = normalizeEnvTrimLower(value);
    return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}
