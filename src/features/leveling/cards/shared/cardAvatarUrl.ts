import type { User } from 'discord.js';

type AvatarUrlSource = Pick<User, 'displayAvatarURL'>;

/**
 * Discord CDN URL for card renders. Satori only supports PNG/JPEG/GIF — not WebP —
 * so always request a static PNG (same approach as `/level`, which already worked).
 */
export function cardAvatarUrlFromUser(user: AvatarUrlSource, size: 128 | 256 = 256): string {
    return user.displayAvatarURL({ extension: 'png', forceStatic: true, size });
}
