import { describe, expect, it } from 'vitest';
import { zResourceKind } from '@brattybot/web-sdk';
import { RESOURCE_KIND_ORDER } from '../resourceMeta';

/**
 * The panel offers the kinds in an order of its own (a channel first, because it is what
 * an operator declares most), so the list is written by hand rather than read off the
 * generated enum. What it may not do is leave one out: a kind the server adds would simply
 * never be offered, with nothing failing.
 */
describe('RESOURCE_KIND_ORDER', () => {
    it('offers every kind the server declares, each once', () => {
        expect([...RESOURCE_KIND_ORDER].sort()).toEqual([...zResourceKind.options].sort());
    });
});
