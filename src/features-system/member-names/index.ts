/**
 * Member names: who an id is in each server — username, display name, nickname, every
 * nickname seen, and whether they left — kept after they go (`docs/plans/member-names.md`).
 *
 * Under `features-system/` because it serves every feature that shows a person, and it
 * imports no feature (`src/shared/__tests__/dependencyDirection.test.ts`). The bot keeps it
 * current (`initMemberNames`); the dashboard reads it through `resolveMemberNames`, which
 * works whether or not the listeners run.
 */
export { initMemberNames } from './initMemberNames';
export { MEMBER_NAME_LOOKUP_CAP, resolveMemberNames } from './logic/resolveMemberNames';
export type { MemberNameRow } from './data/memberNamesSchema';
