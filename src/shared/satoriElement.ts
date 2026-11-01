/**
 * The element tree the PNG cards hand to `satori`: React's element shape without React.
 * `key` is there because satori is typed to take a `ReactNode`, and a React element has one.
 */
export type SatoriStyle = Record<string, string | number>;
export type SatoriChild = string | SatoriElement | Array<SatoriChild>;
export type SatoriElement = {
    type: string;
    key: null;
    props: {
        style?: SatoriStyle;
        src?: string;
        children?: SatoriChild;
    };
};

export function el(
    type: string,
    props: { style?: SatoriStyle; src?: string; children?: SatoriChild } = {}
): SatoriElement {
    return { type, key: null, props };
}
