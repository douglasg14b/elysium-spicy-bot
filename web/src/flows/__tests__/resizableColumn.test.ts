import { describe, expect, it } from 'vitest';
import {
    INSPECTOR_MAX_WIDTH,
    INSPECTOR_MIN_WIDTH,
    clampWidth,
    readStoredWidth,
    widthFromDrag,
} from '../resizableColumn';

const BOUNDS = { min: INSPECTOR_MIN_WIDTH, max: INSPECTOR_MAX_WIDTH };

describe('widthFromDrag', () => {
    it('widens the column when the pointer moves left', () => {
        // The inspector is anchored to the right edge, so dragging its handle
        // toward the canvas makes it bigger. Getting this sign backwards is the
        // single most likely bug in a resize, and it is invisible in a type check.
        expect(widthFromDrag(400, -60, BOUNDS)).toBe(460);
    });

    it('narrows the column when the pointer moves right', () => {
        expect(widthFromDrag(400, 60, BOUNDS)).toBe(340);
    });

    it('stops at the minimum however far the drag runs', () => {
        expect(widthFromDrag(400, 10_000, BOUNDS)).toBe(INSPECTOR_MIN_WIDTH);
    });

    it('stops at the maximum however far the drag runs', () => {
        expect(widthFromDrag(400, -10_000, BOUNDS)).toBe(INSPECTOR_MAX_WIDTH);
    });
});

describe('readStoredWidth', () => {
    it('falls back when nothing is stored', () => {
        expect(readStoredWidth(null, 320, BOUNDS)).toBe(320);
    });

    it('falls back on a value that is not a number', () => {
        // `localStorage` is shared, versioned by nobody, and writable by an older
        // build. A restored width is untrusted input rather than our own value.
        expect(readStoredWidth('wide please', 320, BOUNDS)).toBe(320);
    });

    it('clamps a stored width that is outside the current bounds', () => {
        // The case that makes this more than parsing: bounds can change between
        // builds, and a width stored under the old ones must not escape the new.
        expect(readStoredWidth('9000', 320, BOUNDS)).toBe(INSPECTOR_MAX_WIDTH);
        expect(readStoredWidth('10', 320, BOUNDS)).toBe(INSPECTOR_MIN_WIDTH);
    });

    it('restores a width that is in range', () => {
        expect(readStoredWidth('455', 320, BOUNDS)).toBe(455);
    });
});

describe('clampWidth', () => {
    it('leaves a width inside the bounds alone', () => {
        expect(clampWidth(400, BOUNDS)).toBe(400);
    });
});
