/**
 * Birthday validation utilities
 */

export interface BirthdayValidationResult {
    isValid: boolean;
    errorMessage?: string;
}

export interface ParsedBirthdayInput {
    month: number;
    day: number;
    year: number | null;
}

/**
 * Parse and validate birthday input strings
 */
export function parseBirthdayInput(
    monthStr: string,
    dayStr: string,
    yearStr: string
): { isValid: boolean; data?: ParsedBirthdayInput; errorMessage?: string } {
    const month = parseInt(monthStr.trim(), 10);
    const day = parseInt(dayStr.trim(), 10);
    const year = yearStr.trim() ? parseInt(yearStr.trim(), 10) : null;

    // Validate month
    const monthValidation = validateMonth(month);
    if (!monthValidation.isValid) {
        return { isValid: false, errorMessage: monthValidation.errorMessage };
    }

    // Validate day
    const dayValidation = validateDay(day);
    if (!dayValidation.isValid) {
        return { isValid: false, errorMessage: dayValidation.errorMessage };
    }

    // Validate date combination
    const dateValidation = validateDate(month, day);
    if (!dateValidation.isValid) {
        return { isValid: false, errorMessage: dateValidation.errorMessage };
    }

    // Validate year if provided
    if (year !== null) {
        const yearValidation = validateYear(year);
        if (!yearValidation.isValid) {
            return { isValid: false, errorMessage: yearValidation.errorMessage };
        }
    }

    return {
        isValid: true,
        data: { month, day, year },
    };
}

/**
 * Validate month (1-12)
 */
export function validateMonth(month: number): BirthdayValidationResult {
    if (isNaN(month) || month < 1 || month > 12) {
        return {
            isValid: false,
            errorMessage: '❌ Please enter a valid month (1-12).',
        };
    }
    return { isValid: true };
}

/**
 * Validate day (1-31)
 */
export function validateDay(day: number): BirthdayValidationResult {
    if (isNaN(day) || day < 1 || day > 31) {
        return {
            isValid: false,
            errorMessage: '❌ Please enter a valid day (1-31).',
        };
    }
    return { isValid: true };
}

/**
 * Validate year (1900-current year)
 */
export function validateYear(year: number): BirthdayValidationResult {
    const currentYear = new Date().getFullYear();

    if (isNaN(year) || year < 1900 || year > currentYear) {
        return {
            isValid: false,
            errorMessage: `❌ Please enter a valid year between 1900 and ${currentYear}.`,
        };
    }
    return { isValid: true };
}

/**
 * Validate date combination (month/day)
 */
export function validateDate(month: number, day: number): BirthdayValidationResult {
    const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    if (day > daysInMonth[month - 1]) {
        return {
            isValid: false,
            errorMessage: `❌ Invalid date: ${month}/${day}. This month only has ${daysInMonth[month - 1]} days.`,
        };
    }
    return { isValid: true };
}

/**
 * Format birthday for display
 */
export function formatBirthday(month: number, day: number, year?: number | null): string {
    const monthNames = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
    ];

    const formattedDate = `${monthNames[month - 1]} ${day}`;
    const ageText = year ? ` (born ${year})` : '';

    return `${formattedDate}${ageText}`;
}

/**
 * Calculate age from birth year
 */
export function calculateAge(birthYear: number): number {
    const currentYear = new Date().getFullYear();
    return currentYear - birthYear;
}
