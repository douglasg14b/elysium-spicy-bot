import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMissingTableError, reportMissingTableOnce, resetMissingTableReportsForTests } from '../missingTable';

describe('isMissingTableError', () => {
    it("knows each dialect's missing table, and not a missing column naming the table", () => {
        expect(isMissingTableError(new Error('SqliteError: no such table: flow_schedules'), 'flow_schedules')).toBe(true);
        expect(isMissingTableError(new Error('relation "flow_schedules" does not exist'), 'flow_schedules')).toBe(true);
        expect(
            isMissingTableError(new Error('column "next_run_at" of relation "flow_schedules" does not exist'), 'flow_schedules')
        ).toBe(false);
        expect(isMissingTableError(new Error('column flow_schedules.next_run_at does not exist'), 'flow_schedules')).toBe(false);
        expect(isMissingTableError(new Error('no such table: flow_runs'), 'flow_schedules')).toBe(false);
        expect(isMissingTableError('no such table: flow_schedules', 'flow_schedules')).toBe(false);
    });
});

describe('reportMissingTableOnce', () => {
    afterEach(() => {
        resetMissingTableReportsForTests();
        vi.restoreAllMocks();
    });

    it('says a table is missing once per process, with the fix, however often it is hit', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        reportMissingTableOnce('flow_schedules', 'no Schedule trigger fires');
        reportMissingTableOnce('flow_schedules', 'no Schedule trigger fires');
        reportMissingTableOnce('flow_runs', 'nothing resumes');

        expect(error).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledWith(
            expect.stringMatching(/flow_schedules table does not exist, so no Schedule trigger fires\. Run `pnpm migrate:latest:dev`/)
        );
    });
});
