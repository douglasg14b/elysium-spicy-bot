import type { CustomEmoji, EmojiClickData, PickerProps } from 'emoji-picker-react';

/**
 * emoji-picker-react, stood in for at its boundary. The real grid is virtualised: in jsdom,
 * which lays nothing out, it draws its search box and skin tones and no emoji at all, so
 * nothing could be clicked. This draws one button per emoji instead — a few standard ones and
 * every server emoji it is handed — and a click calls `onEmojiClick` with what the real grid
 * sends, shaped field for field as its `EmojiClickData` (and, for a server emoji, as its
 * `emojiClickOutput` builds one: `unified` and `emoji` both the id).
 *
 * Everything else the package exports — the `Categories` and `EmojiStyle` enums the grid's
 * setup reads — is the real thing. Use it from a test file as below; imported inside the factory,
 * because `vi.mock` is hoisted above the file's own imports:
 *
 *     vi.mock('emoji-picker-react', async (importOriginal) => {
 *         const { stubEmojiPickerModule } = await import('<relative path>/stubEmojiPicker');
 *         return stubEmojiPickerModule(await importOriginal<typeof import('emoji-picker-react')>());
 *     });
 */

type PickerModule = typeof import('emoji-picker-react');

/** The standard emoji the stand-in offers, as the real grid's data holds them. */
const STANDARD = [
    { emoji: '🌶️', unified: '1f336-fe0f', names: ['hot pepper', 'chili'] },
    { emoji: '😈', unified: '1f608', names: ['smiling face with horns'] },
] as const;

export function stubEmojiPickerModule(original: PickerModule): PickerModule {
    const neutral = original.SkinTones.NEUTRAL;

    function standardClick(entry: (typeof STANDARD)[number]): EmojiClickData {
        const imageUrl = `https://cdn.jsdelivr.net/npm/emoji-datasource-apple/img/apple/64/${entry.unified}.png`;
        return {
            activeSkinTone: neutral,
            unified: entry.unified,
            unifiedWithoutSkinTone: entry.unified,
            emoji: entry.emoji,
            names: [...entry.names],
            imageUrl,
            getImageUrl: () => imageUrl,
            isCustom: false,
        };
    }

    function customClick(custom: CustomEmoji): EmojiClickData {
        const unified = custom.id.toLowerCase();
        return {
            activeSkinTone: neutral,
            unified,
            unifiedWithoutSkinTone: unified,
            emoji: unified,
            names: custom.names,
            imageUrl: custom.imgUrl,
            getImageUrl: () => custom.imgUrl,
            isCustom: true,
        };
    }

    function StubEmojiPicker({ onEmojiClick, customEmojis = [] }: PickerProps) {
        const choices = [
            ...STANDARD.map((entry) => ({ label: entry.names[0], data: standardClick(entry) })),
            ...customEmojis.map((custom) => ({ label: custom.names[0] ?? custom.id, data: customClick(custom) })),
        ];
        return (
            <div role="grid" aria-label="Emoji grid">
                <input aria-label="Type to search for an emoji" />
                {choices.map((choice) => (
                    <button
                        key={choice.data.unified}
                        type="button"
                        aria-label={choice.label}
                        onClick={(event) => onEmojiClick?.(choice.data, event.nativeEvent)}
                    >
                        {choice.data.isCustom ? '' : choice.data.emoji}
                    </button>
                ))}
            </div>
        );
    }

    return { ...original, default: StubEmojiPicker };
}
