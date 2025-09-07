import * as ResultPattern from '@eicode/result-pattern';

console.log(ResultPattern.ResultUtils);

// @ts-ignore Their TS definitions are wrong compared to their actual JS bundle
const { ok, fail } = ResultPattern.default.ResultUtils as ResultPattern.ResultUtils;

export { fail, ok };
