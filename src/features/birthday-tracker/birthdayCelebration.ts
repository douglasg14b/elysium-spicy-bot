export type MonthDay = {
    month: number;
    day: number;
};

type DateParts = MonthDay & { year: number; hour: number };

export function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Feb 29 birthdays are observed on Feb 28 in non-leap years.
 */
export function getObservedMonthDayForYear(month: number, day: number, year: number): MonthDay {
    if (month === 2 && day === 29 && !isLeapYear(year)) {
        return { month: 2, day: 28 };
    }

    return { month, day };
}

export function isBirthdayCelebratedOnDate(month: number, day: number, date: Date, timeZone?: string): boolean {
    const dateParts = getDatePartsForTimeZone(date, timeZone);
    const observedDate = getObservedMonthDayForYear(month, day, dateParts.year);

    return observedDate.month === dateParts.month && observedDate.day === dateParts.day;
}

export function getDatePartsForTimeZone(date: Date, timeZone?: string): DateParts {
    if (!timeZone) {
        return {
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate(),
            hour: date.getHours(),
        };
    }

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    });
    const dateParts = formatter.formatToParts(date);
    const yearPart = dateParts.find((part) => part.type === 'year');
    const monthPart = dateParts.find((part) => part.type === 'month');
    const dayPart = dateParts.find((part) => part.type === 'day');
    const hourPart = dateParts.find((part) => part.type === 'hour');

    if (!yearPart || !monthPart || !dayPart || !hourPart) {
        throw new Error(`Failed to compute date parts for timezone "${timeZone}"`);
    }

    return {
        year: Number(yearPart.value),
        month: Number(monthPart.value),
        day: Number(dayPart.value),
        hour: Number(hourPart.value),
    };
}

export function getLocalDateKey(date: Date, timeZone?: string): string {
    const dateParts = getDatePartsForTimeZone(date, timeZone);
    const month = String(dateParts.month).padStart(2, '0');
    const day = String(dateParts.day).padStart(2, '0');
    return `${dateParts.year}-${month}-${day}`;
}

export function isSameLocalDate(left: Date, right: Date, timeZone?: string): boolean {
    return getLocalDateKey(left, timeZone) === getLocalDateKey(right, timeZone);
}
