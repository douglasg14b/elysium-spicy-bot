import type { ModelMessage } from 'ai';
import { mapToolResults, sizeOf, withoutResult, type ResultLocation } from './traceNotes';

/**
 * `trace` within `room` characters: as it is when it fits, else with its largest tool results
 * reduced to a note (`withoutResult`) one at a time until it does — the calls, the answer and
 * the smaller results stay. Undefined when even every result as a note is too big.
 */
export function fitTrace(trace: readonly ModelMessage[], room: number): ModelMessage[] | undefined {
    const largestFirst: (ResultLocation & { readonly size: number })[] = [];
    mapToolResults(trace, (part, location) => {
        largestFirst.push({ ...location, size: sizeOf([{ role: 'tool', content: [part] }]) });
        return part;
    });
    largestFirst.sort((left, right) => right.size - left.size);

    let fitted = [...trace];
    for (const noted of [null, ...largestFirst]) {
        if (noted) {
            fitted = mapToolResults(fitted, (part, location) =>
                location.messageIndex === noted.messageIndex && location.partIndex === noted.partIndex ? withoutResult(part) : part
            );
        }
        if (sizeOf(fitted) <= room) return fitted;
    }
    return undefined;
}
