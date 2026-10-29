import { describe, expect, it } from 'vitest';
import { emojiIdentity, isEmojiKey, qualifyEmoji } from '../src/emoji';

describe('reaction entries (§4.7)', () => {
	it('stores emoji sequences fully qualified', () => {
		// Text-default emoji take U+FE0F.
		expect(qualifyEmoji('❤')).toBe('❤️');
		expect(qualifyEmoji('☺')).toBe('☺️');
		// Keycaps take it before the combining keycap.
		expect(qualifyEmoji('#⃣')).toBe('#️⃣');
		// Each part of a ZWJ sequence that needs it.
		expect(qualifyEmoji('\u{1F3F3}‍\u{1F308}')).toBe('\u{1F3F3}️‍\u{1F308}');
		expect(qualifyEmoji('\u{1F441}‍\u{1F5E8}')).toBe('\u{1F441}️‍\u{1F5E8}️');
		expect(qualifyEmoji('❤‍\u{1F525}')).toBe('❤️‍\u{1F525}');
		// Already qualified, emoji-default, skin tones, and families stay as they are.
		for (const entry of ['❤️', '👍', '👍🏽', '🏳️‍🌈', '👨‍👩‍👧', '☝🏽']) expect(qualifyEmoji(entry)).toBe(entry);
		// What is not an RGI emoji is kept as written.
		for (const entry of ['x', 'hello', '👍👍', ':party:']) expect(qualifyEmoji(entry)).toBe(entry);
	});

	it('compares entries without U+FE0F', () => {
		expect(emojiIdentity('❤️')).toBe(emojiIdentity('❤'));
		expect(emojiIdentity('🏳️‍🌈')).toBe('\u{1F3F3}‍\u{1F308}');
	});

	it('tells custom emoji keys from emoji sequences (ext:emoji)', () => {
		for (const key of [':partyparrot:', ':+1:', ':a_b-c:', ':Ship_It:']) expect(isEmojiKey(key)).toBe(true);
		for (const entry of ['👍', 'partyparrot', ':party parrot:', '::', ':party', ':pärty:', ':a::b:']) expect(isEmojiKey(entry)).toBe(false);
	});
});
