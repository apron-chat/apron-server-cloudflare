/**
 * Reaction entries (protocol §4.7) and custom emoji keys (extension
 * `ext:emoji`, EXTENSIONS.md).
 */

/** A custom emoji key: `:`, a name of `[A-Za-z0-9_+-]`, and `:`. Case-sensitive. */
export const EMOJI_KEY = /^:[A-Za-z0-9_+-]+:$/;

/** The longest name `/emoji add` takes, so a key stays well within a reaction entry's 64 bytes. */
export const MAX_EMOJI_NAME_CHARS = 32;

const VS16 = "️";
const ZWJ = "‍";

/** One RGI emoji sequence (UTS #51), where the runtime's regular expressions know them. */
const RGI_EMOJI: RegExp | null = (() => {
	try {
		return new RegExp("^\\p{RGI_Emoji}$", "v");
	} catch {
		return null;
	}
})();

/** Whether a reaction entry is a custom emoji key rather than an emoji sequence. */
export function isEmojiKey(entry: string): boolean {
	return EMOJI_KEY.test(entry);
}

/** What two entries that differ only in U+FE0F share (§4.7): the entry without it. */
export function emojiIdentity(entry: string): string {
	return entry.replaceAll(VS16, "");
}

/**
 * An emoji sequence in its fully-qualified form (§4.7, emoji-test.txt),
 * such as ❤ as ❤️ or 🏳‍🌈 as 🏳️‍🌈: each part between zero-width joiners
 * takes U+FE0F after its first code point where that makes it an RGI
 * emoji, and the result is kept when the whole is one. Anything else, such
 * as a sequence newer than the runtime's Unicode data, is kept as written.
 */
export function qualifyEmoji(entry: string): string {
	if (!RGI_EMOJI || RGI_EMOJI.test(entry)) return entry;
	const parts = emojiIdentity(entry).split(ZWJ).map((part) => {
		if (!part || RGI_EMOJI.test(part)) return part;
		const [first, ...rest] = [...part];
		const qualified = first + VS16 + rest.join("");
		return RGI_EMOJI.test(qualified) ? qualified : part;
	});
	const joined = parts.join(ZWJ);
	return RGI_EMOJI.test(joined) ? joined : entry;
}
