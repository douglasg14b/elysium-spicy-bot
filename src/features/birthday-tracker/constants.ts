/** Ephemeral hint when guild has not configured `/birthday-config` yet. */
export const BIRTHDAY_ANNOUNCEMENT_CONFIG_WARNING =
    '**Note:** An admin has not set a birthday announcement channel yet. Public birthday shout-outs will not post until someone runs `/birthday-config` and picks a text channel.';

export function buildBirthdayFallbackAnnouncement(displayName: string): string {
    return `Another lap around the sun for ${displayName}? Fine—happy birthday. Try not to make it everyone else's problem. 🎂`;
}
