export type Result<TValue, TError extends ValidErrorType = Error | string> = OkResult<TValue> | FailResult<TError>;

export class OkResult<TValue> {
    public readonly value: TValue;

    public constructor(value: TValue) {
        this.value = value;
    }

    public get ok(): true {
        return true;
    }
}

export class FailResult<TError extends ValidErrorType> {
    public readonly value: undefined = undefined;
    public readonly error: TError;

    public constructor(error: TError) {
        // Convenience
        if (typeof error === 'string') {
            this.error = new Error(error) as TError;
        } else {
            this.error = error;
        }
    }

    public get ok(): false {
        return false;
    }
}

export function ok<TValue = null>(...args: OkArgs<TValue> | [TValue]): OkResult<TValue> {
    const value = args[0] as TValue;
    return new OkResult(value);
}

export function fail<TError extends ValidErrorType>(error: TError): FailResult<TError> {
    return new FailResult(error);
}

// export type ValueResult<TValue> = TValue extends null ? { value: null } : { value: TValue };
// export type OkResult<TValue> = { ok: true } & ValueResult<TValue>;

// export type ErrResult<TError = Error> = { ok: false; error: TError; value?: undefined };
// export type Result<TValue, TError = Error | string> = OkResult<TValue> | (ErrResult<TError> & { value?: TValue });

type OkArgs<TValue> = TValue extends null ? [] : [TValue];

// export function Ok<TValue = null>(...args: OkArgs<TValue> | [TValue]): OkResult<TValue> {
//     const value = args[0] as TValue;

//     return { ok: true, value: value ?? null } as unknown as OkResult<TValue>;
// }

type ValidErrorType = Record<string, unknown> | Array<unknown> | string | Error;
// // eslint-disable-next-line local-rules/naming-convention-exclusions
// export function ErrorResult<TError extends ValidErrorType>(error: TError): Result<never, TError> {
//     // Convenience access
//     if (typeof error === 'string') {
//         return { ok: false, error: new Error(error) as TError };
//     }

//     return { ok: false, error: error };
// }

// export function isOkResult<TValue, TError>(result: Result<TValue, TError>): result is OkResult<TValue> {
//     return result.ok;
// }

// export function isErrResult<TValue, TError>(result: Result<TValue, TError>): result is ErrResult<TError> {
//     return !result.ok;
// }
