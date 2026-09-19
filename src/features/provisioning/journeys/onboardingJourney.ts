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
 * An **example** journey — one possible arrangement, not a built-in concept.
 *
 * Nothing in the provisioning engine knows this file exists. It is data handed to a
 * registry, exactly as an operator-authored journey would be, and deleting it would
 * leave the engine complete and the feature working with zero journeys. Onboarding is
 * not a product concept here; it is the shape that happened to be useful for proving
 * the engine can express *something*.
 *
 * Kept because it doubles as the reference for what a declaration looks like, and
 * because it provisions what `buildOnboardingFlowGraph` needs — a role for
 * `action.assignRole`, and channels for a button trigger to be deployed into.
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

