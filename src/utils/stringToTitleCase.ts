export function stringToTitleCase(str: string): string {
    return (
        str
            // Only add space before capital letters that are not preceded by a space
            .replace(/([^\s])([A-Z])/g, '$1 $2')
            .replace(/^./, (s) => s.toUpperCase())
            .trim()
    );
}
