import type { JourneyDeclaration } from '../logic/resourceDeclaration';

/**
 * Resource keys the onboarding journey declares.
 *
 * Exported as named constants rather than inline strings because the write-back
 * step resolves them: a typo in a key would produce a node config pointing at
 * nothing, which fails at run time far from the cause.
 */
export const ONBOARDING_RESOURCE_KEYS = {
    arrivalsCategory: 'arrivals-category',
    rulesChannel: 'rules-channel',
    welcomeChannel: 'welcome-channel',
    memberRole: 'member-role',
} as const;

export const ONBOARDING_JOURNEY_KEY = 'onboarding';

/**
 * The onboarding journey: agree to the rules, get the member role, get a welcome.
 *
 * This is the reference declaration and the first real consumer of provisioning. It
 * provisions exactly what `buildOnboardingFlowGraph` needs: a role for
 * `action.assignRole`, and channels for the button trigger to be deployed into.
 *
 * `#rules` is read-only for members on purpose: the agree button is posted there, and
 * a channel anyone can post in turns the rules into a conversation. `#welcome` stays
 * writable — it is where new arrivals say hello, which is the point of it.
 */
export const ONBOARDING_JOURNEY: JourneyDeclaration = {
    journeyKey: ONBOARDING_JOURNEY_KEY,
    name: 'Onboarding',
    description: 'Rules agreement, member role, and a welcome channel for new arrivals.',
    resources: [
        {
            key: ONBOARDING_RESOURCE_KEYS.arrivalsCategory,
            kind: 'category',
            defaultName: 'Arrivals',
            description: 'Holds the channels a new member sees first.',
        },
        {
            key: ONBOARDING_RESOURCE_KEYS.rulesChannel,
            kind: 'textChannel',
            defaultName: 'rules',
            parentKey: ONBOARDING_RESOURCE_KEYS.arrivalsCategory,
            description: 'Where the rules and the agree button live.',
            permissions: [{ audience: 'everyone', access: 'readOnly' }],
        },
        {
            key: ONBOARDING_RESOURCE_KEYS.welcomeChannel,
            kind: 'textChannel',
            defaultName: 'welcome',
            parentKey: ONBOARDING_RESOURCE_KEYS.arrivalsCategory,
            description: 'Where new arrivals land once they have agreed.',
            // No declared permissions: inherits the category's, which is the useful
            // default. Declaring an empty set would clear inheritance instead.
        },
        {
            key: ONBOARDING_RESOURCE_KEYS.memberRole,
            kind: 'role',
            defaultName: 'Member',
            description: 'Granted when a new arrival agrees to the rules.',
        },
    ],
};

/** Every journey this bot knows how to install, by key. */
export const JOURNEYS: ReadonlyMap<string, JourneyDeclaration> = new Map([
    [ONBOARDING_JOURNEY_KEY, ONBOARDING_JOURNEY],
]);
