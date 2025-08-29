export type Scalar = string | number | boolean;
export type AdditionalData = Record<string, Scalar | object | Array<Scalar>>;

export type IntBool = 0 | 1; // SQLite does not have a boolean type

export type Null<T> = T | null;
