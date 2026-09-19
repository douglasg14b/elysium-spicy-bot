/**
 * Presentation for the three resource kinds, in one table.
 *
 * Same shape and same reasoning as `KIND_STYLES` in `nodeMeta.ts`: a kind's icon,
 * colour and prefix are needed by the add control, by every row, and by anything
 * else that lists a resource, and three copies drift. Keying one table by the kind
 * means adding a fourth kind cannot supply a colour and forget the glyph.
 *
 * Kind is the one field on a declaration that is silent when wrong — picking `role`
 * where a channel was meant produces a valid declaration that installs the wrong
 * object. A badge reading "Role" in the same grey as every other badge does not
 * carry that; a distinct glyph and colour per kind does.
 */

import {
    IconFolder,
    IconHash,
    IconShieldHalfFilled,
    type Icon as TablerIcon,
} from '@tabler/icons-react';
import type { ResourceKind } from '../api/types';

export interface ResourceKindStyle {
    /** Mantine colour key, used for the icon, the badge and the row accent. */
    color: string;
    /** The glyph this kind is recognised by. */
    icon: TablerIcon;
    /** Singular noun as it appears in a badge or a button. */
    label: string;
    /**
     * What Discord itself puts in front of the name — `#` for a channel, `@` for a
     * role, nothing for a category. Shown in inputs so a name reads the way it will
     * once it exists.
     */
    prefix: string;
    /** Placeholder for the name box, in the shape that kind's names usually take. */
    namePlaceholder: string;
}

export const RESOURCE_KIND_STYLES: Record<ResourceKind, ResourceKindStyle> = {
    category: {
        color: 'violet',
        icon: IconFolder,
        label: 'Category',
        prefix: '',
        namePlaceholder: 'e.g. Arrivals',
    },
    textChannel: {
        color: 'blue',
        icon: IconHash,
        label: 'Channel',
        prefix: '#',
        namePlaceholder: 'e.g. questions',
    },
    role: {
        color: 'orange',
        icon: IconShieldHalfFilled,
        label: 'Role',
        prefix: '@',
        namePlaceholder: 'e.g. In Approval',
    },
};

/**
 * The kinds in the order they are offered.
 *
 * Not `RESOURCE_KINDS` from the API mirror: that array's order is the server's
 * vocabulary, and this one is a UI judgement — a channel is what an operator
 * declares most often, so it comes first.
 */
export const RESOURCE_KIND_ORDER: readonly ResourceKind[] = ['textChannel', 'category', 'role'];

/**
 * A declared resource's name with its kind's prefix, e.g. `#questions`.
 *
 * Used wherever a resource is named outside its own row — the permission editor's
 * role references, and the summary on the toolbar button. Reading `#questions`
 * rather than `questions` is what makes a mis-picked kind visible.
 */
export function resourceDisplayName(kind: ResourceKind, name: string): string {
    return `${RESOURCE_KIND_STYLES[kind].prefix}${name}`;
}
